import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ColdPromptError, redact } from '../errors.js';
import { spawnRunner, type CommandRunner, type RunResult } from './process.js';
import {
  buildEvaluationPrompt, buildFinalizePrompt, buildInteractionPrompt, FINALIZE_JSON_SCHEMA, INTERACTION_JSON_SCHEMA, parseSupervisorOutput, REVIEW_JSON_SCHEMA, SUPERVISOR_SYSTEM_PROMPT,
  type EvaluationContext, type FinalizeRequest, type InteractionRequest, type SupervisorAdapter, type SupervisorCallOptions
} from '../supervisor.js';
import { finalizeResultSchema, interactionSchema, reviewSchema, type ClaudeSupervisorConfig, type FinalizeResult, type InteractionResult, type ProbeResult, type Review } from '../types.js';

/** Extra permissions of the finalize call (directories already resolved to absolute paths). */
export interface ClaudeCallExtras { tools: string[]; allowedTools: string[]; addDirs: string[]; timeoutSeconds: number }

export { INTERACTION_JSON_SCHEMA, REVIEW_JSON_SCHEMA };

export { spawnRunner, type CommandRunner, type RunResult };

/**
 * Checks that the installed Claude CLI has every flag in `flags` (and accepts
 * `permissionMode`, when given). Returns its version.
 */
export async function validateClaudeCli(runner: CommandRunner, command: string, cwd: string, flags: string[], permissionMode?: string): Promise<string> {
  const opts = { cwd, timeoutMs: 30_000 };
  let version: RunResult;
  let help: RunResult;
  try {
    version = await runner(command, ['--version'], opts);
    help = await runner(command, ['--help'], opts);
  } catch (error) {
    throw new ColdPromptError('INVALID_CONFIG', `Cannot run Claude CLI "${command}": ${(error as Error).message}`);
  }
  if (version.code !== 0) throw new ColdPromptError('INVALID_CONFIG', `"${command} --version" failed: ${version.stderr.trim()}`);
  const text = help.stdout + help.stderr;
  const missing = flags.filter((flag) => !text.includes(flag));
  if (missing.length) {
    throw new ColdPromptError('INVALID_CONFIG', `Installed Claude CLI (${version.stdout.trim()}) lacks required options: ${missing.join(', ')}`);
  }
  const modes = text.match(/--permission-mode[\s\S]*?\(choices:([^)]*)\)/);
  if (permissionMode && modes && !modes[1].includes(`"${permissionMode}"`)) {
    throw new ColdPromptError('INVALID_CONFIG', `Claude CLI does not support permission mode "${permissionMode}" (choices:${modes[1]})`);
  }
  return version.stdout.trim();
}

const PROBE_PROMPT = 'Reply with OK only.';

/**
 * Proves that `model` (or the CLI default) answers: one tiny call without
 * tools, without the Claude Code system prompt and without saving a session.
 * Returns the model that answered.
 */
export async function probeClaudeModel(runner: CommandRunner, command: string, cwd: string, model: string | null | undefined, signal?: AbortSignal): Promise<ProbeResult> {
  const args = ['--print', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--system-prompt', PROBE_PROMPT];
  if (model) args.push('--model', model);
  const run = await runner(command, args, { input: PROBE_PROMPT, cwd, signal, timeoutMs: 120_000 });
  let out: z.infer<typeof cliResultSchema> & { modelUsage?: Record<string, unknown> };
  try {
    out = cliResultSchema.parse(JSON.parse(run.stdout));
  } catch {
    throw new Error(`Claude CLI exited ${run.code} without JSON output: ${redact((run.stderr || run.stdout).trim().slice(0, 500))}`);
  }
  if (out.is_error || run.code !== 0) {
    throw new Error(`${out.api_error_status ? `status ${out.api_error_status}: ` : ''}${redact(String(out.result ?? run.stderr).slice(0, 500))}`);
  }
  return { model: Object.keys(out.modelUsage ?? {})[0] ?? model ?? undefined };
}

/** Flags this adapter relies on; checked against `claude --help` of the installed CLI. */
export const REQUIRED_FLAGS = ['--print', '--output-format', '--json-schema', '--resume', '--session-id', '--append-system-prompt', '--tools', '--permission-mode'];
/** Also needed when the supervisor has finalize permissions. */
export const FINALIZE_FLAGS = ['--allowedTools', '--add-dir'];

const cliResultSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  session_id: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  api_error_status: z.union([z.number(), z.string(), z.null()]).optional()
}).passthrough();

export class ClaudeSupervisorAdapter implements SupervisorAdapter {
  readonly provider = 'claude';
  private sessionId?: string;
  private started = false;
  private busy = false;

  constructor(
    private readonly config: ClaudeSupervisorConfig,
    private readonly cwd: string,
    private readonly runner: CommandRunner = spawnRunner,
    private readonly maxOutputChars = 20000,
    /** config.finalize.addDirs resolved to absolute paths (by the registry). */
    private readonly finalizeDirs: string[] = []
  ) {}

  /** Validates that the installed CLI supports every option we pass. Returns its version. */
  validateCli(): Promise<string> {
    return validateClaudeCli(this.runner, this.config.command, this.cwd,
      [...REQUIRED_FLAGS, ...(this.config.model ? ['--model'] : []), ...(this.config.finalize ? FINALIZE_FLAGS : [])], this.config.permissionMode);
  }

  async resumeSession(sessionId: string, started: boolean): Promise<void> {
    this.sessionId = sessionId;
    this.started = started;
  }

  getSessionId(): string | undefined { return this.sessionId; }
  isSessionStarted(): boolean { return this.started; }

  probe(_workingDirectory: string, signal?: AbortSignal): Promise<ProbeResult> {
    return probeClaudeModel(this.runner, this.config.command, this.cwd, this.config.model, signal);
  }

  async evaluateTurn(context: EvaluationContext, options: SupervisorCallOptions = {}): Promise<Review> {
    const value = await this.call(buildEvaluationPrompt(context, this.maxOutputChars), REVIEW_JSON_SCHEMA, options.signal);
    return this.validate(reviewSchema, value, 'review');
  }

  async interact(request: InteractionRequest, options: SupervisorCallOptions = {}): Promise<InteractionResult> {
    const value = await this.call(buildInteractionPrompt(request), INTERACTION_JSON_SCHEMA, options.signal);
    return this.validate(interactionSchema, value, 'interaction');
  }

  async finalize(request: FinalizeRequest, options: SupervisorCallOptions = {}): Promise<FinalizeResult> {
    const f = this.config.finalize;
    const extras: ClaudeCallExtras = { tools: f?.tools ?? [], allowedTools: f?.allowedTools ?? [], addDirs: this.finalizeDirs, timeoutSeconds: f?.timeoutSeconds ?? this.config.timeoutSeconds };
    const value = await this.call(buildFinalizePrompt(request, this.maxOutputChars), FINALIZE_JSON_SCHEMA, options.signal, extras);
    return this.validate(finalizeResultSchema, value, 'finalize');
  }

  private validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    return parseSupervisorOutput(schema, value, `Claude ${label}`);
  }

  buildArgs(schema: object, resume: boolean, extras?: ClaudeCallExtras): string[] {
    const args = ['--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
    args.push(...(resume ? ['--resume', this.sessionId!] : ['--session-id', this.sessionId!]));
    args.push('--append-system-prompt', [SUPERVISOR_SYSTEM_PROMPT, this.config.appendSystemPrompt].filter(Boolean).join('\n\n'));
    args.push('--tools', [...new Set([...this.config.tools, ...(extras?.tools ?? [])])].join(','));
    if (extras?.allowedTools.length) args.push('--allowedTools', ...extras.allowedTools);
    for (const dir of extras?.addDirs ?? []) args.push('--add-dir', dir);
    args.push('--permission-mode', this.config.permissionMode);
    if (this.config.model) args.push('--model', this.config.model);
    return args;
  }

  private async call(prompt: string, schema: object, signal?: AbortSignal, extras?: ClaudeCallExtras): Promise<unknown> {
    // The orchestrator serializes calls; this is a second line of defence.
    if (this.busy) throw new ColdPromptError('SESSION_LOCK', 'Concurrent write to the Claude supervisor conversation refused');
    this.busy = true;
    try {
      if (!this.sessionId) this.sessionId = randomUUID();
      let run = await this.invoke(prompt, schema, this.started, signal, extras);
      if (!this.started && run.code !== 0 && /already in use|already exists/i.test(run.stdout + run.stderr)) {
        // A previous call created the conversation but failed before we recorded it.
        run = await this.invoke(prompt, schema, true, signal, extras);
      }
      return this.parse(run);
    } finally {
      this.busy = false;
    }
  }

  private async invoke(prompt: string, schema: object, resume: boolean, signal?: AbortSignal, extras?: ClaudeCallExtras): Promise<RunResult> {
    try {
      return await this.runner(this.config.command, this.buildArgs(schema, resume, extras), {
        input: prompt, cwd: this.cwd, signal, timeoutMs: (extras?.timeoutSeconds ?? this.config.timeoutSeconds) * 1000
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new ColdPromptError('PERMANENT', `Failed to run Claude CLI: ${(error as Error).message}`);
    }
  }

  private parse(run: RunResult): unknown {
    let raw: unknown;
    try {
      raw = JSON.parse(run.stdout);
    } catch {
      const detail = redact((run.stderr || run.stdout).trim().slice(0, 1000));
      throw new Error(`Claude CLI exited ${run.code} without JSON output: ${detail}`);
    }
    const out = cliResultSchema.parse(raw);
    if (out.session_id) {
      // Claude accepted the prompt into this conversation.
      this.started = true;
      this.sessionId = out.session_id;
    }
    if (out.is_error || run.code !== 0 || (out.subtype && out.subtype !== 'success')) {
      throw new Error(`Claude CLI error (${out.subtype ?? 'unknown'}${out.api_error_status ? `, status ${out.api_error_status}` : ''}): ${redact((out.result ?? run.stderr).slice(0, 1000))}`);
    }
    if (out.structured_output !== undefined && out.structured_output !== null) return out.structured_output;
    // Fallback: the result must itself be strict JSON. Prose is never interpreted.
    try {
      return JSON.parse(out.result ?? '');
    } catch {
      throw new ColdPromptError('PERMANENT', 'Claude returned no structured output; prose is not accepted as a control decision');
    }
  }
}
