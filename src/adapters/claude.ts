import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ColdPromptError, redact } from '../errors.js';
import {
  buildEvaluationPrompt, buildInteractionPrompt, SUPERVISOR_SYSTEM_PROMPT,
  type EvaluationContext, type InteractionRequest, type SupervisorAdapter, type SupervisorCallOptions
} from '../supervisor.js';
import { DECISIONS, interactionSchema, reviewSchema, type Config, type InteractionResult, type Review } from '../types.js';

export interface RunResult { code: number | null; stdout: string; stderr: string }

export type CommandRunner = (
  command: string,
  args: string[],
  options: { input?: string; cwd: string; signal?: AbortSignal; timeoutMs: number }
) => Promise<RunResult>;

export const spawnRunner: CommandRunner = (command, args, { input, cwd, signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });

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

/** Flags this adapter relies on; checked against `claude --help` of the installed CLI. */
export const REQUIRED_FLAGS = ['--print', '--output-format', '--json-schema', '--resume', '--session-id', '--append-system-prompt', '--tools', '--permission-mode'];

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
    private readonly config: Config['supervisor'],
    private readonly cwd: string,
    private readonly runner: CommandRunner = spawnRunner,
    private readonly maxOutputChars = 20000
  ) {}

  /** Validates that the installed CLI supports every option we pass. Returns its version. */
  async validateCli(): Promise<string> {
    const opts = { cwd: this.cwd, timeoutMs: 30_000 };
    let version: RunResult;
    let help: RunResult;
    try {
      version = await this.runner(this.config.command, ['--version'], opts);
      help = await this.runner(this.config.command, ['--help'], opts);
    } catch (error) {
      throw new ColdPromptError('INVALID_CONFIG', `Cannot run Claude CLI "${this.config.command}": ${(error as Error).message}`);
    }
    if (version.code !== 0) throw new ColdPromptError('INVALID_CONFIG', `"${this.config.command} --version" failed: ${version.stderr.trim()}`);
    const text = help.stdout + help.stderr;
    const flags = [...REQUIRED_FLAGS, ...(this.config.model ? ['--model'] : [])];
    const missing = flags.filter((flag) => !text.includes(flag));
    if (missing.length) {
      throw new ColdPromptError('INVALID_CONFIG', `Installed Claude CLI (${version.stdout.trim()}) lacks required options: ${missing.join(', ')}`);
    }
    const modes = text.match(/--permission-mode[\s\S]*?\(choices:([^)]*)\)/);
    if (modes && !modes[1].includes(`"${this.config.permissionMode}"`)) {
      throw new ColdPromptError('INVALID_CONFIG', `Claude CLI does not support permission mode "${this.config.permissionMode}" (choices:${modes[1]})`);
    }
    return version.stdout.trim();
  }

  async resumeSession(sessionId: string, started: boolean): Promise<void> {
    this.sessionId = sessionId;
    this.started = started;
  }

  getSessionId(): string | undefined { return this.sessionId; }
  isSessionStarted(): boolean { return this.started; }

  async evaluateTurn(context: EvaluationContext, options: SupervisorCallOptions = {}): Promise<Review> {
    const value = await this.call(buildEvaluationPrompt(context, this.maxOutputChars), REVIEW_JSON_SCHEMA, options.signal);
    return this.validate(reviewSchema, value, 'review');
  }

  async interact(request: InteractionRequest, options: SupervisorCallOptions = {}): Promise<InteractionResult> {
    const value = await this.call(buildInteractionPrompt(request), INTERACTION_JSON_SCHEMA, options.signal);
    return this.validate(interactionSchema, value, 'interaction');
  }

  private validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ColdPromptError('PERMANENT', `Claude ${label} output does not match the schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  }

  buildArgs(schema: object, resume: boolean): string[] {
    const args = ['--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
    args.push(...(resume ? ['--resume', this.sessionId!] : ['--session-id', this.sessionId!]));
    args.push('--append-system-prompt', [SUPERVISOR_SYSTEM_PROMPT, this.config.appendSystemPrompt].filter(Boolean).join('\n\n'));
    args.push('--tools', this.config.tools.join(','));
    args.push('--permission-mode', this.config.permissionMode);
    if (this.config.model) args.push('--model', this.config.model);
    return args;
  }

  private async call(prompt: string, schema: object, signal?: AbortSignal): Promise<unknown> {
    // The orchestrator serializes calls; this is a second line of defence.
    if (this.busy) throw new ColdPromptError('SESSION_LOCK', 'Concurrent write to the Claude supervisor conversation refused');
    this.busy = true;
    try {
      if (!this.sessionId) this.sessionId = randomUUID();
      let run = await this.invoke(prompt, schema, this.started, signal);
      if (!this.started && run.code !== 0 && /already in use|already exists/i.test(run.stdout + run.stderr)) {
        // A previous call created the conversation but failed before we recorded it.
        run = await this.invoke(prompt, schema, true, signal);
      }
      return this.parse(run);
    } finally {
      this.busy = false;
    }
  }

  private async invoke(prompt: string, schema: object, resume: boolean, signal?: AbortSignal): Promise<RunResult> {
    try {
      return await this.runner(this.config.command, this.buildArgs(schema, resume), {
        input: prompt, cwd: this.cwd, signal, timeoutMs: this.config.timeoutSeconds * 1000
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
