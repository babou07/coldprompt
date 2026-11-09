import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ColdPromptError, redact } from '../errors.js';
import type { ClaudeWorkerConfig, ProbeResult } from '../types.js';
import type { ExecuteTurnOptions, WorkerAdapter, WorkerProgress, WorkerSessionOptions, WorkerTurnResult } from '../worker.js';
import { probeClaudeModel, validateClaudeCli } from './claude.js';
import { spawnRunner, type CommandRunner } from './process.js';

/** Runs a command and hands each stdout line to onLine as it arrives. */
export type LineRunner = (
  command: string,
  args: string[],
  options: { input: string; cwd: string; signal: AbortSignal; onLine: (line: string) => Promise<void> }
) => Promise<{ code: number | null; stderr: string }>;

export const spawnLines: LineRunner = (command, args, { input, cwd, signal, onLine }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stderr = '';
    let queue = Promise.resolve();
    let lineError: unknown;
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < 20000) stderr += c.toString('utf8'); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      queue = queue.then(() => onLine(line)).catch((error) => { lineError ??= error; });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      void queue.then(() => (lineError ? reject(lineError) : resolve({ code, stderr })));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

/** Flags the worker relies on; checked against `claude --help` of the installed CLI. */
export const WORKER_FLAGS = ['--print', '--output-format', '--verbose', '--resume', '--session-id', '--permission-mode', '--tools', '--allowedTools'];

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);
const firstLine = (text: string): string => clip(text.trim().split('\n')[0] ?? '', 200);
const asText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' && 'text' in v ? String((v as { text: unknown }).text) : asText(v))).join('\n');
  try { return JSON.stringify(value); } catch { return String(value); }
};

const FILE_TOOLS: Record<string, string> = { Edit: 'update', MultiEdit: 'update', NotebookEdit: 'update', Write: 'write' };

interface ToolUse { name: string; input: Record<string, unknown> }

/** Display record for a Claude tool call (started) or its result (completed). */
export function describeToolUse(use: ToolUse, phase: 'started' | 'completed', result?: { text: string; isError: boolean }): WorkerProgress | undefined {
  const status = phase === 'started' ? 'in_progress' : result?.isError ? 'failed' : 'completed';
  const input = use.input ?? {};
  if (use.name === 'Bash') {
    return { phase, kind: 'command', summary: clip(String(input.command ?? ''), 300), status, detail: result ? clip(result.text, 2000) : undefined };
  }
  if (use.name in FILE_TOOLS) {
    if (phase === 'started') return undefined;
    return { phase, kind: 'file_change', summary: `${FILE_TOOLS[use.name]} ${String(input.file_path ?? input.notebook_path ?? '?')}`, status, detail: result?.isError ? clip(result.text, 1000) : undefined };
  }
  if (use.name === 'TodoWrite') {
    if (phase === 'completed') return undefined;
    const todos = Array.isArray(input.todos) ? input.todos as Array<{ content?: string; status?: string }> : [];
    return {
      phase: 'updated', kind: 'plan', summary: `${todos.filter((t) => t.status === 'completed').length}/${todos.length} steps done`,
      detail: todos.map((t) => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content ?? ''}`).join('\n')
    };
  }
  if (use.name === 'WebSearch') {
    return phase === 'started' ? { phase, kind: 'web_search', summary: clip(String(input.query ?? ''), 300) } : undefined;
  }
  return {
    phase, kind: 'tool', summary: use.name.startsWith('mcp__') ? use.name.slice(5).replace('__', '.') : use.name, status,
    detail: phase === 'started' ? clip(asText(input), 600) : clip(result?.text ?? '', 1500)
  };
}

/**
 * Claude Code as worker, through `claude --print --output-format stream-json`.
 * One Claude conversation per ColdPrompt session: the first turn creates it
 * with --session-id, later turns --resume it.
 *
 * Permissions follow the user's Claude Code settings unless permissionMode /
 * tools / allowedTools are configured. A read-only mission only gets
 * readOnlyTools (Read, Grep, Glob by default) in dontAsk mode.
 */
export class ClaudeWorkerAdapter implements WorkerAdapter {
  readonly provider = 'claude';
  private sessionId?: string;
  private started = false;
  private options?: WorkerSessionOptions;
  private active?: AbortController;

  constructor(
    private readonly config: ClaudeWorkerConfig,
    private readonly run: LineRunner = spawnLines,
    private readonly runner: CommandRunner = spawnRunner
  ) {}

  validateCli(cwd: string): Promise<string> {
    const flags = [...WORKER_FLAGS, ...(this.config.appendSystemPrompt ? ['--append-system-prompt'] : []), ...(this.config.model ? ['--model'] : [])];
    return validateClaudeCli(this.runner, this.config.command, cwd, flags, this.config.permissionMode);
  }

  probe(workingDirectory: string, signal?: AbortSignal): Promise<ProbeResult> {
    return probeClaudeModel(this.runner, this.config.command, workingDirectory, this.config.model, signal);
  }

  private assertIdle(action: string): void {
    if (this.active) {
      throw new ColdPromptError('SESSION_LOCK', `Cannot ${action}: a Claude turn is already running on session ${this.sessionId ?? '(new)'}; two writers on one conversation are not allowed.`);
    }
  }

  async startSession(options: WorkerSessionOptions): Promise<void> {
    this.assertIdle('start a session');
    this.options = options;
    this.sessionId = undefined;
    this.started = false;
  }

  async resumeSession(sessionId: string, options: WorkerSessionOptions): Promise<void> {
    this.assertIdle('resume a session');
    this.options = options;
    this.sessionId = sessionId;
    this.started = true;
  }

  getSessionId(): string | undefined {
    return this.started ? this.sessionId : undefined;
  }

  buildArgs(resume: boolean): string[] {
    const readOnly = this.options?.readOnly ?? false;
    const args = ['--print', '--output-format', 'stream-json', '--verbose'];
    args.push(...(resume ? ['--resume', this.sessionId!] : ['--session-id', this.sessionId!]));
    if (readOnly) {
      args.push('--tools', this.config.readOnlyTools.join(','), '--permission-mode', 'dontAsk');
    } else {
      if (this.config.tools) args.push('--tools', this.config.tools.join(','));
      if (this.config.permissionMode) args.push('--permission-mode', this.config.permissionMode);
      if (this.config.allowedTools?.length) args.push('--allowedTools', ...this.config.allowedTools);
    }
    if (this.config.model) args.push('--model', this.config.model);
    if (this.config.appendSystemPrompt) args.push('--append-system-prompt', this.config.appendSystemPrompt);
    return args;
  }

  async executeTurn(input: string, options: ExecuteTurnOptions = {}): Promise<WorkerTurnResult> {
    if (!this.options) throw new ColdPromptError('PERMANENT', 'No Claude session bound: call startSession or resumeSession first');
    this.assertIdle('execute a turn');
    const controller = new AbortController();
    this.active = controller;
    const signals = [controller.signal, ...(options.signal ? [options.signal] : [])];
    const timeout = this.config.turnTimeoutSeconds ? AbortSignal.timeout(this.config.turnTimeoutSeconds * 1000) : undefined;
    if (timeout) signals.push(timeout);
    const signal = AbortSignal.any(signals);
    try {
      if (!this.sessionId) this.sessionId = randomUUID();
      try {
        return await this.turn(input, this.started, signal, options);
      } catch (error) {
        // A previous attempt created the conversation but failed before init was seen.
        if (!this.started && !signal.aborted && /already in use|already exists/i.test((error as Error).message)) {
          this.started = true;
          await options.onSessionId?.(this.sessionId);
          return await this.turn(input, true, signal, options);
        }
        throw error;
      }
    } catch (error) {
      if (timeout?.aborted && !options.signal?.aborted && !controller.signal.aborted) throw new Error(`Claude worker turn timed out after ${this.config.turnTimeoutSeconds}s`);
      if (signal.aborted) throw Object.assign(new Error('Claude turn aborted'), { name: 'AbortError', cause: error });
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  private async turn(input: string, resume: boolean, signal: AbortSignal, options: ExecuteTurnOptions): Promise<WorkerTurnResult> {
    const result: WorkerTurnResult = { sessionId: this.getSessionId(), finalResponse: '', commands: [], fileChanges: [], errors: [] };
    const uses = new Map<string, ToolUse>();
    let lastText = '';
    let final: Record<string, any> | undefined;
    const progress = async (p: WorkerProgress | undefined) => {
      if (p && options.onProgress) { try { await options.onProgress(p); } catch { /* display only */ } }
    };

    const onLine = async (line: string) => {
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { return; }
      switch (event.type) {
        case 'system':
          if (event.subtype === 'init' && typeof event.session_id === 'string') {
            const fresh = !this.started || event.session_id !== this.sessionId;
            this.sessionId = event.session_id;
            this.started = true;
            result.sessionId = event.session_id;
            if (fresh) await options.onSessionId?.(event.session_id);
          }
          break;
        case 'assistant':
          for (const block of event.message?.content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              lastText = block.text;
              await progress({ phase: 'completed', kind: 'message', summary: firstLine(block.text), detail: clip(block.text, 4000) });
            } else if (block.type === 'thinking' && block.thinking?.trim()) {
              await progress({ phase: 'completed', kind: 'reasoning', summary: firstLine(block.thinking), detail: clip(block.thinking, 1500) });
            } else if (block.type === 'tool_use') {
              const use = { name: String(block.name), input: block.input ?? {} };
              uses.set(block.id, use);
              await progress(describeToolUse(use, 'started'));
            }
          }
          break;
        case 'user':
          for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
            if (block.type !== 'tool_result') continue;
            const use = uses.get(block.tool_use_id);
            if (!use) continue;
            const isError = block.is_error === true;
            const text = asText(block.content);
            if (use.name === 'Bash') result.commands.push({ command: String(use.input.command ?? ''), status: isError ? 'failed' : 'completed' });
            if (use.name in FILE_TOOLS && !isError) {
              result.fileChanges.push({ path: String(use.input.file_path ?? use.input.notebook_path ?? '?'), kind: FILE_TOOLS[use.name] });
            }
            await progress(describeToolUse(use, 'completed', { text, isError }));
          }
          break;
        case 'result':
          final = event;
          break;
        default:
          break;
      }
    };

    const run = await this.run(this.config.command, this.buildArgs(resume), { input, cwd: this.options!.workingDirectory, signal, onLine });
    if (!final) {
      throw new Error(`Claude CLI exited ${run.code} without a result: ${redact(run.stderr.trim().slice(0, 1000))}`);
    }
    if (typeof final.session_id === 'string') { this.sessionId = final.session_id; this.started = true; }
    result.sessionId = this.getSessionId();
    const usage = final.usage ?? {};
    result.usage = {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0
    };
    for (const denial of Array.isArray(final.permission_denials) ? final.permission_denials : []) {
      result.errors.push(`permission denied: ${denial.tool_name ?? 'tool'}${denial.tool_input?.command ? ` (${clip(String(denial.tool_input.command), 200)})` : ''}`);
    }
    if (final.is_error || (final.subtype && final.subtype !== 'success')) {
      const status = final.api_error_status ? `, status ${final.api_error_status}` : '';
      throw new Error(`Claude worker turn failed (${final.subtype ?? 'error'}${status}): ${redact(String(final.result ?? run.stderr).slice(0, 1000))}`);
    }
    result.finalResponse = typeof final.result === 'string' && final.result ? final.result : lastText;
    return result;
  }

  async cancel(): Promise<void> {
    this.active?.abort();
  }
}
