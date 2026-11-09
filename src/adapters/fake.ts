import type { InteractionResult, ProbeResult, Review } from '../types.js';
import type { EvaluationContext, InteractionRequest, SupervisorAdapter, SupervisorCallOptions } from '../supervisor.js';
import type { ExecuteTurnOptions, WorkerAdapter, WorkerSessionOptions, WorkerTurnResult } from '../worker.js';

export type FakeWorkerStep =
  | string
  | Partial<WorkerTurnResult>
  | Error
  | ((input: string, session: string, options: ExecuteTurnOptions) => Partial<WorkerTurnResult> | Promise<Partial<WorkerTurnResult>>);

/**
 * Scripted worker. Records every call so tests can assert that no turn
 * ran while BLOCKED and that sessions were resumed rather than replaced.
 */
export class FakeWorkerAdapter implements WorkerAdapter {
  readonly provider = 'fake-worker';
  /** Unset by default (no model check); tests assign one to script it. */
  probe?: (workingDirectory: string, signal?: AbortSignal) => Promise<ProbeResult>;
  readonly calls: Array<{ kind: 'start' | 'resume' | 'turn' | 'cancel'; sessionId?: string; input?: string; readOnly?: boolean }> = [];
  private sessionId: string | undefined;
  private pendingNew = false;
  private active = false;
  private counter = 0;
  private abort?: () => void;

  constructor(private readonly steps: FakeWorkerStep[] = [], private readonly fallback: FakeWorkerStep = 'ok') {}

  async startSession(options: WorkerSessionOptions): Promise<void> {
    this.sessionId = undefined;
    this.pendingNew = true;
    this.calls.push({ kind: 'start', readOnly: options.readOnly });
  }

  async resumeSession(sessionId: string, options: WorkerSessionOptions): Promise<void> {
    this.sessionId = sessionId;
    this.pendingNew = false;
    this.calls.push({ kind: 'resume', sessionId, readOnly: options.readOnly });
  }

  get turnInputs(): string[] {
    return this.calls.filter((c) => c.kind === 'turn').map((c) => c.input ?? '');
  }

  async executeTurn(input: string, options: ExecuteTurnOptions = {}): Promise<WorkerTurnResult> {
    if (this.active) throw new Error('FakeWorker: concurrent turn on the same session');
    if (!this.sessionId && !this.pendingNew) throw new Error('FakeWorker: no session bound');
    this.active = true;
    try {
      if (!this.sessionId) this.sessionId = `fake-thread-${++this.counter}-${Date.now().toString(36)}`;
      this.calls.push({ kind: 'turn', sessionId: this.sessionId, input });
      await options.onSessionId?.(this.sessionId);
      const step = this.steps.length ? this.steps.shift()! : this.fallback;
      if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const cancelled = new Promise<never>((_, reject) => {
        this.abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        options.signal?.addEventListener('abort', () => this.abort?.(), { once: true });
      });
      cancelled.catch(() => undefined);
      if (step instanceof Error) throw step;
      const partial = typeof step === 'function'
        ? await Promise.race([Promise.resolve(step(input, this.sessionId, options)), cancelled])
        : typeof step === 'string' ? { finalResponse: step } : step;
      return { sessionId: this.sessionId, finalResponse: '', commands: [], fileChanges: [], errors: [], ...partial };
    } finally {
      this.active = false;
      this.abort = undefined;
    }
  }

  async cancel(): Promise<void> {
    this.calls.push({ kind: 'cancel' });
    this.abort?.();
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }
}

export type FakeReviewStep = Partial<Review> | Error | ((ctx: EvaluationContext) => Partial<Review> | Promise<Partial<Review>>);
export type FakeInteractionStep = Partial<InteractionResult> | ((req: InteractionRequest) => Partial<InteractionResult> | Promise<Partial<InteractionResult>>);

/** Scripted supervisor that also detects concurrent conversation writers. */
export class FakeSupervisorAdapter implements SupervisorAdapter {
  readonly provider = 'fake-supervisor';
  /** Unset by default (no model check); tests assign one to script it. */
  probe?: (workingDirectory: string, signal?: AbortSignal) => Promise<ProbeResult>;
  readonly evaluations: EvaluationContext[] = [];
  readonly interactions: InteractionRequest[] = [];
  concurrentWriterDetected = false;
  private inFlight = 0;
  private sessionId: string | undefined;
  private started = false;

  constructor(
    private readonly reviews: FakeReviewStep[] = [],
    private readonly answers: FakeInteractionStep[] = [],
    private readonly fallbackReview: Partial<Review> = { decision: 'MISSION_COMPLETE', reason: 'fake: complete' }
  ) {}

  private async guarded<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.inFlight > 0) this.concurrentWriterDetected = true;
    this.inFlight += 1;
    try {
      if (!this.sessionId) this.sessionId = `fake-supervisor-${Date.now().toString(36)}`;
      // Like the real CLI adapter, an abort ends the call (the child process would be killed).
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) fail();
        signal?.addEventListener('abort', fail, { once: true });
      });
      aborted.catch(() => undefined);
      const value = await Promise.race([fn(), aborted]);
      this.started = true;
      return value;
    } finally {
      this.inFlight -= 1;
    }
  }

  evaluateTurn(context: EvaluationContext, options?: SupervisorCallOptions): Promise<Review> {
    return this.guarded(async () => {
      this.evaluations.push(context);
      const step = this.reviews.length ? this.reviews.shift()! : this.fallbackReview;
      if (step instanceof Error) throw step;
      const partial = typeof step === 'function' ? await step(context) : step;
      return { decision: 'CONTINUE', reason: 'fake', workerInstruction: 'Continue.', evidence: [], ...partial };
    }, options?.signal);
  }

  interact(request: InteractionRequest, options?: SupervisorCallOptions): Promise<InteractionResult> {
    return this.guarded(async () => {
      this.interactions.push(request);
      const step = this.answers.length ? this.answers.shift()! : {};
      const partial = typeof step === 'function' ? await step(request) : step;
      return { answer: `fake answer to: ${request.content}`, proposedDirective: null, ...partial };
    }, options?.signal);
  }

  async resumeSession(sessionId: string, started: boolean): Promise<void> {
    this.sessionId = sessionId;
    this.started = started;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  isSessionStarted(): boolean {
    return this.started;
  }
}
