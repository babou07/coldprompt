export interface WorkerSessionOptions {
  workingDirectory: string;
  /** Read-only sandbox for this session (independent audits, analysis missions). */
  readOnly: boolean;
}

export interface WorkerCommandRecord {
  command: string;
  exitCode?: number;
  status: string;
}

export interface WorkerTurnResult {
  /** Session (thread) id, known at the latest once the turn finished. */
  sessionId: string | undefined;
  finalResponse: string;
  commands: WorkerCommandRecord[];
  fileChanges: Array<{ path: string; kind: string }>;
  errors: string[];
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

/** Live activity of a running turn (display only; never used for control). */
export interface WorkerProgress {
  phase: 'started' | 'updated' | 'completed';
  kind: 'command' | 'file_change' | 'tool' | 'message' | 'reasoning' | 'plan' | 'web_search' | 'error';
  /** One line: the command, tool name, file list, first line of a message… */
  summary: string;
  /** Truncated extra text: command output, tool arguments/result, full message. */
  detail?: string;
  status?: string;
}

export interface ExecuteTurnOptions {
  signal?: AbortSignal;
  /** Called for live activity while the turn runs. Errors thrown here are ignored. */
  onProgress?: (progress: WorkerProgress) => void | Promise<void>;
  /** Called as soon as the session id is known, so it can be persisted before the turn ends. */
  onSessionId?: (sessionId: string) => void | Promise<void>;
}

/**
 * Provider-agnostic worker. Implementations must refuse to run two turns
 * concurrently on the same session.
 */
export interface WorkerAdapter {
  readonly provider: string;
  startSession(options: WorkerSessionOptions): Promise<void>;
  resumeSession(sessionId: string, options: WorkerSessionOptions): Promise<void>;
  executeTurn(input: string, options?: ExecuteTurnOptions): Promise<WorkerTurnResult>;
  /** Aborts the active turn, if any. Never kills foreign processes. */
  cancel(): Promise<void>;
  getSessionId(): string | undefined;
}
