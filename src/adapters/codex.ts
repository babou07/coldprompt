import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Codex, type ThreadEvent, type ThreadItem, type ThreadOptions, type TurnOptions } from '@openai/codex-sdk';
import { ColdPromptError, errorMessage } from '../errors.js';
import type { CodexWorkerConfig, ProbeResult } from '../types.js';
import { spawnRunner, type CommandRunner } from './process.js';
import type { ProviderCheck } from './registry.js';
import type { ExecuteTurnOptions, WorkerAdapter, WorkerProgress, WorkerSessionOptions, WorkerTurnResult } from '../worker.js';

/** The subset of the Codex SDK the adapter uses (injectable for tests). */
export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: string, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

export interface CodexLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);
const firstLine = (text: string): string => clip(text.trim().split('\n')[0] ?? '', 200);
const asText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

/**
 * Turns a Codex stream item into a short display record. Started/updated
 * records are only emitted where they say something new (a command or tool
 * starting, a plan update), to keep the event log small.
 */
export function describeItem(item: ThreadItem, phase: WorkerProgress['phase']): WorkerProgress | undefined {
  switch (item.type) {
    case 'command_execution':
      if (phase === 'updated') return undefined;
      return {
        phase, kind: 'command', summary: clip(item.command, 300), status: item.status,
        detail: phase === 'completed' ? clip(`${item.aggregated_output ?? ''}${item.exit_code !== undefined ? `\n[exit ${item.exit_code}]` : ''}`.trim(), 2000) : undefined
      };
    case 'mcp_tool_call':
      if (phase === 'updated') return undefined;
      return {
        phase, kind: 'tool', summary: `${item.server}.${item.tool}`, status: item.status,
        detail: phase === 'started'
          ? clip(asText(item.arguments), 600)
          : clip(item.error ? `error: ${item.error.message}` : asText(item.result?.structured_content ?? item.result?.content), 1500)
      };
    case 'file_change':
      if (phase !== 'completed') return undefined;
      return { phase, kind: 'file_change', summary: item.changes.map((c) => `${c.kind} ${c.path}`).join(', '), status: item.status };
    case 'agent_message':
      if (phase !== 'completed') return undefined;
      return { phase, kind: 'message', summary: firstLine(item.text), detail: clip(item.text, 4000) };
    case 'reasoning':
      if (phase !== 'completed' || !item.text.trim()) return undefined;
      return { phase, kind: 'reasoning', summary: firstLine(item.text), detail: clip(item.text, 1500) };
    case 'todo_list':
      if (phase === 'started') return undefined;
      return {
        phase, kind: 'plan',
        summary: `${item.items.filter((t) => t.completed).length}/${item.items.length} steps done`,
        detail: item.items.map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n')
      };
    case 'web_search':
      if (phase !== 'started') return undefined;
      return { phase, kind: 'web_search', summary: clip(item.query, 300) };
    case 'error':
      return { phase, kind: 'error', summary: firstLine(item.message), detail: clip(item.message, 1500) };
    default:
      return undefined;
  }
}

export function createCodex(codexPath?: string): CodexLike {
  return new Codex(codexPath ? { codexPathOverride: codexPath } : {});
}

/** Mirrors @openai/codex-sdk's default binary resolution (vendored per platform). */
export function bundledCodexPath(): string {
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
  const sdkEntry = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
  return join(dirname(sdkEntry), '..', 'vendor', triple, 'codex', 'codex');
}

/** Doctor checks for the Codex binary the SDK will run. */
export async function checkCodexBinary(codexPath: string | undefined, role: string): Promise<ProviderCheck[]> {
  const version = async (bin: string) => (await promisify(execFile)(bin, ['--version'])).stdout.trim();
  const binary = codexPath ?? bundledCodexPath();
  try {
    const used = await version(binary);
    const checks: ProviderCheck[] = [{ level: 'ok', message: `${role}: Codex used by the SDK: ${binary} (${used})` }];
    const system = await version('codex').catch(() => undefined);
    if (!codexPath && system && system !== used) {
      checks.push({ level: 'warn', message: `${role}: your PATH codex is ${system} but the SDK runs its bundled ${used}; set codexPath to use yours (config compatibility, thread resume)` });
    }
    return checks;
  } catch (error) {
    return [{ level: 'fail', message: `${role}: Codex CLI not runnable (${binary}): ${errorMessage(error)}` }];
  }
}

const ephemeralSupport = new Map<string, Promise<boolean>>();

export interface CodexProbeOptions {
  codexPath?: string;
  model?: string | null;
  reasoningEffort?: string;
  workingDirectory: string;
  signal?: AbortSignal;
  runner?: CommandRunner;
}

/**
 * Proves that the configured model answers with the Codex binary the SDK
 * uses: one tiny `codex exec` in a read-only sandbox (ephemeral when the
 * binary supports it). Returns the configured model (Codex does not report it).
 */
export async function probeCodexModel(options: CodexProbeOptions): Promise<ProbeResult> {
  const run = options.runner ?? spawnRunner;
  const binary = options.codexPath ?? bundledCodexPath();
  const cwd = options.workingDirectory;
  if (!ephemeralSupport.has(binary)) {
    ephemeralSupport.set(binary, run(binary, ['exec', '--help'], { cwd, timeoutMs: 30_000 }).then((r) => r.stdout.includes('--ephemeral'), () => false));
  }
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
  if (await ephemeralSupport.get(binary)) args.push('--ephemeral');
  if (options.model) args.push('--model', options.model);
  if (options.reasoningEffort) args.push('-c', `model_reasoning_effort="${options.reasoningEffort}"`);
  args.push('-');
  const out = await run(binary, args, { input: 'Reply with OK only.', cwd, signal: options.signal, timeoutMs: 180_000 });
  const errors: string[] = [];
  for (const line of out.stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: string; error?: { message?: string } };
      if (event.type === 'error' && event.message) errors.push(event.message);
      if (event.type === 'turn.failed' && event.error?.message) errors.push(event.error.message);
    } catch { /* not JSON */ }
  }
  if (out.code !== 0 || errors.length) {
    const message = [...new Set(errors)].join('; ') || out.stderr.trim().split('\n').slice(-3).join(' ');
    throw new Error(message.slice(0, 500) || `codex exited ${out.code}`);
  }
  return { model: options.model ?? undefined };
}

export class CodexWorkerAdapter implements WorkerAdapter {
  readonly provider = 'codex';
  private readonly codex: CodexLike;
  private thread?: CodexThreadLike;
  private sessionId?: string;
  private active?: AbortController;

  constructor(private readonly config: CodexWorkerConfig, codex?: CodexLike) {
    this.codex = codex ?? createCodex(config.codexPath);
  }

  /**
   * sandboxMode/approvalPolicy are only passed when configured, so the user's
   * Codex profile (e.g. writable .git) is inherited. Read-only sessions force
   * the read-only sandbox.
   */
  threadOptions(options: WorkerSessionOptions): ThreadOptions {
    const out: ThreadOptions = { workingDirectory: options.workingDirectory };
    if (this.config.model) out.model = this.config.model;
    const sandbox = options.readOnly ? 'read-only' : this.config.sandboxMode;
    if (sandbox) out.sandboxMode = sandbox;
    if (this.config.approvalPolicy) out.approvalPolicy = this.config.approvalPolicy;
    if (this.config.reasoningEffort) out.modelReasoningEffort = this.config.reasoningEffort;
    if (this.config.skipGitRepoCheck) out.skipGitRepoCheck = true;
    return out;
  }

  private assertIdle(action: string): void {
    if (this.active) {
      throw new ColdPromptError('SESSION_LOCK', `Cannot ${action}: a Codex turn is already running on thread ${this.sessionId ?? '(new)'}; two writers on one thread are not allowed.`);
    }
  }

  async startSession(options: WorkerSessionOptions): Promise<void> {
    this.assertIdle('start a session');
    this.thread = this.codex.startThread(this.threadOptions(options));
    this.sessionId = undefined;
  }

  async resumeSession(sessionId: string, options: WorkerSessionOptions): Promise<void> {
    this.assertIdle('resume a session');
    this.thread = this.codex.resumeThread(sessionId, this.threadOptions(options));
    this.sessionId = sessionId;
  }

  async executeTurn(input: string, options: ExecuteTurnOptions = {}): Promise<WorkerTurnResult> {
    if (!this.thread) throw new ColdPromptError('PERMANENT', 'No Codex thread bound: call startSession or resumeSession first');
    this.assertIdle('execute a turn');
    const controller = new AbortController();
    this.active = controller;
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const result: WorkerTurnResult = { sessionId: this.sessionId, finalResponse: '', commands: [], fileChanges: [], errors: [] };
    try {
      const { events } = await this.thread.runStreamed(input, { signal });
      for await (const event of events) {
        switch (event.type) {
          case 'thread.started':
            this.sessionId = event.thread_id;
            result.sessionId = event.thread_id;
            await options.onSessionId?.(event.thread_id);
            break;
          case 'item.started':
          case 'item.updated':
          case 'item.completed': {
            if (event.type === 'item.completed') this.collect(result, event.item);
            const progress = describeItem(event.item, event.type === 'item.started' ? 'started' : event.type === 'item.updated' ? 'updated' : 'completed');
            if (progress && options.onProgress) {
              try { await options.onProgress(progress); } catch { /* display only */ }
            }
            break;
          }
          case 'turn.completed':
            result.usage = {
              inputTokens: event.usage.input_tokens,
              cachedInputTokens: event.usage.cached_input_tokens,
              outputTokens: event.usage.output_tokens
            };
            break;
          case 'turn.failed':
            throw new Error(`Codex turn failed: ${event.error.message}`);
          case 'error':
            throw new Error(`Codex stream error: ${event.message}`);
          default:
            break;
        }
      }
      result.sessionId = this.thread.id ?? this.sessionId;
      this.sessionId = result.sessionId;
      return result;
    } catch (error) {
      this.sessionId = this.thread.id ?? this.sessionId;
      if (signal.aborted) throw Object.assign(new Error('Codex turn aborted'), { name: 'AbortError', cause: error });
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  private collect(result: WorkerTurnResult, item: ThreadItem): void {
    switch (item.type) {
      case 'agent_message':
        result.finalResponse = item.text;
        break;
      case 'command_execution':
        result.commands.push({ command: item.command, exitCode: item.exit_code, status: item.status });
        break;
      case 'file_change':
        if (item.status === 'completed') result.fileChanges.push(...item.changes.map((c) => ({ path: c.path, kind: c.kind })));
        break;
      case 'error':
        result.errors.push(item.message);
        break;
      default:
        break;
    }
  }

  async cancel(): Promise<void> {
    this.active?.abort();
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  probe(workingDirectory: string, signal?: AbortSignal): Promise<ProbeResult> {
    return probeCodexModel({ codexPath: this.config.codexPath, model: this.config.model, reasoningEffort: this.config.reasoningEffort, workingDirectory, signal });
  }
}
