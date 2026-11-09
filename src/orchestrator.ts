import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { classifyError, errorMessage, ColdPromptError, redact, redactValue, type ErrorKind } from './errors.js';
import { commitsBetween, repositoryChanged, snapshot } from './git.js';
import { initialState, Store } from './store.js';
import { runVerifiers, type Verifier } from './verification.js';
import type { SupervisorAdapter, SupervisorCallOptions } from './supervisor.js';
import type { WorkerAdapter, WorkerTurnResult } from './worker.js';
import type {
  BlockKind, Config, Directive, GitSnapshot, HotPrompt, Mission, PendingTurn,
  Review, RuntimeStatus, Session, State, VerificationOutcome, WorkerInput
} from './types.js';

/** Promise-chain mutex: every critical section runs strictly after the previous one. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const next = this.tail.then(fn, fn);
    this.tail = next.then(() => undefined, () => undefined).finally(() => { this.pending -= 1; });
    return next;
  }

  get busy(): boolean { return this.pending > 0; }

  idle(): Promise<void> { return this.tail.then(() => undefined); }
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new ColdPromptError('CANCELLED', 'sleep aborted'));
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new ColdPromptError('CANCELLED', 'sleep aborted')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

export interface OrchestratorOptions {
  config: Config;
  store: Store;
  worker: WorkerAdapter;
  supervisor: SupervisorAdapter;
  /** Absolute path of the target repository. */
  workingDirectory: string;
  verifiers?: Verifier[];
  /** Dry-run only: no human approval at mission or session transitions. */
  autoApproveTransitions?: boolean;
  sleep?: Sleep;
  now?: () => number;
  log?: (message: string) => void;
}

export interface CommandRequest {
  command: string;
  text?: string;
  raw?: boolean;
}

export interface CommandResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface OrchestratorEvent {
  type: string;
  data: unknown;
  /** ISO timestamp (also recorded in events.jsonl). */
  at?: string;
}

export const HELP_TEXT = `Commands:
  status                 Show runtime status
  ask <question>         HOT_PROMPT QUESTION to the supervisor (never changes the worker)
  tell <directive>       HOT_PROMPT DIRECTIVE: the supervisor prepares a worker instruction (needs approve)
  tell --raw <text>      Your own directive, approved verbatim, delivered at the next turn boundary
  approve <directive-id> Approve a proposed directive
  approve mission        Approve a pending mission transition (or accept a blocked read-only mission)
  reject <directive-id>  Reject a proposed directive
  directives             List directives
  pause                  Pause at the next safe boundary
  resume <resolution>    RESOLUTION: resume a BLOCKED/FAILED run (resolution required) or a PAUSED run
  stop                   Stop gracefully after the current turn
  help                   This help`;

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Size budget for the previous-session reports included by `handoff: previous`. */
export const HANDOFF_MAX_CHARS = 40_000;

export function coldPromptText(mission: Mission): string {
  return [
    `# Mission ${mission.id}: ${mission.title}`,
    '',
    mission.prompt.content.trim(),
    '',
    '## Completion criteria',
    ...(mission.completionCriteria.length ? mission.completionCriteria.map((c) => `- ${c}`) : ['- (none declared)']),
    '',
    mission.execution.readOnly ? 'This mission is READ-ONLY: do not modify, create or delete files, and do not commit.' : '',
    'At the end of each turn, report concrete evidence (commands run and their results, files changed, commits).',
    'Saying the mission is done is not sufficient: completion is verified independently.'
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

export function composeWorkerPrompt(base: WorkerInput, directives: Directive[], resolution?: string): string {
  const parts: string[] = [];
  if (resolution) parts.push(`## Human RESOLUTION\n${resolution}`);
  if (directives.length) parts.push(`## Approved human directives\n${directives.map((d) => `- ${d.content}`).join('\n')}`);
  parts.push(base.text);
  return parts.join('\n\n');
}

class TurnAborted extends Error {}

export class Orchestrator {
  readonly events = new EventEmitter();
  private state: State = initialState();
  private readonly stateLock = new SerialQueue();
  private readonly supervisorLock = new SerialQueue();
  private readonly commandLock = new SerialQueue();
  private readonly stopController = new AbortController();
  private turnController?: AbortController;
  private supervisorController = new AbortController();
  private waiter?: () => void;
  private workerBinding?: string;
  private questionPump?: Promise<void>;
  private pumping = false;
  private runStart = 0;
  private runTurns = 0;
  private waitedMs = 0;
  private running = false;
  /** Set once the worker and supervisor models answered during this run. */
  private providersChecked = false;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly verifiers: Verifier[];

  constructor(private readonly options: OrchestratorOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.verifiers = options.verifiers ?? [];
    this.events.setMaxListeners(100);
  }

  get config(): Config { return this.options.config; }
  get store(): Store { return this.options.store; }
  get snapshotState(): State { return structuredClone(this.state); }
  get stopping(): boolean { return this.stopController.signal.aborted; }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Loads state, takes exclusive ownership and performs deterministic recovery. */
  async open(): Promise<void> {
    await this.store.acquireLock();
    try {
      this.state = await this.store.load();
      this.checkConfigMatchesState();
      this.checkProvidersMatchState();
      await this.adoptLegacyThread();
      if (this.state.supervisorSessionId) {
        await this.options.supervisor.resumeSession(this.state.supervisorSessionId, this.state.supervisorSessionStarted);
      }
      await this.recover();
      if (this.state.status === 'BLOCKED' && this.state.blocked?.kind === 'PROVIDER_CHECK') {
        // The check runs again on this start, with the configuration as it is now.
        await this.mutate((s) => { s.status = 'RUNNING'; s.blocked = undefined; s.blockedReason = undefined; });
      }
    } catch (error) {
      await this.store.releaseLock();
      throw error;
    }
  }

  /** A pre-session state had one shared thread: it belongs to the current session. */
  private async adoptLegacyThread(): Promise<void> {
    const legacy = this.state.legacyWorkerThreadId;
    if (!legacy) return;
    const session = (this.currentMission() ?? this.config.missions[0]).session;
    await this.mutate((s) => {
      if (!s.sessions[session]?.workerThreadId) s.sessions[session] = { ...(s.sessions[session] ?? {}), workerThreadId: legacy };
      s.legacyWorkerThreadId = undefined;
    });
    this.log(`state upgraded: worker thread ${legacy} assigned to session ${session}`);
  }

  /**
   * A thread id only means something to the provider that created it: refuse
   * to hand a Codex thread to Claude (or the reverse) after a provider change.
   * Ids recorded before providers were tracked are not checked.
   */
  private checkProvidersMatchState(): void {
    const s = this.state;
    const worker = this.options.worker.provider;
    const supervisor = this.options.supervisor.provider;
    const problems: string[] = [];
    for (const [id, session] of Object.entries(s.sessions)) {
      // Completed sessions are never resumed: the next session may use another provider.
      if (session.workerThreadId && !session.completedAt && session.workerProvider && session.workerProvider !== worker) {
        problems.push(`session "${id}" has a ${session.workerProvider} worker thread (${session.workerThreadId}) but the worker is now ${worker}`);
      }
    }
    if (s.supervisorSessionId && s.supervisorProvider && s.supervisorProvider !== supervisor) {
      problems.push(`the supervisor conversation ${s.supervisorSessionId} belongs to ${s.supervisorProvider} but the supervisor is now ${supervisor}`);
    }
    if (problems.length) {
      throw new ColdPromptError('INVALID_CONFIG', `Provider changed under persisted state:\n  - ${problems.join('\n  - ')}\nSwitch the provider back, or start a fresh state (move the state directory away).`);
    }
  }

  /** Refuses to continue when the mission list changed under persisted progress. */
  private checkConfigMatchesState(): void {
    const s = this.state;
    const ids = this.config.missions.map((m) => m.id);
    const problems: string[] = [];
    if (s.activeMissionId && ids[s.missionIndex] !== s.activeMissionId) {
      problems.push(`active mission "${s.activeMissionId}" is no longer at position ${s.missionIndex + 1}`);
    }
    if (s.pendingTurn && !ids.includes(s.pendingTurn.missionId)) problems.push(`pending turn belongs to unknown mission "${s.pendingTurn.missionId}"`);
    ids.slice(0, s.missionIndex).forEach((id) => {
      if (s.missions[id] && s.missions[id].status !== 'COMPLETED') problems.push(`mission "${id}" is before the current index but not completed`);
    });
    for (const [id, progress] of Object.entries(s.missions)) {
      if (progress.status === 'COMPLETED' && ids.indexOf(id) >= s.missionIndex) problems.push(`completed mission "${id}" is now at or after the current index`);
      const now = this.config.missions.find((m) => m.id === id)?.session;
      if (progress.session && now && progress.session !== now) problems.push(`mission "${id}" moved from session "${progress.session}" to "${now}"`);
    }
    if (problems.length) {
      throw new ColdPromptError('INVALID_CONFIG', `The mission list no longer matches the persisted state (${this.store.statePath}):\n  - ${problems.join('\n  - ')}\nRestore the previous mission order, or use a new COLDPROMPT_HOME.`);
    }
  }

  async run(): Promise<State> {
    if (this.running) throw new Error('Orchestrator already running');
    this.running = true;
    this.runStart = this.now();
    this.runTurns = 0;
    try {
      await this.mutate((s) => {
        s.runStartedAt = new Date(this.runStart).toISOString();
        if (s.status === 'IDLE' || s.status === 'STOPPED') s.status = 'RUNNING';
        // Missions appended to the config after a completed run.
        if (s.status === 'COMPLETED' && s.missionIndex < this.config.missions.length) s.status = 'RUNNING';
      });
      await this.emit('run.started', { status: this.state.status, missionIndex: this.state.missionIndex });
      this.kickHotPrompts();
      while (!this.stopping) {
        const status = this.state.status;
        if (status === 'COMPLETED') break;
        if (status === 'BLOCKED' || status === 'FAILED' || status === 'PAUSED') {
          const waitStart = this.now();
          await this.waitForChange();
          this.waitedMs += this.now() - waitStart; // time waiting for a human does not count toward maxHours
          continue;
        }
        if (this.state.pauseRequested && !this.state.pendingTurn) {
          await this.mutate((s) => { s.status = 'PAUSED'; s.pauseRequested = false; });
          await this.emit('runtime.paused', {});
          continue;
        }
        if (!this.providersChecked && !this.state.pendingTurn) {
          await this.checkProviders();
          continue;
        }
        await this.step();
      }
      if (this.stopping) {
        await this.mutate((s) => {
          if (s.status === 'RUNNING' || s.status === 'IDLE') s.status = 'STOPPED';
        });
      }
      // Let in-flight supervisor conversations finish so supervisor state stays consistent.
      await this.questionPump;
      await this.supervisorLock.idle();
      await this.emit('run.finished', { status: this.state.status });
      return this.snapshotState;
    } finally {
      this.running = false;
    }
  }

  async close(): Promise<void> {
    await this.stateLock.idle();
    await this.store.releaseLock();
  }

  /**
   * Before the first worker turn of a run: one cheap call per role proving
   * that the configured models answer, so an unusable model blocks the run
   * at once with the provider's message instead of failing mid-mission.
   * Capacity errors do not block (turns have their own retries).
   */
  private async checkProviders(): Promise<void> {
    const roles = [
      { role: 'worker', adapter: this.options.worker, model: this.config.worker.model },
      { role: 'supervisor', adapter: this.options.supervisor, model: this.config.supervisor.model }
    ] as const;
    const checked: Record<string, { provider: string; model: string | null }> = {};
    for (const { role, adapter, model } of roles) {
      if (!adapter.probe) continue;
      try {
        const found = await adapter.probe(this.options.workingDirectory, this.stopController.signal);
        checked[role] = { provider: adapter.provider, model: found.model ?? model ?? null };
        this.log(`${role} ${adapter.provider}: model ${found.model ?? model ?? '(provider default)'} answers`);
      } catch (error) {
        if (this.stopping) return;
        const message = redact(errorMessage(error));
        if (classifyError(error) === 'TRANSIENT_CAPACITY') {
          this.log(`${role} ${adapter.provider}: model check skipped (${message})`);
          continue;
        }
        return this.enterBlocked('PROVIDER_CHECK',
          `The ${role} (${adapter.provider}${model ? `, model "${model}"` : ', default model'}) cannot be used: ${message}\n`
          + `Fix ${role}.model (or the ${adapter.provider} installation) in the configuration, then restart the run. `
          + '"resume <text>" only retries the check with the current configuration.');
      }
    }
    this.providersChecked = true;
    await this.emit('providers.checked', checked);
  }

  /** Graceful stop: the active turn completes and is persisted first. */
  requestStop(reason = 'stop requested'): void {
    if (!this.stopping) {
      void this.store.event('runtime.stop_requested', { reason }).catch(() => undefined);
      this.stopController.abort();
    }
    this.wake();
  }

  /** Forced stop: aborts the active worker turn (outcome becomes ambiguous). */
  async abortActiveTurn(): Promise<void> {
    this.requestStop('forced');
    this.turnController?.abort();
    this.supervisorController.abort();
    await this.options.worker.cancel().catch(() => undefined);
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  private waitForChange(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  private mutate<T>(fn: (state: State) => T): Promise<T> {
    return this.stateLock.run(async () => {
      const draft = structuredClone(this.state);
      const value = fn(draft);
      await this.store.save(draft);
      this.state = draft;
      return value;
    });
  }

  private async emit(type: string, data: unknown): Promise<void> {
    await this.store.event(type, data);
    this.events.emit('event', { type, data: redactValue(data), at: new Date().toISOString() } satisfies OrchestratorEvent);
  }

  private log(message: string): void {
    this.options.log?.(redact(message));
  }

  private currentMission(): Mission | undefined {
    return this.config.missions[this.state.missionIndex];
  }

  private sessionOf(mission: Mission): Session {
    return this.config.sessions.find((x) => x.id === mission.session)!;
  }

  /** True when `mission` is the first mission of its session. */
  private opensSession(mission: Mission): boolean {
    return this.sessionOf(mission).missions[0].id === mission.id;
  }

  private static block(s: State, kind: BlockKind, reason: string, turnId?: string, status: RuntimeStatus = 'BLOCKED'): void {
    s.status = status;
    s.blocked = { kind, reason, at: new Date().toISOString(), turnId };
  }

  private async enterBlocked(kind: BlockKind, reason: string, turnId?: string, status: RuntimeStatus = 'BLOCKED', extra?: (s: State) => void): Promise<void> {
    await this.mutate((s) => { Orchestrator.block(s, kind, reason, turnId, status); extra?.(s); });
    this.log(`${status} (${kind}): ${reason}`);
    await this.emit(status === 'FAILED' ? 'runtime.failed' : 'runtime.blocked', { kind, reason, turnId });
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  private async recover(): Promise<void> {
    const pending = this.state.pendingTurn;
    const requeued: string[] = [];
    let ambiguous: PendingTurn | undefined;
    let current: GitSnapshot | undefined;
    if (pending?.phase === 'WORKER_RUNNING') {
      ambiguous = pending;
      current = await snapshot(this.options.workingDirectory);
      await this.store.writeArtifact(`${pending.turnId}.abandoned`, { pending, gitAtRecovery: current });
    }
    await this.mutate((s) => {
      for (const hp of s.hotPrompts) {
        if (hp.status === 'PROCESSING') { hp.status = 'QUEUED'; requeued.push(hp.id); }
      }
      if (ambiguous) {
        // Never re-run an interrupted turn automatically: it may have partially executed.
        for (const d of s.directives) {
          if (d.deliveredInTurn === ambiguous.turnId && d.status === 'APPROVED') d.deliveredInTurn = undefined;
        }
        if (ambiguous.resolution && !s.pendingResolution) s.pendingResolution = ambiguous.resolution;
        s.pendingTurn = undefined;
        const changed = current && repositoryChanged(ambiguous.gitBefore, current);
        Orchestrator.block(s, 'AMBIGUOUS_TURN',
          `Worker turn ${ambiguous.turnId} (mission ${ambiguous.missionId}) was interrupted; its outcome is unknown. `
          + `Repository ${changed ? 'CHANGED' : 'unchanged'} since the turn started (HEAD ${ambiguous.gitBefore.head ?? '?'} -> ${current?.head ?? '?'}). `
          + 'Inspect the worker thread and repository, then resume with a resolution.',
          ambiguous.turnId);
      }
    });
    if (requeued.length) await this.emit('recovery.hot_prompts_requeued', { ids: requeued });
    if (ambiguous) await this.emit('recovery.ambiguous_turn', { turnId: ambiguous.turnId });
    if (pending && !ambiguous) await this.emit('recovery.turn_continued', { turnId: pending.turnId, phase: pending.phase });
  }

  // -------------------------------------------------------------------------
  // Main step
  // -------------------------------------------------------------------------

  private async step(): Promise<void> {
    const pending = this.state.pendingTurn;
    if (pending?.phase === 'WORKER_DONE') return this.reviewPending();
    if (pending?.phase === 'REVIEWED') return this.applyPending();

    const mission = this.currentMission();
    if (!mission) {
      await this.mutate((s) => { s.status = 'COMPLETED'; s.activeMissionId = undefined; });
      await this.emit('runtime.completed', { totalTurns: this.state.totalTurns });
      return;
    }

    // Limits are checked between turns only.
    const elapsedHours = (this.now() - this.runStart - this.waitedMs) / 3_600_000;
    if (this.runTurns >= this.config.runtime.maxTurns || elapsedHours >= this.config.runtime.maxHours) {
      const reason = this.runTurns >= this.config.runtime.maxTurns
        ? `maxTurns (${this.config.runtime.maxTurns}) reached` : `maxHours (${this.config.runtime.maxHours}) reached`;
      await this.mutate((s) => { s.lastError = { kind: 'LIMIT', message: reason, at: new Date().toISOString() }; });
      await this.emit('runtime.limit_reached', { reason });
      this.log(reason);
      this.requestStop(reason);
      return;
    }

    await this.ensureMissionStarted(mission);
    if (mission.execution.maxTurns && this.state.missionTurns >= mission.execution.maxTurns) {
      return this.enterBlocked('MISSION_LIMIT', `Mission ${mission.id} reached its maxTurns (${mission.execution.maxTurns}).`);
    }

    const gitBefore = await snapshot(this.options.workingDirectory);
    if (gitBefore.operationInProgress) {
      return this.enterBlocked('UNSAFE_REPOSITORY', `A git ${gitBefore.operationInProgress} is in progress in ${this.options.workingDirectory}.`);
    }

    await this.bindWorker(mission);
    const turnId = `t${String(this.state.totalTurns + 1).padStart(4, '0')}-${randomUUID().slice(0, 6)}`;
    const directives = this.state.directives.filter((d) => d.status === 'APPROVED');
    const base = this.state.nextWorkerInput ?? { source: 'SUPERVISOR' as const, text: 'Continue the mission. Report concrete evidence of progress.' };
    const resolution = this.state.pendingResolution;
    const prompt = composeWorkerPrompt(base, directives, resolution);

    await this.mutate((s) => {
      s.pendingTurn = {
        turnId, missionId: mission.id, missionTurn: s.missionTurns + 1, phase: 'WORKER_RUNNING',
        prompt, inputSource: resolution ? 'RESOLUTION' : base.source,
        deliveredDirectiveIds: directives.map((d) => d.id), resolution,
        startedAt: new Date().toISOString(), gitBefore
      };
      for (const d of s.directives) if (directives.some((x) => x.id === d.id)) d.deliveredInTurn = turnId;
    });
    await this.emit('turn.started', { turnId, missionId: mission.id, source: base.source, directives: directives.map((d) => d.id) });

    let result: WorkerTurnResult | undefined;
    try {
      result = await this.executeWithRetry(mission, prompt, turnId);
    } catch (error) {
      if (error instanceof TurnAborted) return; // pending turn stays WORKER_RUNNING -> ambiguous on restart
      throw error;
    }
    if (!result) return;

    const gitAfter = await snapshot(this.options.workingDirectory);
    const commits = await commitsBetween(this.options.workingDirectory, gitBefore.head, gitAfter.head);
    const resultRef = await this.store.writeArtifact(`${turnId}.worker`, { turnId, missionId: mission.id, prompt, result, gitBefore, gitAfter, commits });
    const verification = await runVerifiers(this.verifiers, { workingDirectory: this.options.workingDirectory, mission, phase: 'turn' }, { gitClean: false });
    if (verification.length) await this.store.writeArtifact(`${turnId}.verification`, verification);

    this.runTurns += 1;
    await this.mutate((s) => {
      const p = s.pendingTurn!;
      Object.assign(p, { phase: 'WORKER_DONE', gitAfter, commits, resultRef, verification });
      this.storeWorkerSession(s, mission, result!.sessionId);
      s.missionTurns += 1;
      s.totalTurns += 1;
      s.missions[mission.id].turns += 1;
      s.missions[mission.id].resultRefs = [...(s.missions[mission.id].resultRefs ?? []), resultRef];
      s.lastWorkerResult = result!.finalResponse;
      s.lastResultRef = resultRef;
      s.lastGit = gitAfter;
      s.retry = undefined;
      s.nextWorkerInput = undefined;
      s.pendingResolution = undefined;
      const now = new Date().toISOString();
      for (const d of s.directives) {
        if (p.deliveredDirectiveIds.includes(d.id)) { d.status = 'DELIVERED'; d.deliveredAt = now; }
      }
    });
    await this.emit('turn.completed', { turnId, missionId: mission.id, resultRef, commits, head: gitAfter.head, dirty: gitAfter.dirty, verification: verification.map((v) => ({ name: v.name, passed: v.passed })) });
    if (this.state.totalTurns % this.config.runtime.statusEvery === 0) {
      this.log(`status: mission ${mission.id} turn ${this.state.missionTurns}, total ${this.state.totalTurns}`);
      await this.emit('runtime.status', this.statusSummary());
    }

    if (mission.execution.readOnly && repositoryChanged(gitBefore, gitAfter)) {
      // Persisted as WORKER_DONE: after resolution the turn is still reviewed.
      return this.enterBlocked('READ_ONLY_VIOLATION', `Read-only mission ${mission.id} changed the repository (HEAD ${gitBefore.head} -> ${gitAfter.head}, changed files ${gitBefore.changedFiles} -> ${gitAfter.changedFiles}).`, turnId);
    }
    await this.reviewPending();
  }

  private async ensureMissionStarted(mission: Mission): Promise<void> {
    if (this.state.activeMissionId === mission.id) return;
    const session = this.sessionOf(mission);
    const handoff = this.opensSession(mission) && session.handoff === 'previous' ? await this.handoffText(session) : undefined;
    await this.mutate((s) => {
      const now = new Date().toISOString();
      s.activeMissionId = mission.id;
      s.missionTurns = s.missions[mission.id]?.turns ?? 0;
      s.missions[mission.id] = { ...(s.missions[mission.id] ?? { turns: 0 }), status: 'ACTIVE', session: mission.session, startedAt: now };
      s.sessions[mission.session] = { startedAt: now, ...(s.sessions[mission.session] ?? {}) };
      s.nextWorkerInput = { source: 'COLD_PROMPT', text: handoff ? `${coldPromptText(mission)}\n\n${handoff}` : coldPromptText(mission) };
      s.lastReview = undefined;
    });
    if (this.opensSession(mission)) await this.emit('session.started', { sessionId: session.id, missionId: mission.id });
    this.log(`mission ${mission.id} started (session ${session.id})`);
    await this.emit('mission.started', { missionId: mission.id, sessionId: session.id, index: this.state.missionIndex });
  }

  /**
   * Worker reports of the session before `session`, oldest first, from ColdPrompt's
   * own turn artifacts. Older reports are dropped first beyond HANDOFF_MAX_CHARS.
   */
  private async handoffText(session: Session): Promise<string> {
    const previous = this.config.sessions[this.config.sessions.indexOf(session) - 1];
    const header = `## Handoff from session ${previous?.id ?? '(none)'}\n` +
      'Worker reports of the previous session (another worker thread), provided by ColdPrompt. They are claims to verify, not evidence.';
    const refs = previous ? previous.missions.flatMap((m) => this.state.missions[m.id]?.resultRefs ?? []) : [];
    const reports: string[] = [];
    for (const ref of refs) {
      try {
        const artifact = await this.store.readArtifact<{ turnId: string; result: WorkerTurnResult }>(ref);
        reports.push(`### Turn ${artifact.turnId}\n${artifact.result.finalResponse.trim()}`);
      } catch {
        reports.push(`### ${ref}\n(report unavailable)`);
      }
    }
    if (!reports.length) return `${header}\n\n(No worker report was recorded for that session.)`;
    let kept: string[] = [];
    let size = 0;
    for (const report of reports.reverse()) {
      if (kept.length && size + report.length > HANDOFF_MAX_CHARS) break;
      kept.unshift(report.length > HANDOFF_MAX_CHARS ? `…${report.slice(-HANDOFF_MAX_CHARS)}` : report);
      size += report.length;
    }
    const dropped = reports.length - kept.length;
    return [header, dropped ? `(${dropped} older report(s) omitted for length.)` : '', ...kept].filter(Boolean).join('\n\n');
  }

  /** The worker thread of the mission's session: recorded, else the session's resumeThread, else none (new). */
  private threadFor(mission: Mission): string | undefined {
    return this.state.sessions[mission.session]?.workerThreadId ?? this.sessionOf(mission).resumeThread;
  }

  private storeWorkerSession(s: State, mission: Mission, sessionId: string | undefined): void {
    if (!sessionId) return;
    s.sessions[mission.session] = { ...(s.sessions[mission.session] ?? {}), workerThreadId: sessionId, workerProvider: this.options.worker.provider };
    this.workerBinding = `${sessionId}|${mission.execution.readOnly}`;
  }

  private async bindWorker(mission: Mission): Promise<void> {
    const threadId = this.threadFor(mission);
    const key = `${threadId ?? `new:${mission.session}`}|${mission.execution.readOnly}`;
    if (this.workerBinding === key) return;
    const sessionOptions = { workingDirectory: this.options.workingDirectory, readOnly: mission.execution.readOnly };
    if (threadId) {
      // Not yet recorded: the thread comes from the session file's resumeThread.
      const fromResumeThread = !this.state.sessions[mission.session]?.workerThreadId;
      await this.options.worker.resumeSession(threadId, sessionOptions);
      this.log(fromResumeThread
        ? `session ${mission.session}: resuming EXISTING ${this.options.worker.provider} thread ${threadId} (resumeThread)`
        : `session ${mission.session}: resuming ${this.options.worker.provider} thread ${threadId}`);
      await this.emit('worker.session_resumed', { threadId, sessionId: mission.session, missionId: mission.id, readOnly: mission.execution.readOnly, fromResumeThread });
    } else {
      await this.options.worker.startSession(sessionOptions);
      this.log(`session ${mission.session}: starting a new ${this.options.worker.provider} thread`);
      await this.emit('worker.session_started', { sessionId: mission.session, missionId: mission.id, readOnly: mission.execution.readOnly });
    }
    this.workerBinding = key;
  }

  /** Runs one worker turn with bounded retries. Returns undefined when the run left RUNNING. */
  private async executeWithRetry(mission: Mission, prompt: string, turnId: string): Promise<WorkerTurnResult | undefined> {
    const delays: Record<'TRANSIENT_CAPACITY' | 'SESSION_LOCK', number[]> = {
      TRANSIENT_CAPACITY: this.config.runtime.retryDelaysSeconds,
      SESSION_LOCK: this.config.runtime.sessionLockRetryDelaysSeconds
    };
    const attempts = { TRANSIENT_CAPACITY: 0, SESSION_LOCK: 0 };
    for (;;) {
      this.turnController = new AbortController();
      try {
        return await this.options.worker.executeTurn(prompt, {
          signal: this.turnController.signal,
          onSessionId: async (id) => {
            if (this.threadFor(mission) !== id) await this.mutate((s) => this.storeWorkerSession(s, mission, id));
          },
          onProgress: (progress) => this.emit('worker.progress', { turnId, missionId: mission.id, ...progress })
        });
      } catch (error) {
        const kind = classifyError(error);
        const message = redact(errorMessage(error));
        const sessionId = this.options.worker.getSessionId();
        if (sessionId && this.threadFor(mission) !== sessionId) await this.mutate((s) => this.storeWorkerSession(s, mission, sessionId));
        if (kind === 'CANCELLED' || this.turnController.signal.aborted) {
          await this.emit('turn.aborted', { turnId, message });
          throw new TurnAborted(message);
        }
        if (kind === 'TRANSIENT_CAPACITY' || kind === 'SESSION_LOCK') {
          const attempt = attempts[kind];
          if (attempt < delays[kind].length) {
            const delay = delays[kind][attempt];
            attempts[kind] += 1;
            await this.mutate((s) => { s.retry = { kind, message, attempt: attempt + 1, at: new Date().toISOString() }; });
            await this.emit('turn.retry', { turnId, kind, attempt: attempt + 1, delaySeconds: delay, message });
            this.log(`${kind} on turn ${turnId}; retry ${attempt + 1}/${delays[kind].length} in ${delay}s: ${message}`);
            try {
              await this.sleep(delay * 1000, this.stopController.signal);
              continue;
            } catch {
              await this.failTurn(turnId, 'CANCELLED', 'Stopped while waiting to retry');
              return undefined;
            }
          }
        }
        await this.failTurn(turnId, kind, message, sessionId);
        return undefined;
      } finally {
        this.turnController = undefined;
      }
    }
  }

  /** A turn that definitely did not complete: no counters advance, directives are re-queued. */
  private async failTurn(turnId: string, kind: ErrorKind, message: string, sessionId?: string): Promise<void> {
    await this.store.writeArtifact(`${turnId}.failed`, { turnId, kind, message, pending: this.state.pendingTurn });
    await this.emit('turn.failed', { turnId, kind, message });
    const blockKind: BlockKind = kind === 'TRANSIENT_CAPACITY' ? 'RETRIES_EXHAUSTED' : kind === 'SESSION_LOCK' ? 'SESSION_LOCK' : 'FAILURE';
    const status: RuntimeStatus | undefined = kind === 'CANCELLED' ? undefined : blockKind === 'FAILURE' ? 'FAILED' : 'BLOCKED';
    const reason = kind === 'SESSION_LOCK'
      ? `Worker thread ${sessionId ?? (this.currentMission() && this.threadFor(this.currentMission()!)) ?? '?'} still has an active writer after ${this.config.runtime.sessionLockRetryDelaysSeconds.length} retries. Another process may be using it; ColdPrompt will not kill it. Close the other writer, then resume. Last error: ${message}`
      : kind === 'AUTHENTICATION'
        ? `Worker authentication failed: ${message}. Log in again, then resume.`
        : `Worker turn failed (${kind}): ${message}`;
    await this.mutate((s) => {
      for (const d of s.directives) if (d.deliveredInTurn === turnId) d.deliveredInTurn = undefined;
      if (s.pendingTurn?.resolution) s.pendingResolution = s.pendingTurn.resolution;
      s.pendingTurn = undefined;
      s.lastError = { kind, message, at: new Date().toISOString() };
      if (status) Orchestrator.block(s, blockKind, reason, turnId, status);
    });
    if (status) {
      this.log(`${status}: ${reason}`);
      await this.emit(status === 'FAILED' ? 'runtime.failed' : 'runtime.blocked', { kind: blockKind, reason, turnId });
    }
  }

  // -------------------------------------------------------------------------
  // Review and decision
  // -------------------------------------------------------------------------

  private async reviewPending(): Promise<void> {
    const pending = this.state.pendingTurn!;
    const mission = this.config.missions.find((m) => m.id === pending.missionId)!;
    const artifact = await this.store.readArtifact<{ result: WorkerTurnResult }>(pending.resultRef!);
    const deliveredDirectives = this.state.directives.filter((d) => pending.deliveredDirectiveIds.includes(d.id)).map((d) => d.content);
    const rejected = this.state.lastError?.kind === 'COMPLETION_REJECTED' ? this.state.lastError.message : undefined;
    let review: Review;
    try {
      review = await this.supervisorCall('evaluate', (signal) => this.options.supervisor.evaluateTurn({
        mission,
        missionIndex: this.config.missions.indexOf(mission),
        missionCount: this.config.missions.length,
        session: { id: mission.session, index: this.config.sessions.indexOf(this.sessionOf(mission)), count: this.config.sessions.length },
        turnId: pending.turnId,
        missionTurn: pending.missionTurn,
        workerPrompt: pending.prompt,
        workerResult: artifact.result,
        gitBefore: pending.gitBefore,
        gitAfter: pending.gitAfter ?? pending.gitBefore,
        commits: pending.commits ?? [],
        verification: pending.verification ?? [],
        deliveredDirectives,
        resolution: pending.resolution,
        previousCompletionRejected: rejected
      }, { signal }));
    } catch (error) {
      if (this.stopping && classifyError(error) === 'CANCELLED') return; // stays WORKER_DONE, review re-runs on restart
      const kind = classifyError(error);
      const message = redact(errorMessage(error));
      await this.emit('review.failed', { turnId: pending.turnId, kind, message });
      // The worker result stays persisted (WORKER_DONE); resuming re-runs the review only.
      return this.enterBlocked(kind === 'TRANSIENT_CAPACITY' ? 'RETRIES_EXHAUSTED' : 'FAILURE',
        `Supervisor review of turn ${pending.turnId} failed (${kind}): ${message}`, pending.turnId,
        kind === 'TRANSIENT_CAPACITY' ? 'BLOCKED' : 'FAILED',
        (s) => { s.lastError = { kind, message, at: new Date().toISOString() }; });
    }
    const reviewRef = await this.store.writeArtifact(`${pending.turnId}.review`, review);
    await this.mutate((s) => {
      Object.assign(s.pendingTurn!, { phase: 'REVIEWED', reviewRef });
      s.lastReview = review;
      s.lastDecision = review.decision;
      s.lastReviewRef = reviewRef;
    });
    await this.emit('review.completed', { turnId: pending.turnId, decision: review.decision, reason: review.reason, reviewRef });
    this.log(`review ${pending.turnId}: ${review.decision} — ${review.reason}`);
    await this.applyPending();
  }

  private async applyPending(): Promise<void> {
    const pending = this.state.pendingTurn!;
    const review = this.state.lastReview ?? await this.store.readArtifact<Review>(pending.reviewRef!);
    const mission = this.config.missions.find((m) => m.id === pending.missionId)!;
    const clearRejection = (s: State) => { if (s.lastError?.kind === 'COMPLETION_REJECTED') s.lastError = undefined; };
    switch (review.decision) {
      case 'CONTINUE':
      case 'CLARIFY':
        await this.mutate((s) => {
          s.pendingTurn = undefined;
          s.nextWorkerInput = { source: 'SUPERVISOR', text: review.workerInstruction.trim() || 'Continue the mission. Report concrete evidence of progress.' };
          clearRejection(s);
        });
        return;
      case 'BLOCKED':
        return this.enterBlocked('SUPERVISOR', review.reason, pending.turnId, 'BLOCKED', (s) => {
          s.pendingTurn = undefined;
          s.nextWorkerInput = review.workerInstruction.trim()
            ? { source: 'SUPERVISOR', text: review.workerInstruction.trim() }
            : { source: 'SUPERVISOR', text: 'Continue the mission taking the human resolution into account.' };
        });
      case 'STOP':
        return this.enterBlocked('FAILURE', `Supervisor STOP: ${review.reason}`, pending.turnId, 'FAILED', (s) => {
          s.pendingTurn = undefined;
          s.nextWorkerInput = { source: 'SUPERVISOR', text: review.workerInstruction.trim() || 'Continue the mission taking the human resolution into account.' };
        });
      case 'MISSION_COMPLETE':
        return this.verifyCompletion(mission, pending, review);
    }
  }

  private async verifyCompletion(mission: Mission, pending: PendingTurn, review: Review): Promise<void> {
    const outcomes: VerificationOutcome[] = await runVerifiers(
      this.verifiers,
      { workingDirectory: this.options.workingDirectory, mission, phase: 'completion' },
      { gitClean: this.config.runtime.verifyGitCleanOnCompletion }
    );
    await this.store.writeArtifact(`${pending.turnId}.completion`, { review, outcomes });
    const failed = outcomes.filter((o) => !o.passed);
    await this.emit('mission.verification', { missionId: mission.id, turnId: pending.turnId, outcomes: outcomes.map((o) => ({ name: o.name, passed: o.passed })) });
    if (failed.length) {
      const summary = failed.map((o) => `- ${o.name} FAILED:\n${o.output}`).join('\n');
      if (mission.execution.readOnly) {
        // A read-only worker is not allowed to fix anything: asking it to would loop.
        await this.emit('mission.completion_rejected', { missionId: mission.id, failed: failed.map((f) => f.name) });
        return this.enterBlocked('VERIFICATION_FAILED',
          `Read-only mission ${mission.id} was judged complete, but completion checks failed and the worker is not allowed to change the repository:\n${summary}\n` +
          `Resolve with "resume <instruction>" (after changing the mission's verification list if the failure is expected), or "approve mission" to accept it as complete.`,
          pending.turnId, 'BLOCKED', (s) => {
            s.pendingTurn = undefined;
            s.lastError = { kind: 'COMPLETION_REJECTED', message: summary, at: new Date().toISOString() };
          });
      }
      await this.mutate((s) => {
        s.pendingTurn = undefined;
        s.nextWorkerInput = {
          source: 'VERIFICATION',
          text: `The supervisor considered the mission complete, but deterministic verification failed:\n${summary}\n\nFix these issues and report evidence.`
        };
        s.lastError = { kind: 'COMPLETION_REJECTED', message: summary, at: new Date().toISOString() };
      });
      this.log(`MISSION_COMPLETE for ${mission.id} rejected by verification (${failed.map((f) => f.name).join(', ')})`);
      await this.emit('mission.completion_rejected', { missionId: mission.id, failed: failed.map((f) => f.name) });
      return;
    }
    const next = this.config.missions[this.config.missions.indexOf(mission) + 1];
    const endsSession = next !== undefined && next.session !== mission.session;
    // A human approves every mission end, unless autoApproveMissions (or the
    // mission's own requireHumanApproval) says otherwise. Dry-runs never wait.
    const needsApproval = !this.options.autoApproveTransitions
      && (mission.requireHumanApproval ?? !this.config.runtime.autoApproveMissions);
    if (needsApproval) {
      return this.enterBlocked('MISSION_APPROVAL',
        endsSession
          ? `Mission ${mission.id} passed verification; it ends session ${mission.session}. Human approval required: "approve mission" to start session ${next.session} on a new worker thread, or "resume <instruction>" to keep working on ${mission.id}.`
          : `Mission ${mission.id} passed verification. Human approval required: "approve mission" to advance, or "resume <instruction>" to keep working on it.`,
        pending.turnId, 'BLOCKED', (s) => { s.pendingTurn = undefined; });
    }
    if (!this.options.autoApproveTransitions) {
      this.log(`mission ${mission.id} approved automatically (no human approval required)${endsSession ? `; session ${next.session} starts on a new worker thread` : ''}`);
      await this.emit('mission.auto_approved', { missionId: mission.id, sessionId: mission.session, nextSessionId: endsSession ? next.session : undefined });
    }
    await this.completeMission(mission, (s) => { s.pendingTurn = undefined; });
  }

  private async completeMission(mission: Mission, extra?: (s: State) => void): Promise<void> {
    await this.mutate((s) => {
      extra?.(s);
      s.missions[mission.id] = { ...s.missions[mission.id], status: 'COMPLETED', completedAt: new Date().toISOString() };
      s.missionIndex = this.config.missions.indexOf(mission) + 1;
      s.missionTurns = 0;
      s.activeMissionId = undefined;
      s.nextWorkerInput = undefined;
      s.lastReview = undefined;
      if (s.lastError?.kind === 'COMPLETION_REJECTED') s.lastError = undefined;
      if (s.missionIndex >= this.config.missions.length) s.status = 'COMPLETED';
      if (this.config.missions[s.missionIndex]?.session !== mission.session) {
        s.sessions[mission.session] = { ...(s.sessions[mission.session] ?? {}), completedAt: new Date().toISOString() };
      }
    });
    this.log(`mission ${mission.id} completed`);
    await this.emit('mission.completed', { missionId: mission.id, sessionId: mission.session });
    if (this.state.sessions[mission.session]?.completedAt) await this.emit('session.completed', { sessionId: mission.session });
    if (this.state.status === 'COMPLETED') await this.emit('runtime.completed', { totalTurns: this.state.totalTurns });
  }

  // -------------------------------------------------------------------------
  // Supervisor access (single writer)
  // -------------------------------------------------------------------------

  private supervisorCall<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.supervisorLock.run(async () => {
      const delays = this.config.runtime.retryDelaysSeconds;
      for (let attempt = 0; ; attempt += 1) {
        if (this.supervisorController.signal.aborted) this.supervisorController = new AbortController();
        try {
          const value = await fn(this.supervisorController.signal);
          await this.persistSupervisorSession();
          return value;
        } catch (error) {
          await this.persistSupervisorSession();
          const kind = classifyError(error);
          if (kind !== 'TRANSIENT_CAPACITY' || attempt >= delays.length) throw error;
          const message = redact(errorMessage(error));
          await this.emit('supervisor.retry', { label, attempt: attempt + 1, delaySeconds: delays[attempt], message });
          await this.sleep(delays[attempt] * 1000, this.stopController.signal);
        }
      }
    });
  }

  private async persistSupervisorSession(): Promise<void> {
    const id = this.options.supervisor.getSessionId();
    const started = this.options.supervisor.isSessionStarted();
    if (id !== this.state.supervisorSessionId || started !== this.state.supervisorSessionStarted) {
      await this.mutate((s) => { s.supervisorSessionId = id; s.supervisorSessionStarted = started; s.supervisorProvider = id ? this.options.supervisor.provider : undefined; });
    }
  }

  // -------------------------------------------------------------------------
  // HOT_PROMPT processing
  // -------------------------------------------------------------------------

  private kickHotPrompts(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.questionPump = (async () => {
      try {
        while (!this.stopping) {
          const next = this.state.hotPrompts.find((h) => h.status === 'QUEUED' && (h.intent === 'QUESTION' || h.intent === 'DIRECTIVE'));
          if (!next) break;
          await this.processHotPrompt(next.id);
        }
      } finally {
        this.pumping = false;
      }
      if (!this.stopping && this.state.hotPrompts.some((h) => h.status === 'QUEUED' && h.intent !== 'RESOLUTION')) this.kickHotPrompts();
    })();
  }

  private async processHotPrompt(id: string): Promise<void> {
    const hp = this.state.hotPrompts.find((h) => h.id === id)!;
    await this.mutate((s) => { s.hotPrompts.find((h) => h.id === id)!.status = 'PROCESSING'; });
    try {
      const result = await this.supervisorCall('interact', (signal) => this.options.supervisor.interact({
        intent: hp.intent as 'QUESTION' | 'DIRECTIVE',
        content: hp.content,
        status: this.state.status,
        missionId: this.state.activeMissionId,
        blockedReason: this.state.blocked?.reason,
        lastReview: this.state.lastReview,
        lastWorkerResult: this.state.lastWorkerResult
      }, { signal } satisfies SupervisorCallOptions));
      let directiveId: string | undefined;
      await this.mutate((s) => {
        const target = s.hotPrompts.find((h) => h.id === id)!;
        target.status = 'ANSWERED';
        target.answer = result.answer;
        target.answeredAt = new Date().toISOString();
        if (result.proposedDirective?.trim()) {
          directiveId = shortId('d');
          s.directives.push({
            id: directiveId, author: 'SUPERVISOR', content: result.proposedDirective.trim(),
            sourceHotPromptId: id, status: 'PROPOSED', createdAt: new Date().toISOString()
          });
          target.directiveId = directiveId;
        }
      });
      await this.emit('hot_prompt.answered', { id, intent: hp.intent, answer: result.answer, proposedDirectiveId: directiveId, proposedDirective: result.proposedDirective ?? undefined });
    } catch (error) {
      const message = redact(errorMessage(error));
      if (this.stopping && classifyError(error) === 'CANCELLED') {
        await this.mutate((s) => { s.hotPrompts.find((h) => h.id === id)!.status = 'QUEUED'; });
        return;
      }
      await this.mutate((s) => {
        const target = s.hotPrompts.find((h) => h.id === id)!;
        target.status = 'FAILED';
        target.error = message;
      });
      await this.emit('hot_prompt.failed', { id, message });
    }
  }

  // -------------------------------------------------------------------------
  // Commands (console). All state changes are serialized through stateLock.
  // -------------------------------------------------------------------------

  statusSummary(): Record<string, unknown> {
    const s = this.state;
    const mission = this.config.missions[s.missionIndex];
    return {
      status: s.status,
      project: this.config.project.name,
      providers: { worker: this.options.worker.provider, supervisor: this.options.supervisor.provider },
      session: mission ? (() => {
        const session = this.sessionOf(mission);
        return { id: session.id, title: session.title ?? null, index: this.config.sessions.indexOf(session) + 1, of: this.config.sessions.length };
      })() : null,
      mission: mission ? (() => {
        const missions = this.sessionOf(mission).missions;
        const inSession = missions.findIndex((m) => m.id === mission.id) + 1;
        return { id: mission.id, title: mission.title, index: s.missionIndex + 1, of: this.config.missions.length, inSession, ofSession: missions.length };
      })() : null,
      // The whole plan with each mission's progress (web console checklist).
      plan: this.config.sessions.map((session, si) => ({
        id: session.id, title: session.title ?? null, index: si + 1,
        missions: session.missions.map((m, mi) => ({ id: m.id, title: m.title, index: mi + 1, status: s.missions[m.id]?.status ?? 'PENDING' }))
      })),
      missionTurns: s.missionTurns,
      totalTurns: s.totalTurns,
      workerThreadId: mission ? this.threadFor(mission) ?? null : null,
      supervisorSessionId: s.supervisorSessionId,
      pendingTurn: s.pendingTurn ? { turnId: s.pendingTurn.turnId, phase: s.pendingTurn.phase } : null,
      pauseRequested: s.pauseRequested,
      stopping: this.stopping,
      blocked: s.blocked ?? null,
      lastDecision: s.lastDecision ?? null,
      lastReason: s.lastReview?.reason ?? null,
      queuedHotPrompts: s.hotPrompts.filter((h) => h.status === 'QUEUED' || h.status === 'PROCESSING').length,
      proposedDirectives: s.directives.filter((d) => d.status === 'PROPOSED').map((d) => ({ id: d.id, content: d.content })),
      approvedDirectives: s.directives.filter((d) => d.status === 'APPROVED').map((d) => ({ id: d.id, content: d.content })),
      retry: s.retry ?? null,
      lastError: s.lastError ?? null,
      git: s.lastGit ?? null
    };
  }

  /** Entry point for every client. Commands run one at a time, in arrival order. */
  async handleCommand(request: CommandRequest): Promise<CommandResponse> {
    try {
      if (request.command === 'status' || request.command === 'help' || request.command === 'directives') return await this.dispatch(request);
      return await this.commandLock.run(() => this.dispatch(request));
    } catch (error) {
      return { ok: false, error: redact(errorMessage(error)) };
    }
  }

  private async newHotPrompt(intent: HotPrompt['intent'], content: string, status: HotPrompt['status']): Promise<HotPrompt> {
    const hp: HotPrompt = { id: shortId('hp'), type: 'HOT_PROMPT', intent, content, createdAt: new Date().toISOString(), status };
    await this.mutate((s) => { s.hotPrompts.push(hp); });
    await this.emit('hot_prompt.received', { id: hp.id, intent, content });
    return hp;
  }

  private async dispatch({ command, text = '', raw = false }: CommandRequest): Promise<CommandResponse> {
    const content = text.trim();
    switch (command) {
      case 'help':
        return { ok: true, data: HELP_TEXT };
      case 'status':
        return { ok: true, data: this.statusSummary() };
      case 'directives':
        return { ok: true, data: this.state.directives };
      case 'ask': {
        if (!content) return { ok: false, error: 'Usage: ask <question>' };
        const hp = await this.newHotPrompt('QUESTION', content, 'QUEUED');
        this.kickHotPrompts();
        return { ok: true, data: { hotPromptId: hp.id, message: 'Question queued for the supervisor.' } };
      }
      case 'tell': {
        if (!content) return { ok: false, error: 'Usage: tell [--raw] <directive>' };
        if (raw) {
          const hp = await this.newHotPrompt('DIRECTIVE', content, 'APPLIED');
          const directive: Directive = {
            id: shortId('d'), author: 'HUMAN', content, sourceHotPromptId: hp.id, status: 'APPROVED',
            createdAt: hp.createdAt, approvedAt: new Date().toISOString()
          };
          await this.mutate((s) => { s.directives.push(directive); s.hotPrompts.find((h) => h.id === hp.id)!.directiveId = directive.id; });
          await this.emit('directive.approved', { id: directive.id, author: 'HUMAN' });
          return { ok: true, data: { directiveId: directive.id, message: 'Directive approved; it will be delivered at the next turn boundary.' } };
        }
        const hp = await this.newHotPrompt('DIRECTIVE', content, 'QUEUED');
        this.kickHotPrompts();
        return { ok: true, data: { hotPromptId: hp.id, message: 'Directive sent to the supervisor for preparation; approve the proposal to deliver it.' } };
      }
      case 'approve': {
        if (content === 'mission') {
          const s = this.state;
          const kind = s.blocked?.kind;
          if (s.status !== 'BLOCKED' || (kind !== 'MISSION_APPROVAL' && kind !== 'VERIFICATION_FAILED')) return { ok: false, error: 'No mission transition awaiting approval.' };
          const mission = this.currentMission()!;
          // VERIFICATION_FAILED: the human accepts the read-only mission despite failing checks.
          await this.newHotPrompt('RESOLUTION', kind === 'VERIFICATION_FAILED' ? `approve mission ${mission.id} despite failed completion checks` : `approve mission ${mission.id}`, 'APPLIED');
          await this.completeMission(mission, (st) => {
            st.blocked = undefined;
            if (st.status === 'BLOCKED') st.status = 'RUNNING';
          });
          this.wake();
          return { ok: true, data: { message: `Mission ${mission.id} approved.` } };
        }
        const directive = this.state.directives.find((d) => d.id === content);
        if (!directive) return { ok: false, error: `Unknown directive "${content}"` };
        if (directive.status !== 'PROPOSED') return { ok: false, error: `Directive ${content} is ${directive.status}, not PROPOSED` };
        await this.mutate((s) => {
          const d = s.directives.find((x) => x.id === content)!;
          d.status = 'APPROVED';
          d.approvedAt = new Date().toISOString();
        });
        await this.emit('directive.approved', { id: content, author: directive.author });
        return { ok: true, data: { directiveId: content, message: 'Directive approved; it will be delivered at the next turn boundary.' } };
      }
      case 'reject': {
        const directive = this.state.directives.find((d) => d.id === content);
        if (!directive || (directive.status !== 'PROPOSED' && directive.status !== 'APPROVED')) return { ok: false, error: `No pending directive "${content}"` };
        if (directive.deliveredInTurn) return { ok: false, error: `Directive ${content} is being delivered in turn ${directive.deliveredInTurn}` };
        await this.mutate((s) => { s.directives.find((x) => x.id === content)!.status = 'REJECTED'; });
        await this.emit('directive.rejected', { id: content });
        return { ok: true, data: { directiveId: content } };
      }
      case 'pause': {
        if (this.state.status !== 'RUNNING') return { ok: false, error: `Cannot pause while ${this.state.status}` };
        await this.mutate((s) => { s.pauseRequested = true; });
        await this.emit('runtime.pause_requested', {});
        this.wake();
        return { ok: true, data: { message: 'Pause requested; it takes effect at the next safe boundary.' } };
      }
      case 'resume': {
        const status = this.state.status;
        if (status === 'BLOCKED' || status === 'FAILED') {
          if (!content) return { ok: false, error: 'A RESOLUTION is required: resume <resolution>' };
          const kind = this.state.blocked?.kind;
          const hp = await this.newHotPrompt('RESOLUTION', content, 'APPLIED');
          await this.mutate((s) => {
            s.status = 'RUNNING';
            s.blocked = undefined;
            s.pauseRequested = false;
            s.lastError = undefined;
            s.retry = undefined;
            // A read-only violation keeps its WORKER_DONE turn: the review still runs first.
            // A provider check is about the configuration, not a message for the worker.
            if (kind !== 'PROVIDER_CHECK') s.pendingResolution = [s.pendingResolution, content].filter(Boolean).join('\n\n');
          });
          await this.emit('runtime.resumed', { hotPromptId: hp.id, previousStatus: status, kind });
          this.wake();
          return { ok: true, data: { message: 'Resolution recorded; resuming the same worker session.' } };
        }
        if (status === 'PAUSED') {
          if (content) await this.newHotPrompt('RESOLUTION', content, 'APPLIED');
          await this.mutate((s) => {
            s.status = 'RUNNING';
            if (content) s.pendingResolution = [s.pendingResolution, content].filter(Boolean).join('\n\n');
          });
          await this.emit('runtime.resumed', { previousStatus: status });
          this.wake();
          return { ok: true, data: { message: 'Resumed.' } };
        }
        if (status === 'RUNNING' && this.state.pauseRequested) {
          await this.mutate((s) => { s.pauseRequested = false; });
          return { ok: true, data: { message: 'Pause request cancelled.' } };
        }
        return { ok: false, error: `Nothing to resume (status ${status})` };
      }
      case 'stop':
        this.requestStop('console');
        return { ok: true, data: { message: this.state.pendingTurn ? 'Stopping after the current turn.' : 'Stopping.' } };
      default:
        return { ok: false, error: `Unknown command "${command}". Type help.` };
    }
  }
}
