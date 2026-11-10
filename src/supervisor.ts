import type { z } from 'zod';
import { ColdPromptError } from './errors.js';
import { DECISIONS, type FinalizeResult, type GitSnapshot, type ProbeResult, type InteractionResult, type Mission, type Review, type VerificationOutcome } from './types.js';
import type { WorkerTurnResult } from './worker.js';

export interface EvaluationContext {
  mission: Mission;
  missionIndex: number;
  missionCount: number;
  /** The session (one worker thread) the mission belongs to; index is 0-based. */
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
  /** Present when this review is asked again because the previous answer broke a plan rule. */
  correction?: string;
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

/** The plan's last call (config `finalize`), once every mission is complete. */
export interface FinalizeRequest {
  /** The user's instructions (config finalize.prompt). */
  prompt: string;
  project: string;
  /** Directory of coldprompt.yaml: relative paths in the answer are relative to it. */
  configDirectory: string;
  /** Sessions and missions of the plan with their status. */
  plan: Array<{ id: string; title?: string; missions: Array<{ id: string; title: string; status: string }> }>;
  /** finalize.inputs: each mission's structured output, or its last report when it has none. */
  inputs: Array<{ missionId: string; title: string; outputName?: string; outputPath?: string; output?: unknown; lastReport?: string }>;
}

export interface SupervisorCallOptions {
  signal?: AbortSignal;
}

/**
 * Provider-agnostic supervisor. The orchestrator serializes every call,
 * so implementations never see concurrent writers on one conversation.
 */
/** JSON Schemas of the supervisor's two answers (strict: every provider must honour them). */
export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: [...DECISIONS] },
    reason: { type: 'string' },
    workerInstruction: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } }
  },
  required: ['decision', 'reason', 'workerInstruction', 'evidence'],
  additionalProperties: false
} as const;

export const INTERACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    proposedDirective: { type: ['string', 'null'] }
  },
  required: ['answer', 'proposedDirective'],
  additionalProperties: false
} as const;

/** Validates a supervisor answer; anything off-schema is a permanent error, never a decision. */
export function parseSupervisorOutput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ColdPromptError('PERMANENT', `${label} output does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export interface SupervisorAdapter {
  readonly provider: string;
  evaluateTurn(context: EvaluationContext, options?: SupervisorCallOptions): Promise<Review>;
  interact(request: InteractionRequest, options?: SupervisorCallOptions): Promise<InteractionResult>;
  /** Binds the adapter to an existing conversation. `started` = the conversation already received a prompt. */
  resumeSession(sessionId: string, started: boolean): Promise<void>;
  getSessionId(): string | undefined;
  /** True once the bound conversation has received at least one prompt. */
  isSessionStarted(): boolean;
  /** Optional: a cheap call proving that the configured model answers (run start). */
  probe?(workingDirectory: string, signal?: AbortSignal): Promise<ProbeResult>;
  /**
   * Optional: the plan's finalize call, in the same conversation, with the
   * provider's extra finalize permissions for this call only.
   */
  finalize?(request: FinalizeRequest, options?: SupervisorCallOptions): Promise<FinalizeResult>;
}

export const FINALIZE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } }
  },
  required: ['ok', 'summary', 'files'],
  additionalProperties: false
} as const;

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

The plan, not you, moves the worker from one mission to the next. When the current mission's
completion criteria are met, return MISSION_COMPLETE: ColdPrompt then runs the completion checks
and sends the next mission itself, with its own permissions (a read-only mission keeps a read-only
sandbox until it is completed). Never tell the worker to start, prepare or do the work of a later
mission in a CONTINUE or CLARIFY instruction, and never change the file paths, scope or read-only
setting a mission prescribes.

Human HOT_PROMPT questions may also arrive. Answer them; you may propose a worker directive, but it
will only be delivered if the human explicitly approves it. Never assume a proposal is approved.`;

export function buildEvaluationPrompt(ctx: EvaluationContext, maxOutputChars: number): string {
  const r = ctx.workerResult;
  const commands = r.commands.slice(-40).map((c) => `- [${c.status}${c.exitCode === undefined ? '' : ` exit=${c.exitCode}`}] ${truncate(c.command, 300)}`);
  const files = r.fileChanges.slice(-100).map((f) => `- ${f.kind} ${f.path}`);
  const verification = ctx.verification.map((v) => `- ${v.name}: ${v.passed ? 'PASSED' : 'FAILED'}\n${truncate(v.output, 2000)}`);
  return [
    `# ColdPrompt worker turn review`,
    ...(ctx.session ? [`Session ${ctx.session.index + 1}/${ctx.session.count}: ${ctx.session.id} (one worker thread for all its missions)`] : []),
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
    ...(ctx.correction ? [`## Your previous answer for this turn was refused`, ctx.correction, ``] : []),
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
    ? `# HOT_PROMPT QUESTION from the human operator\nAnswer the message. Do not assume any change to the worker. If the human asks for something to be done by the worker, or if an instruction to the worker would resolve the situation (a block included), put that instruction, self-contained, in proposedDirective and explain it in answer; otherwise set it to null. It is delivered only after explicit human approval.`
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

export function buildFinalizePrompt(req: FinalizeRequest, maxOutputChars: number): string {
  const plan = req.plan.flatMap((s) => [
    `- session ${s.id}${s.title ? ` — ${s.title}` : ''}`,
    ...s.missions.map((m) => `  - [${m.status}] ${m.id} — ${m.title}`)
  ]);
  const inputs = req.inputs.flatMap((i) => [
    `### ${i.missionId} — ${i.title}`,
    ...(i.output !== undefined
      ? [`Structured output "${i.outputName}" (also in ${i.outputPath}):`, '```json', truncate(JSON.stringify(i.output, null, 2), maxOutputChars), '```']
      : [`No structured output; last worker report:`, truncate(i.lastReport ?? '(none)', maxOutputChars)]),
    ''
  ]);
  return [
    `# ColdPrompt plan finalize: ${req.project}`,
    'Every mission of the plan is complete. This is not a turn review: there is no worker to instruct.',
    'For this call only you have the extra permissions the user configured for finalize; use them only for the instructions below.',
    `Relative paths are relative to ${req.configDirectory}.`,
    '',
    '## Plan',
    ...plan,
    '',
    ...(inputs.length ? ['## Inputs', ...inputs] : []),
    '## Instructions from the user',
    req.prompt.trim(),
    '',
    'When done, return JSON: ok = true only if every instruction above succeeded (false if anything failed or was refused), summary = what you did and its outcome (say plainly what failed), files = every file you wrote.'
  ].join('\n');
}
