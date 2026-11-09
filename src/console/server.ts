import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { ColdPromptError } from '../errors.js';
import type { Orchestrator, OrchestratorEvent } from '../orchestrator.js';
import { MAX_LINE_BYTES, type ClientMessage, type ServerMessage } from './protocol.js';

function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Local Unix-socket console (mode 0600 inside a 0700 directory). Any number of
 * clients may connect; the orchestrator serializes their state changes.
 */
export class ConsoleServer {
  private server?: Server;
  private readonly clients = new Set<Socket>();
  private readonly onEvent = (event: OrchestratorEvent) => this.broadcast({ type: 'event', event });

  constructor(private readonly orchestrator: Orchestrator, readonly socketPath: string) {}

  async start(): Promise<void> {
    await this.orchestrator.store.ensureSocketDirectory();
    try {
      const info = await lstat(this.socketPath);
      if (!info.isSocket()) throw new ColdPromptError('UNSAFE_REPOSITORY', `${this.socketPath} exists and is not a socket`);
      if (await probe(this.socketPath)) throw new ColdPromptError('SESSION_LOCK', `Another orchestrator is listening on ${this.socketPath}`);
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const server = createServer((socket) => this.accept(socket));
    const previous = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.socketPath, () => { server.off('error', reject); resolve(); });
      });
    } finally {
      process.umask(previous);
    }
    await chmod(this.socketPath, 0o600);
    this.server = server;
    this.orchestrator.events.on('event', this.onEvent);
  }

  private send(socket: Socket, message: ServerMessage): void {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.clients) this.send(client, message);
  }

  private accept(socket: Socket): void {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
    this.send(socket, { type: 'hello', version: 1, status: this.orchestrator.statusSummary() });
    let pending = 0;
    socket.on('data', (chunk) => {
      pending += chunk.length;
      if (pending > MAX_LINE_BYTES) {
        this.send(socket, { type: 'response', id: '?', ok: false, error: 'Line too long' });
        socket.destroy();
      }
    });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', async (line) => {
      pending = 0;
      if (!line.trim()) return;
      let message: ClientMessage;
      try {
        message = JSON.parse(line);
        if (typeof message.command !== 'string') throw new Error('missing command');
      } catch {
        this.send(socket, { type: 'response', id: '?', ok: false, error: 'Invalid message: expected one JSON object per line' });
        return;
      }
      const response = await this.orchestrator.handleCommand({ command: message.command, text: typeof message.text === 'string' ? message.text : '', raw: message.raw === true });
      this.send(socket, { type: 'response', id: String(message.id ?? ''), ...response });
    });
  }

  async stop(): Promise<void> {
    this.orchestrator.events.off('event', this.onEvent);
    for (const client of this.clients) {
      client.end();
      setTimeout(() => client.destroy(), 1000).unref();
    }
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
    await unlink(this.socketPath).catch(() => undefined);
  }
}
