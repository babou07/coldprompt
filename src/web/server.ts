import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { ConsoleClient } from '../console/client.js';
import type { ServerMessage } from '../console/protocol.js';
import type { CommandRequest, CommandResponse, OrchestratorEvent } from '../orchestrator.js';
import type { Store } from '../store.js';
import { APP_CSS, APP_JS, PAGE_HTML } from './page.js';

/** Commands the page may send. Everything goes through the orchestrator's own validation. */
const ALLOWED_COMMANDS = new Set(['status', 'directives', 'ask', 'tell', 'approve', 'reject', 'pause', 'resume', 'stop']);
const HISTORY_EVENTS = 400;
const MAX_BODY_BYTES = 64 * 1024;
const TURN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface WebServerOptions {
  store: Store;
  socketPath: string;
  host: string;
  port: number;
  token: string;
  projectName: string;
  /** Starts the orchestrator when it is not running (e.g. `systemctl --user start coldprompt-run`). */
  startRun?: () => Promise<{ ok: boolean; message: string }>;
  log?: (message: string) => void;
  /** Reconnect delay to the orchestrator socket. */
  reconnectMs?: number;
}

/** Reads `<COLDPROMPT_HOME>/web-token`, creating a random one (mode 0600) when missing. */
export async function loadOrCreateToken(store: Store): Promise<string> {
  const path = join(store.directory, 'web-token');
  try {
    const token = (await readFile(path, 'utf8')).trim();
    if (token.length >= 32) return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await store.ensureDirectory();
  const token = randomBytes(32).toString('base64url');
  await writeFile(path, token + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

/**
 * Web console: a separate client of the orchestrator's Unix socket (it never
 * talks to Claude or Codex). Bearer-token auth on every API call; the token is
 * sent in a header, so other sites cannot forge requests (no cookies, no CORS).
 */
export class WebServer {
  private server?: Server;
  private client?: ConsoleClient;
  private readonly streams = new Set<ServerResponse>();
  private status: unknown;
  private connected = false;
  private closing = false;
  private statusTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private readonly expected: Buffer;

  constructor(private readonly options: WebServerOptions) {
    this.expected = Buffer.from(options.token);
  }

  get address(): { host: string; port: number } | undefined {
    const a = this.server?.address();
    return a && typeof a === 'object' ? { host: a.address, port: a.port } : undefined;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.options.log?.(`web: ${(error as Error).message}`);
        if (!res.headersSent) this.json(res, 500, { ok: false, error: 'Internal error' });
        else res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.heartbeat = setInterval(() => { for (const s of this.streams) s.write(': keep-alive\n\n'); }, 20_000);
    void this.attach();
  }

  async stop(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.statusTimer);
    for (const s of this.streams) s.end();
    this.streams.clear();
    this.client?.close();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  // -------------------------------------------------------------------------
  // Orchestrator connection

  private async attach(): Promise<void> {
    for (let attempt = 0; !this.closing; attempt += 1) {
      const client = new ConsoleClient(this.options.socketPath);
      client.onMessage = (message) => this.onMessage(message);
      // Only a connection that was established starts a new reconnect loop;
      // a failed attempt is retried by this loop (one loop, one connection).
      client.onClose = () => {
        if (this.client !== client) return;
        this.client = undefined;
        this.setConnected(false);
        if (!this.closing) setTimeout(() => void this.attach(), this.options.reconnectMs ?? 2000).unref();
      };
      try {
        await client.connect();
        this.client = client;
        this.setConnected(true);
        return;
      } catch {
        this.setConnected(false);
        await new Promise((r) => setTimeout(r, this.options.reconnectMs ?? Math.min(1000 * 2 ** Math.min(attempt, 3), 5000)).unref());
      }
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.broadcast('connection', { connected: value });
  }

  private onMessage(message: ServerMessage): void {
    if (message.type === 'hello') {
      this.status = message.status;
      this.broadcast('status', message.status);
    } else if (message.type === 'event') {
      this.broadcast('event', { ...message.event, at: message.event.at ?? new Date().toISOString() });
      if (message.event.type !== 'worker.progress') this.refreshStatusSoon();
    }
  }

  /** Status changes with most events: fetch it again, at most every 300 ms. */
  private refreshStatusSoon(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(async () => {
      this.statusTimer = undefined;
      const response = await this.command({ command: 'status', text: '' });
      if (response.ok) { this.status = response.data; this.broadcast('status', response.data); }
    }, 300);
    this.statusTimer.unref();
  }

  private command(request: CommandRequest): Promise<CommandResponse> {
    if (!this.client?.connected) return Promise.resolve({ ok: false, error: 'ColdPrompt is not running' });
    return this.client.send(request);
  }

  // -------------------------------------------------------------------------
  // HTTP

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    const given = Buffer.from(match[1]);
    return given.length === this.expected.length && timingSafeEqual(given, this.expected);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return this.asset(res, PAGE_HTML, 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/app.js') return this.asset(res, APP_JS, 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/app.css') return this.asset(res, APP_CSS, 'text/css; charset=utf-8');
    if (!path.startsWith('/api/')) return this.json(res, 404, { ok: false, error: 'Not found' });
    if (!this.authorized(req)) return this.json(res, 401, { ok: false, error: 'Unauthorized' });

    if (req.method === 'GET' && path === '/api/stream') return this.stream(res);
    if (req.method === 'POST' && path === '/api/command') {
      const body = await this.body(req, res);
      if (!body) return;
      const command = typeof body.command === 'string' ? body.command.toLowerCase() : '';
      if (!ALLOWED_COMMANDS.has(command)) return this.json(res, 400, { ok: false, error: `Command not allowed: ${command || '(none)'}` });
      const request: CommandRequest = { command, text: typeof body.text === 'string' ? body.text : '', raw: body.raw === true };
      return this.json(res, 200, await this.command(request));
    }
    if (req.method === 'POST' && path === '/api/start') {
      if (!(await this.body(req, res))) return;
      if (this.connected) return this.json(res, 409, { ok: false, error: 'ColdPrompt is already running' });
      if (!this.options.startRun) return this.json(res, 501, { ok: false, error: 'Starting the run is not configured (coldprompt web --run-unit)' });
      const result = await this.options.startRun();
      return this.json(res, result.ok ? 200 : 500, { ok: result.ok, data: { message: result.message }, error: result.ok ? undefined : result.message });
    }
    const turn = /^\/api\/turn\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && turn) {
      const id = decodeURIComponent(turn[1]);
      if (!TURN_ID.test(id)) return this.json(res, 400, { ok: false, error: 'Invalid turn id' });
      const read = async (kind: string) => {
        try { return await this.options.store.readArtifact<any>(`turns/${id}.${kind}.json`); } catch { return undefined; }
      };
      const [worker, review, completion, verification] = await Promise.all([read('worker'), read('review'), read('completion'), read('verification')]);
      if (!worker && !review) return this.json(res, 404, { ok: false, error: 'Unknown turn' });
      return this.json(res, 200, {
        ok: true,
        data: {
          turnId: id,
          missionId: worker?.missionId,
          finalResponse: worker?.result?.finalResponse,
          commands: worker?.result?.commands,
          fileChanges: worker?.result?.fileChanges,
          errors: worker?.result?.errors,
          usage: worker?.result?.usage,
          gitBefore: worker?.gitBefore, gitAfter: worker?.gitAfter, commits: worker?.commits,
          review,
          completion,
          verification
        }
      });
    }
    return this.json(res, 404, { ok: false, error: 'Not found' });
  }

  private asset(res: ServerResponse, body: string, type: string): void {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  /** JSON body; requires Content-Type application/json and a size limit. */
  private async body(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
      this.json(res, 415, { ok: false, error: 'Expected application/json' });
      return undefined;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) { this.json(res, 413, { ok: false, error: 'Body too large' }); req.destroy(); return undefined; }
      chunks.push(chunk as Buffer);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* fall through */ }
    this.json(res, 400, { ok: false, error: 'Invalid JSON body' });
    return undefined;
  }

  /** Server-sent events: snapshot (status + recent history), then live events. */
  private async stream(res: ServerResponse): Promise<void> {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    const events = await this.options.store.readEvents().catch(() => []);
    const history = events.slice(-HISTORY_EVENTS).map((e) => ({ type: e.type, data: e.data, at: e.timestamp }));
    this.write(res, 'hello', { project: this.options.projectName, connected: this.connected, status: this.status ?? null, history });
    this.streams.add(res);
    res.on('close', () => this.streams.delete(res));
  }

  private write(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(event: string, data: unknown): void {
    for (const s of this.streams) this.write(s, event, data);
  }
}

export type { OrchestratorEvent };
