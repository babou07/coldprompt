import { createConnection, type Socket } from 'node:net';
import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { CommandRequest, CommandResponse } from '../orchestrator.js';
import type { State } from '../types.js';
import { parseCommandLine, type ServerMessage } from './protocol.js';

/** Thin protocol client. It never talks to Claude or Codex directly. */
export class ConsoleClient {
  private socket?: Socket;
  private buffer = '';
  private readonly waiting = new Map<string, (r: CommandResponse) => void>();
  onMessage: (message: ServerMessage) => void = () => undefined;
  onClose: () => void = () => undefined;

  constructor(readonly socketPath: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.once('connect', () => { this.socket = socket; resolve(); });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? Object.assign(new Error(`No orchestrator is listening on ${this.socketPath} (is "coldprompt run" running with the same COLDPROMPT_HOME?)`), { code: error.code })
          : error);
      });
      socket.on('data', (chunk) => this.receive(chunk.toString('utf8')));
      socket.on('close', () => {
        this.socket = undefined;
        for (const resolveWaiting of this.waiting.values()) resolveWaiting({ ok: false, error: 'Connection closed' });
        this.waiting.clear();
        this.onClose();
      });
    });
  }

  get connected(): boolean { return Boolean(this.socket && !this.socket.destroyed); }

  private receive(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: ServerMessage;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === 'response') {
        const resolveWaiting = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        resolveWaiting?.(message);
      }
      this.onMessage(message);
    }
  }

  send(request: CommandRequest): Promise<CommandResponse> {
    if (!this.socket) return Promise.resolve({ ok: false, error: 'Not connected' });
    const id = randomUUID();
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.socket!.write(JSON.stringify({ id, ...request }) + '\n');
    });
  }

  close(): void {
    this.socket?.end();
  }
}

function indent(text: string): string {
  return text.split('\n').map((l) => `  ${l}`).join('\n');
}

export function formatStatus(data: any): string {
  if (!data || typeof data !== 'object') return String(data);
  const lines = [
    `status: ${data.status}${data.stopping ? ' (stopping)' : ''}${data.pauseRequested ? ' (pause requested)' : ''}`,
    ...(data.session ? [`session: ${data.session.index}/${data.session.of} ${data.session.id}${data.session.title ? ` — ${data.session.title}` : ''}`] : []),
    `mission: ${data.mission ? `${data.mission.inSession ? `${data.mission.inSession}/${data.mission.ofSession} in session, ` : ''}${data.mission.index}/${data.mission.of} overall: ${data.mission.id} — ${data.mission.title}` : '(none)'}`,
    `turns: mission ${data.missionTurns}, total ${data.totalTurns}`,
    `worker thread: ${data.workerThreadId ?? '(new)'}  supervisor session: ${data.supervisorSessionId ?? '(new)'}`
  ];
  if (data.pendingTurn) lines.push(`active turn: ${data.pendingTurn.turnId} (${data.pendingTurn.phase})`);
  if (data.blocked) lines.push(`BLOCKED [${data.blocked.kind}] since ${data.blocked.at}:`, indent(data.blocked.reason));
  if (data.lastDecision) lines.push(`last decision: ${data.lastDecision} — ${data.lastReason ?? ''}`);
  for (const d of data.proposedDirectives ?? []) lines.push(`proposed directive ${d.id} (needs approve):`, indent(d.content));
  for (const d of data.approvedDirectives ?? []) lines.push(`approved directive ${d.id} (next boundary):`, indent(d.content));
  if (data.queuedHotPrompts) lines.push(`queued HOT_PROMPTs: ${data.queuedHotPrompts}`);
  if (data.retry) lines.push(`retry: ${data.retry.kind} attempt ${data.retry.attempt}: ${data.retry.message}`);
  if (data.lastError) lines.push(`last error: ${data.lastError.kind}: ${data.lastError.message}`);
  if (data.git?.isRepo) lines.push(`git: ${data.git.branch}@${String(data.git.head).slice(0, 10)} ${data.git.dirty ? `dirty(${data.git.changedFiles})` : 'clean'}${data.git.upstream ? ` ahead ${data.git.ahead} behind ${data.git.behind}` : ''}`);
  return lines.join('\n');
}

/** Status text from the saved state, when no orchestrator is running. */
export function formatPersistedState(state: State): string {
  return ['(orchestrator not running; persisted state)', formatStatus({
    status: state.status, mission: null, missionTurns: state.missionTurns, totalTurns: state.totalTurns,
    workerThreadId: state.activeMissionId ? state.sessions[state.missions[state.activeMissionId]?.session ?? '']?.workerThreadId : undefined,
    supervisorSessionId: state.supervisorSessionId,
    pendingTurn: state.pendingTurn, blocked: state.blocked, lastDecision: state.lastDecision, lastReason: state.lastReview?.reason,
    queuedHotPrompts: state.hotPrompts.filter((h) => h.status === 'QUEUED' || h.status === 'PROCESSING').length,
    lastError: state.lastError, git: state.lastGit
  }), `mission index: ${state.missionIndex}, active mission: ${state.activeMissionId ?? '(none)'}`].join('\n');
}

export function formatEvent(event: { type: string; data: any }): string | undefined {
  const d = event.data ?? {};
  switch (event.type) {
    case 'hot_prompt.answered':
      return `\n[answer ${d.id}]\n${indent(d.answer)}${d.proposedDirectiveId ? `\n[proposed directive ${d.proposedDirectiveId}] (approve ${d.proposedDirectiveId} to deliver)\n${indent(d.proposedDirective)}` : ''}`;
    case 'hot_prompt.failed': return `[hot prompt ${d.id} failed] ${d.message}`;
    case 'runtime.blocked': return `\n[BLOCKED ${d.kind}] ${d.reason}\n  -> ask <question> | tell <directive> | resume <resolution>`;
    case 'runtime.failed': return `\n[FAILED ${d.kind}] ${d.reason}\n  -> resume <resolution> | stop`;
    case 'review.completed': return `[review ${d.turnId}] ${d.decision}: ${d.reason}`;
    case 'turn.started': return `[turn ${d.turnId}] started (${d.source})`;
    case 'turn.completed': return `[turn ${d.turnId}] completed${d.commits?.length ? `, ${d.commits.length} commit(s)` : ''}`;
    case 'turn.retry': return `[retry] ${d.kind} attempt ${d.attempt} in ${d.delaySeconds}s`;
    case 'session.started': return `[session ${d.sessionId}] started`;
    case 'session.completed': return `[session ${d.sessionId}] completed`;
    case 'mission.started': return `[mission ${d.missionId}] started`;
    case 'mission.completed': return `[mission ${d.missionId}] completed`;
    case 'mission.completion_rejected': return `[mission ${d.missionId}] completion rejected by: ${d.failed.join(', ')}`;
    case 'runtime.paused': return '[paused]';
    case 'runtime.resumed': return '[resumed]';
    case 'runtime.completed': return '[all missions completed]';
    case 'run.finished': return `[orchestrator finished: ${d.status}]`;
    default: return undefined;
  }
}

function formatResponse(request: CommandRequest, response: CommandResponse): string {
  if (!response.ok) return `error: ${response.error}`;
  const data = response.data as any;
  if (request.command === 'status') return formatStatus(data);
  if (request.command === 'help') return String(data);
  if (request.command === 'directives') {
    const list = data as any[];
    return list.length ? list.map((d) => `${d.id} [${d.status}] (${d.author}) ${d.content}`).join('\n') : '(no directives)';
  }
  return data?.message ? `${data.message}${data.hotPromptId ? ` [${data.hotPromptId}]` : ''}${data.directiveId ? ` [${data.directiveId}]` : ''}` : JSON.stringify(data);
}

export interface InteractiveOptions {
  input?: Readable;
  output?: Writable;
  reconnectDelayMs?: number;
}

/** Line-oriented REPL suitable for SSH/Termux. Reconnects automatically. */
export async function runInteractiveConsole(socketPath: string, options: InteractiveOptions = {}): Promise<void> {
  const output = options.output ?? process.stdout;
  const write = (text: string) => output.write(text + '\n');
  const rl: Interface = createInterface({ input: options.input ?? process.stdin, output, prompt: 'coldprompt> ', terminal: (options.input ?? process.stdin) === process.stdin && process.stdin.isTTY });
  let client = new ConsoleClient(socketPath);
  let closing = false;

  const attach = async (): Promise<void> => {
    for (let attempt = 0; !closing; attempt += 1) {
      const candidate = new ConsoleClient(socketPath);
      candidate.onMessage = (message) => {
        if (message.type === 'hello') { write(formatStatus(message.status)); rl.prompt(); }
        if (message.type === 'event') {
          const text = formatEvent(message.event);
          if (text) { write(text); rl.prompt(true); }
        }
      };
      // Only an established connection starts a new reconnect loop; a failed
      // attempt is retried by this loop (one loop, one connection). Otherwise
      // each failed attempt added a loop, and they all connected at once.
      let established = false;
      candidate.onClose = () => {
        if (closing || !established || client !== candidate) return;
        write('[disconnected; reconnecting…]');
        void attach();
      };
      try {
        await candidate.connect();
        established = true;
        client = candidate;
        return;
      } catch (error) {
        if (attempt === 0) write(`[cannot connect to ${socketPath}: ${(error as Error).message}; retrying…]`);
        await new Promise((r) => setTimeout(r, Math.min(options.reconnectDelayMs ?? 1000 * 2 ** Math.min(attempt, 4), 15000)));
      }
    }
  };

  await attach();
  write('Type "help" for commands, "quit" to leave the console (the orchestrator keeps running).');
  rl.prompt();
  for await (const line of rl) {
    const request = parseCommandLine(line);
    if (!request) { rl.prompt(); continue; }
    if (request.command === 'quit' || request.command === 'exit') break;
    if (!client.connected) { write('error: not connected (reconnecting)'); rl.prompt(); continue; }
    write(formatResponse(request, await client.send(request)));
    rl.prompt();
  }
  closing = true;
  client.close();
  rl.close();
}

/**
 * Non-interactive single command (scripts, `ssh host coldprompt send status`).
 * For ask/tell it waits for the supervisor answer unless waitMs is 0.
 */
export async function sendOnce(socketPath: string, request: CommandRequest, waitMs = 600_000): Promise<{ response: CommandResponse; text: string }> {
  const client = new ConsoleClient(socketPath);
  // Answers may arrive before the command acknowledgement: buffer them by id.
  const answers = new Map<string, string>();
  let hotPromptId: string | undefined;
  let answered: () => void = () => undefined;
  const done = new Promise<void>((r) => { answered = r; });
  client.onMessage = (message) => {
    if (message.type !== 'event') return;
    const d = message.event.data as any;
    if (message.event.type === 'hot_prompt.answered' || message.event.type === 'hot_prompt.failed') {
      answers.set(d?.id, formatEvent(message.event) ?? '');
      if (d?.id === hotPromptId) answered();
    }
  };
  await client.connect();
  try {
    const response = await client.send(request);
    let text = formatResponse(request, response);
    hotPromptId = (response.data as any)?.hotPromptId;
    if (response.ok && hotPromptId && waitMs > 0) {
      if (!answers.has(hotPromptId)) await Promise.race([done, new Promise((r) => setTimeout(r, waitMs).unref())]);
      text += answers.get(hotPromptId) ?? `\n(no answer yet; check later with "status")`;
    }
    return { response, text };
  } finally {
    client.close();
  }
}
