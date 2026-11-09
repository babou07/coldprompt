import { z } from 'zod';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const verificationCommandSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  run: z.string().min(1),
  timeoutSeconds: z.number().positive().default(600),
  /** completion: before accepting MISSION_COMPLETE; turn: after every worker turn. */
  when: z.enum(['completion', 'turn']).default('completion')
});

export const verificationPluginSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  /** Path (relative to the config file) of an ES module exporting createVerifier(options). */
  module: z.string().min(1),
  options: z.record(z.unknown()).default({}),
  when: z.enum(['completion', 'turn']).default('completion')
});

export const missionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1),
  prompt: z.object({
    type: z.literal('COLD_PROMPT'),
    content: z.string().min(1)
  }),
  completionCriteria: z.array(z.string()).default([]),
  execution: z.object({
    readOnly: z.boolean().default(false),
    maxTurns: z.number().int().positive().optional()
  }).strict().default({}),
  /** Names of verifications (commands or plugins) required for this mission. Default: all. */
  verification: z.array(z.string()).optional(),
  requireHumanApproval: z.boolean().optional()
});

/**
 * A session file: missions that run one after another on ONE worker thread
 * (Codex thread or Claude conversation). A new session starts a new thread
 * unless resumeThread names an existing one of the configured worker.
 */
export const sessionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1).optional(),
  /** Existing worker thread (Codex thread / Claude session id) to continue instead of starting a new one. */
  resumeThread: z.string().min(1).optional(),
  /**
   * previous: the first prompt of this session includes the worker reports of
   * the previous session (from ColdPrompt's turn artifacts, not the repository).
   */
  handoff: z.enum(['none', 'previous']).default('none'),
  missions: z.array(missionSchema).min(1)
}).strict();

// Providers. Each role (worker, supervisor) picks one with "provider:"; every
// provider has its own options. Adding a provider: a schema here, an adapter
// in src/adapters/, an entry in src/adapters/registry.ts.

const reasoningEffort = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);
const claudePermissionMode = z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);

export const codexWorkerSchema = z.object({
  provider: z.literal('codex'),
  model: z.string().nullable().optional(),
  /**
   * Left undefined by default so the user's Codex configuration
   * (e.g. a custom profile with writable .git) is inherited.
   */
  sandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  approvalPolicy: z.enum(['never', 'on-request', 'on-failure', 'untrusted']).optional(),
  reasoningEffort: reasoningEffort.optional(),
  skipGitRepoCheck: z.boolean().default(false),
  codexPath: z.string().optional()
}).strict();

export const claudeWorkerSchema = z.object({
  provider: z.literal('claude'),
  model: z.string().nullable().optional(),
  command: z.string().default('claude'),
  /**
   * Left undefined by default so the user's Claude Code settings (permission
   * rules) are inherited. Unattended runs usually need acceptEdits plus
   * allowedTools, or bypassPermissions.
   */
  permissionMode: claudePermissionMode.optional(),
  /** Tools available to the worker (--tools). Default: all Claude Code tools. */
  tools: z.array(z.string()).optional(),
  /** Tools allowed without asking (--allowedTools), e.g. "Bash(npm test:*)". */
  allowedTools: z.array(z.string()).optional(),
  /** The only tools of a read-only mission. Bash is not read-only: add it at your own risk. */
  readOnlyTools: z.array(z.string()).default(['Read', 'Grep', 'Glob']),
  /** Upper bound for one worker turn. Default: none. */
  turnTimeoutSeconds: z.number().positive().optional(),
  appendSystemPrompt: z.string().optional()
}).strict();

export const claudeSupervisorSchema = z.object({
  provider: z.literal('claude'),
  model: z.string().nullable().optional(),
  command: z.string().default('claude'),
  tools: z.array(z.string()).default(['Read', 'Grep', 'Glob']),
  permissionMode: claudePermissionMode.default('dontAsk'),
  timeoutSeconds: z.number().positive().default(900),
  appendSystemPrompt: z.string().optional()
}).strict();

/** Codex as supervisor: always a read-only sandbox, never asks for approval. */
export const codexSupervisorSchema = z.object({
  provider: z.literal('codex'),
  model: z.string().nullable().optional(),
  reasoningEffort: reasoningEffort.optional(),
  skipGitRepoCheck: z.boolean().default(false),
  codexPath: z.string().optional(),
  timeoutSeconds: z.number().positive().default(900),
  appendSystemPrompt: z.string().optional()
}).strict();

export const workerSchema = z.discriminatedUnion('provider', [codexWorkerSchema, claudeWorkerSchema]);
export const supervisorSchema = z.discriminatedUnion('provider', [claudeSupervisorSchema, codexSupervisorSchema]);

export type WorkerConfig = z.infer<typeof workerSchema>;
export type SupervisorConfig = z.infer<typeof supervisorSchema>;
export type CodexWorkerConfig = z.infer<typeof codexWorkerSchema>;
export type ClaudeWorkerConfig = z.infer<typeof claudeWorkerSchema>;
export type ClaudeSupervisorConfig = z.infer<typeof claudeSupervisorSchema>;
export type CodexSupervisorConfig = z.infer<typeof codexSupervisorSchema>;

const baseConfigShape = {
  version: z.literal(1),
  project: z.object({
    name: z.string(),
    workingDirectory: z.string()
  }),
  worker: workerSchema,
  supervisor: supervisorSchema,
  runtime: z.object({
    maxTurns: z.number().int().positive(),
    maxHours: z.number().positive(),
    statusEvery: z.number().int().positive(),
    retryDelaysSeconds: z.array(z.number().nonnegative()),
    sessionLockRetryDelaysSeconds: z.array(z.number().nonnegative()).default([5, 15, 30, 60]),
    verifyGitCleanOnCompletion: z.boolean(),
    requireHumanApprovalForMissionTransition: z.boolean(),
    maxWorkerOutputChars: z.number().int().positive().default(20000)
  }),
  verification: z.object({
    commands: z.array(verificationCommandSchema).default([]),
    plugins: z.array(verificationPluginSchema).default([])
  }).default({})
};

/** coldprompt.yaml as written: shared settings plus the session files, in order. */
export const planSchema = z.object({
  ...baseConfigShape,
  /** Session file paths, relative to coldprompt.yaml, executed one after another. */
  sessions: z.array(z.string().min(1)).min(1)
});

/** The loaded plan: session files inlined (`file` is where each came from). */
export const configSchema = z.object({
  ...baseConfigShape,
  sessions: z.array(sessionSchema.extend({ file: z.string().optional() })).min(1)
}).superRefine((config, ctx) => {
  const sessionIds = new Set<string>();
  const ids = new Set<string>();
  config.sessions.forEach((session, si) => {
    if (sessionIds.has(session.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessions', si, 'id'], message: `Duplicate session id "${session.id}"` });
    }
    sessionIds.add(session.id);
    session.missions.forEach((mission, index) => {
      if (ids.has(mission.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessions', si, 'missions', index, 'id'], message: `Duplicate mission id "${mission.id}"` });
      }
      ids.add(mission.id);
    });
  });
  const names = new Set<string>();
  for (const v of [...config.verification.commands, ...config.verification.plugins]) {
    if (names.has(v.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['verification'], message: `Duplicate verification name "${v.name}"` });
    }
    names.add(v.name);
  }
  if (config.sessions[0]?.handoff === 'previous') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessions', 0, 'handoff'], message: 'The first session has no previous session to hand off from' });
  }
  config.sessions.forEach((session, si) => session.missions.forEach((mission, index) => {
    for (const name of mission.verification ?? []) {
      if (!names.has(name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sessions', si, 'missions', index, 'verification'], message: `Unknown verification "${name}"` });
      }
    }
  }));
}).transform((config) => ({
  ...config,
  /** All missions in execution order, each tagged with its session id. */
  missions: config.sessions.flatMap((session) => session.missions.map((mission) => ({ ...mission, session: session.id })))
}));

export type Config = z.output<typeof configSchema>;
export type Session = Config['sessions'][number];
/** A mission of the loaded plan (with the id of the session it belongs to). */
export type Mission = z.infer<typeof missionSchema> & { session: string };
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;
export type VerificationPlugin = z.infer<typeof verificationPluginSchema>;

// ---------------------------------------------------------------------------
// Supervisor decisions
// ---------------------------------------------------------------------------

export const DECISIONS = ['CONTINUE', 'CLARIFY', 'BLOCKED', 'MISSION_COMPLETE', 'STOP'] as const;
export type Decision = typeof DECISIONS[number];

export const reviewSchema = z.object({
  decision: z.enum(DECISIONS),
  reason: z.string(),
  workerInstruction: z.string(),
  evidence: z.array(z.string())
}).strict();

export type Review = z.infer<typeof reviewSchema>;

export const interactionSchema = z.object({
  answer: z.string(),
  /** A worker instruction Claude proposes. Never approved implicitly. */
  proposedDirective: z.string().nullable()
}).strict();

export type InteractionResult = z.infer<typeof interactionSchema>;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export type RuntimeStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'BLOCKED'
  | 'PAUSED'
  | 'STOPPED'
  | 'COMPLETED'
  | 'FAILED';

export type HotPromptIntent = 'QUESTION' | 'DIRECTIVE' | 'RESOLUTION';

export interface HotPrompt {
  id: string;
  type: 'HOT_PROMPT';
  intent: HotPromptIntent;
  content: string;
  createdAt: string;
  /** QUEUED -> PROCESSING -> ANSWERED (question/directive) or APPLIED (resolution). */
  status: 'QUEUED' | 'PROCESSING' | 'ANSWERED' | 'APPLIED' | 'FAILED';
  answer?: string;
  error?: string;
  directiveId?: string;
  answeredAt?: string;
}

/**
 * A worker directive. Only APPROVED directives are ever delivered,
 * and only at a turn boundary.
 */
export interface Directive {
  id: string;
  /** HUMAN: written by the user verbatim. SUPERVISOR: proposed by Claude. */
  author: 'HUMAN' | 'SUPERVISOR';
  content: string;
  sourceHotPromptId?: string;
  status: 'PROPOSED' | 'APPROVED' | 'DELIVERED' | 'REJECTED';
  createdAt: string;
  approvedAt?: string;
  deliveredAt?: string;
  deliveredInTurn?: string;
}

/** What a provider probe found: the model that actually answered, when known. */
export interface ProbeResult { model?: string }

export type BlockKind =
  | 'SUPERVISOR'          // the supervisor returned BLOCKED
  | 'AMBIGUOUS_TURN'      // restart found a worker turn of unknown outcome
  | 'MISSION_APPROVAL'    // human approval required for a mission transition
  | 'MISSION_LIMIT'       // per-mission maxTurns reached
  | 'RETRIES_EXHAUSTED'   // transient errors exceeded the retry budget
  | 'SESSION_LOCK'        // the worker thread still has an active writer
  | 'UNSAFE_REPOSITORY'   // repository in an unsafe state
  | 'READ_ONLY_VIOLATION' // a read-only mission changed the repository
  | 'VERIFICATION_FAILED' // completion checks failed on a read-only mission (the worker cannot fix them)
  | 'PROVIDER_CHECK'     // the worker or supervisor model did not answer at run start
  | 'FAILURE';            // permanent failure, auth error, or supervisor STOP

export interface BlockInfo {
  kind: BlockKind;
  reason: string;
  at: string;
  turnId?: string;
}

export interface GitSnapshot {
  isRepo: boolean;
  head?: string;
  branch?: string;
  dirty?: boolean;
  changedFiles?: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
  operationInProgress?: string;
  capturedAt: string;
}

export type WorkerInputSource = 'COLD_PROMPT' | 'SUPERVISOR' | 'VERIFICATION' | 'RESOLUTION';

export interface WorkerInput {
  source: WorkerInputSource;
  text: string;
}

export type TurnPhase = 'WORKER_RUNNING' | 'WORKER_DONE' | 'REVIEWED';

export interface PendingTurn {
  turnId: string;
  missionId: string;
  missionTurn: number;
  phase: TurnPhase;
  prompt: string;
  inputSource: WorkerInputSource;
  deliveredDirectiveIds: string[];
  resolution?: string;
  startedAt: string;
  gitBefore: GitSnapshot;
  gitAfter?: GitSnapshot;
  commits?: string[];
  resultRef?: string;
  reviewRef?: string;
  verification?: VerificationOutcome[];
}

export interface VerificationOutcome {
  name: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface MissionProgress {
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED';
  turns: number;
  /** Session the mission ran in (detects missions moved between session files). */
  session?: string;
  /** Worker turn artifacts of this mission, oldest first (used by handoff). */
  resultRefs?: string[];
  startedAt?: string;
  completedAt?: string;
}

export interface SessionProgress {
  /** The worker thread of this session, once known. */
  workerThreadId?: string;
  /** Worker provider that owns workerThreadId (absent in old states: codex). */
  workerProvider?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ErrorInfo {
  kind: string;
  message: string;
  at: string;
  attempt?: number;
}

export interface State {
  version: 3;
  status: RuntimeStatus;
  missionIndex: number;
  activeMissionId?: string;
  missionTurns: number;
  totalTurns: number;
  missions: Record<string, MissionProgress>;
  sessions: Record<string, SessionProgress>;
  /** Thread from a pre-session (v1/v2) state; given to the current session on open. */
  legacyWorkerThreadId?: string;
  supervisorSessionId?: string;
  /** Supervisor provider that owns supervisorSessionId (absent in old states: claude). */
  supervisorProvider?: string;
  /** True once the supervisor has accepted at least one prompt for supervisorSessionId. */
  supervisorSessionStarted: boolean;
  nextWorkerInput?: WorkerInput;
  pendingTurn?: PendingTurn;
  pendingResolution?: string;
  lastWorkerResult?: string;
  lastResultRef?: string;
  lastReviewRef?: string;
  lastDecision?: Decision;
  lastReview?: Review;
  blocked?: BlockInfo;
  /** Kept for backwards compatibility with v1 consumers. */
  blockedReason?: string;
  pauseRequested: boolean;
  hotPrompts: HotPrompt[];
  directives: Directive[];
  lastGit?: GitSnapshot;
  retry?: ErrorInfo;
  lastError?: ErrorInfo;
  createdAt: string;
  runStartedAt?: string;
  updatedAt: string;
}
