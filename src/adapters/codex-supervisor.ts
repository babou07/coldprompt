import type { ThreadOptions } from '@openai/codex-sdk';
import type { z } from 'zod';
import { ColdPromptError, redact } from '../errors.js';
import {
  buildEvaluationPrompt, buildInteractionPrompt, INTERACTION_JSON_SCHEMA, parseSupervisorOutput, REVIEW_JSON_SCHEMA, SUPERVISOR_SYSTEM_PROMPT,
  type EvaluationContext, type InteractionRequest, type SupervisorAdapter, type SupervisorCallOptions
} from '../supervisor.js';
import { interactionSchema, reviewSchema, type CodexSupervisorConfig, type InteractionResult, type ProbeResult, type Review } from '../types.js';
import { createCodex, probeCodexModel, type CodexLike, type CodexThreadLike } from './codex.js';

/**
 * Codex as supervisor: one Codex thread for the whole plan, in a read-only
 * sandbox that never asks for approval. Answers are constrained by the same
 * JSON Schemas as the Claude supervisor (Codex outputSchema); prose is never
 * accepted as a decision.
 *
 * Codex has no separate system prompt: the supervisor instructions open the
 * first message of the thread.
 */
export class CodexSupervisorAdapter implements SupervisorAdapter {
  readonly provider = 'codex';
  private readonly codex: CodexLike;
  private thread?: CodexThreadLike;
  private sessionId?: string;
  private started = false;
  private busy = false;

  constructor(
    private readonly config: CodexSupervisorConfig,
    private readonly cwd: string,
    codex?: CodexLike,
    private readonly maxOutputChars = 20000
  ) {
    this.codex = codex ?? createCodex(config.codexPath);
  }

  threadOptions(): ThreadOptions {
    const out: ThreadOptions = { workingDirectory: this.cwd, sandboxMode: 'read-only', approvalPolicy: 'never' };
    if (this.config.model) out.model = this.config.model;
    if (this.config.reasoningEffort) out.modelReasoningEffort = this.config.reasoningEffort;
    if (this.config.skipGitRepoCheck) out.skipGitRepoCheck = true;
    return out;
  }

  async resumeSession(sessionId: string, started: boolean): Promise<void> {
    this.sessionId = sessionId;
    // A Codex thread id only exists once the thread received a prompt.
    this.started = started || Boolean(sessionId);
    this.thread = undefined;
  }

  getSessionId(): string | undefined { return this.sessionId; }
  isSessionStarted(): boolean { return this.started; }

  probe(_workingDirectory: string, signal?: AbortSignal): Promise<ProbeResult> {
    return probeCodexModel({ codexPath: this.config.codexPath, model: this.config.model, reasoningEffort: this.config.reasoningEffort, workingDirectory: this.cwd, signal });
  }

  async evaluateTurn(context: EvaluationContext, options: SupervisorCallOptions = {}): Promise<Review> {
    const value = await this.call(buildEvaluationPrompt(context, this.maxOutputChars), REVIEW_JSON_SCHEMA, options.signal);
    return this.validate(reviewSchema, value, 'review');
  }

  async interact(request: InteractionRequest, options: SupervisorCallOptions = {}): Promise<InteractionResult> {
    const value = await this.call(buildInteractionPrompt(request), INTERACTION_JSON_SCHEMA, options.signal);
    return this.validate(interactionSchema, value, 'interaction');
  }

  private validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    return parseSupervisorOutput(schema, value, `Codex supervisor ${label}`);
  }

  /** First message of a new thread: the supervisor instructions, then the request. */
  buildInput(prompt: string): string {
    if (this.started) return prompt;
    return [SUPERVISOR_SYSTEM_PROMPT, this.config.appendSystemPrompt, '---', prompt].filter(Boolean).join('\n\n');
  }

  private async call(prompt: string, schema: object, signal?: AbortSignal): Promise<unknown> {
    if (this.busy) throw new ColdPromptError('SESSION_LOCK', 'Concurrent write to the Codex supervisor thread refused');
    this.busy = true;
    const timeout = AbortSignal.timeout(this.config.timeoutSeconds * 1000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      if (!this.thread) {
        this.thread = this.sessionId
          ? this.codex.resumeThread(this.sessionId, this.threadOptions())
          : this.codex.startThread(this.threadOptions());
      }
      let answer: string | undefined;
      try {
        const { events } = await this.thread.runStreamed(this.buildInput(prompt), { outputSchema: schema, signal: combined });
        for await (const event of events) {
          switch (event.type) {
            case 'thread.started':
              this.sessionId = event.thread_id;
              this.started = true;
              break;
            case 'item.completed':
              if (event.item.type === 'agent_message') answer = event.item.text;
              break;
            case 'turn.failed':
              throw new Error(`Codex supervisor turn failed: ${event.error.message}`);
            case 'error':
              throw new Error(`Codex supervisor stream error: ${event.message}`);
            default:
              break;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error('Codex supervisor call aborted'), { name: 'AbortError', cause: error });
        if (timeout.aborted) throw new Error(`Codex supervisor timed out after ${this.config.timeoutSeconds}s`);
        throw error;
      } finally {
        if (this.thread.id) { this.sessionId = this.thread.id; this.started = true; }
      }
      try {
        return JSON.parse(answer ?? '');
      } catch {
        throw new ColdPromptError('PERMANENT', `Codex supervisor returned no structured output; prose is not accepted as a control decision: ${redact((answer ?? '').slice(0, 300))}`);
      }
    } finally {
      this.busy = false;
    }
  }
}
