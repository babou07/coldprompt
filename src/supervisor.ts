import type { GitSnapshot, InteractionResult, Mission, Review, VerificationOutcome } from './types.js';
import type { WorkerTurnResult } from './worker.js';

export interface EvaluationContext {
  mission: Mission;
  missionIndex: number;
  missionCount: number;
  /** The session (one Codex thread) the mission belongs to; index is 0-based. */
  session?: { id: string; index: number; count: number };
  turnId: string;
  missionTurn: number;
  workerPrompt: string;
  workerResult: WorkerTurnResult;
  gitBefore: GitSnapshot;
  gitAfter: GitSnapshot;
  commits: string[];
  verification: VerificationOutcome[];
  deliveredDirectives: string[];
  resolution?: string;
  /** Present when a MISSION_COMPLETE was rejected by deterministic checks. */
  previousCompletionRejected?: string;
}

export interface InteractionRequest {
  intent: 'QUESTION' | 'DIRECTIVE';
  content: string;
  status: string;
  missionId?: string;
  blockedReason?: string;
  lastReview?: Review;
  lastWorkerResult?: string;
}

export interface SupervisorCallOptions {
  signal?: AbortSignal;
}

/**
 * Provider-agnostic supervisor. The orchestrator serializes every call,
 * so implementations never see concurrent writers on one conversation.
 */
export interface SupervisorAdapter {
  readonly provider: string;
  evaluateTurn(context: EvaluationContext, options?: SupervisorCallOptions): Promise<Review>;
  interact(request: InteractionRequest, options?: SupervisorCallOptions): Promise<InteractionResult>;
  /** Binds the adapter to an existing conversation. `started` = Claude already saw a prompt. */
  resumeSession(sessionId: string, started: boolean): Promise<void>;
  getSessionId(): string | undefined;
  /** True once the bound conversation has received at least one prompt. */
  isSessionStarted(): boolean;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`;
}

function describeGit(label: string, git: GitSnapshot): string {
  if (!git.isRepo) return `${label}: not a git repository`;
  return `${label}: HEAD=${git.head ?? '?'} branch=${git.branch ?? '?'} dirty=${git.dirty} changedFiles=${git.changedFiles ?? 0}`
    + (git.upstream ? ` upstream=${git.upstream} ahead=${git.ahead} behind=${git.behind}` : '')
    + (git.operationInProgress ? ` OPERATION_IN_PROGRESS=${git.operationInProgress}` : '');
}

export const SUPERVISOR_SYSTEM_PROMPT = `You are the supervisor in ColdPrompt, an orchestrator for long-running coding agents.
A worker agent executes missions turn by turn. After each worker turn you receive its output and
deterministic evidence (git state, verification results). You reply ONLY with the requested JSON.

Decisions:
- CONTINUE: the mission progresses; workerInstruction is the next instruction for the worker.
- CLARIFY: you need more evidence; workerInstruction asks the worker for it.
- BLOCKED: human judgment is required (ambiguity, risk, scope decision). The worker is suspended.
- MISSION_COMPLETE: every completion criterion is satisfied with concrete evidence. A worker saying
  "done" is NOT evidence. Deterministic checks run afterwards and may reject completion.
- STOP: unrecoverable failure or unacceptable risk.

Human HOT_PROMPT questions may also arrive. Answer them; you may propose a worker directive, but it
will only be delivered if the human explicitly approves it. Never assume a proposal is approved.`;

export function buildEvaluationPrompt(ctx: EvaluationContext, maxOutputChars: number): string {
  const r = ctx.workerResult;
  const commands = r.commands.slice(-40).map((c) => `- [${c.status}${c.exitCode === undefined ? '' : ` exit=${c.exitCode}`}] ${truncate(c.command, 300)}`);
  const files = r.fileChanges.slice(-100).map((f) => `- ${f.kind} ${f.path}`);
  const verification = ctx.verification.map((v) => `- ${v.name}: ${v.passed ? 'PASSED' : 'FAILED'}\n${truncate(v.output, 2000)}`);
  return [
    `# ColdPrompt worker turn review`,
    ...(ctx.session ? [`Session ${ctx.session.index + 1}/${ctx.session.count}: ${ctx.session.id} (one Codex thread for all its missions)`] : []),
    `Mission ${ctx.missionIndex + 1}/${ctx.missionCount}: ${ctx.mission.id} — ${ctx.mission.title}`,
    `Turn ${ctx.missionTurn} of this mission (turn id ${ctx.turnId}). Read-only mission: ${ctx.mission.execution.readOnly}.`,
    ``,
    `## Mission objective (COLD_PROMPT)`,
    ctx.mission.prompt.content.trim(),
    ``,
    `## Completion criteria`,
    ...(ctx.mission.completionCriteria.length ? ctx.mission.completionCriteria.map((c) => `- ${c}`) : ['- (none declared)']),
    ``,
    ...(ctx.resolution ? [`## Human RESOLUTION delivered this turn`, ctx.resolution, ``] : []),
    ...(ctx.deliveredDirectives.length ? [`## Approved human directives delivered this turn`, ...ctx.deliveredDirectives.map((d) => `- ${d}`), ``] : []),
    ...(ctx.previousCompletionRejected ? [`## Previous MISSION_COMPLETE was rejected by deterministic checks`, ctx.previousCompletionRejected, ``] : []),
    `## Instruction sent to the worker`,
    truncate(ctx.workerPrompt, 4000),
    ``,
    `## Worker final response`,
    truncate(r.finalResponse || '(empty)', maxOutputChars),
    ``,
    `## Commands executed (${r.commands.length})`,
    ...(commands.length ? commands : ['- none']),
    ``,
    `## Files changed by the worker (${r.fileChanges.length})`,
    ...(files.length ? files : ['- none']),
    ...(r.errors.length ? [``, `## Worker errors`, ...r.errors.map((e) => `- ${truncate(e, 500)}`)] : []),
    ``,
    `## Git evidence`,
    describeGit('Before', ctx.gitBefore),
    describeGit('After', ctx.gitAfter),
    `Commits created: ${ctx.commits.length ? ctx.commits.join(', ') : 'none'}`,
    ``,
    `## Per-turn verification`,
    ...(verification.length ? verification : ['- none configured']),
    ``,
    `Return your decision as JSON. workerInstruction must be self-contained (empty string allowed for BLOCKED/STOP/MISSION_COMPLETE).`
  ].join('\n');
}

export function buildInteractionPrompt(req: InteractionRequest): string {
  const header = req.intent === 'QUESTION'
    ? `# HOT_PROMPT QUESTION from the human operator\nAnswer the question. Do not assume any change to the worker. If useful, propose a directive (it requires explicit human approval).`
    : `# HOT_PROMPT DIRECTIVE from the human operator\nPrepare a precise, self-contained instruction for the worker that implements the human's intent. Put it in proposedDirective and explain it in answer. It will be delivered only after explicit human approval.`;
  return [
    header,
    ``,
    `Runtime status: ${req.status}${req.missionId ? `, mission ${req.missionId}` : ''}`,
    ...(req.blockedReason ? [`Blocked reason: ${req.blockedReason}`] : []),
    ...(req.lastReview ? [`Last review: ${req.lastReview.decision} — ${req.lastReview.reason}`] : []),
    ...(req.lastWorkerResult ? [``, `Last worker response (excerpt):`, truncate(req.lastWorkerResult, 4000)] : []),
    ``,
    `## Human message`,
    req.content
  ].join('\n');
}
