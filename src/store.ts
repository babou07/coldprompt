import { mkdir, readFile, rename, open, unlink, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { ColdPromptError, redactValue } from './errors.js';
import type { State } from './types.js';

export function initialState(): State {
  const now = new Date().toISOString();
  return {
    version: 3,
    status: 'IDLE',
    missionIndex: 0,
    missionTurns: 0,
    totalTurns: 0,
    missions: {},
    sessions: {},
    supervisorSessionStarted: false,
    pauseRequested: false,
    hotPrompts: [],
    directives: [],
    createdAt: now,
    updatedAt: now
  };
}

/** Upgrades older state files without dropping queued HOT_PROMPTs. */
export function migrateState(raw: Record<string, unknown>): State {
  if (raw.version === 3) return { ...initialState(), ...(raw as Partial<State>) } as State;
  if (raw.version === 2) {
    // v2 had one shared thread (workerThreadId) and per-mission threads; only the shared one is kept.
    const { workerThreadId, missions, ...rest } = raw as Record<string, any>;
    const cleaned: Record<string, unknown> = {};
    for (const [id, progress] of Object.entries((missions ?? {}) as Record<string, any>)) {
      const { workerThreadId: _ignored, ...keep } = progress;
      cleaned[id] = keep;
    }
    return { ...initialState(), ...rest, version: 3, missions: cleaned, sessions: {}, legacyWorkerThreadId: workerThreadId } as State;
  }
  if (raw.version === 1) {
    const base = initialState();
    const v1 = raw as Record<string, any>;
    return {
      ...base,
      status: v1.status ?? 'IDLE',
      missionIndex: v1.missionIndex ?? 0,
      missionTurns: v1.missionTurns ?? 0,
      totalTurns: v1.totalTurns ?? 0,
      legacyWorkerThreadId: v1.workerThreadId,
      supervisorSessionId: v1.supervisorSessionId,
      supervisorSessionStarted: Boolean(v1.supervisorSessionId),
      lastWorkerResult: v1.lastWorkerResult,
      lastDecision: v1.lastDecision,
      blockedReason: v1.blockedReason,
      blocked: v1.status === 'BLOCKED'
        ? { kind: 'SUPERVISOR', reason: v1.blockedReason ?? 'Blocked (migrated state)', at: base.createdAt }
        : undefined,
      hotPrompts: Array.isArray(v1.hotPrompts) ? v1.hotPrompts : [],
      directives: v1.pendingWorkerDirective
        ? [{ id: 'd-migrated', author: 'HUMAN', content: v1.pendingWorkerDirective, status: 'APPROVED', createdAt: base.createdAt }]
        : []
    };
  }
  throw new ColdPromptError('INVALID_CONFIG', `Unsupported state version: ${String(raw.version)}`);
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

export interface LockInfo {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Independent of the environment (XDG_RUNTIME_DIR differs between tmux, cron and
 * SSH logins), so a remote console always finds the orchestrator's socket.
 */
function runtimeDirectory(): string {
  return join('/tmp', `coldprompt-${process.getuid?.() ?? 'user'}`);
}

export class Store {
  private lockHeld = false;

  constructor(readonly directory: string) {}

  get statePath(): string { return join(this.directory, 'state.json'); }
  get eventsPath(): string { return join(this.directory, 'events.jsonl'); }
  get lockPath(): string { return join(this.directory, 'owner.lock'); }
  /**
   * Unix socket paths are limited to ~108 bytes. Deep state directories use a
   * short, deterministic path in a private runtime directory instead.
   */
  get socketPath(): string {
    const local = join(this.directory, 'console.sock');
    if (Buffer.byteLength(local) <= 100) return local;
    return join(runtimeDirectory(), `coldprompt-${createHash('sha256').update(resolve(this.directory)).digest('hex').slice(0, 16)}.sock`);
  }

  /** Creates (or checks) the private directory that holds the socket. */
  async ensureSocketDirectory(): Promise<void> {
    const dir = join(this.socketPath, '..');
    if (resolve(dir) === resolve(this.directory)) return this.ensureDirectory();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new ColdPromptError('UNSAFE_REPOSITORY', `Socket directory ${dir} must be a private (0700) directory owned by you`);
    }
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(join(this.directory, 'turns'), { recursive: true, mode: 0o700 });
  }

  async load(): Promise<State> {
    try {
      return migrateState(JSON.parse(await readFile(this.statePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return initialState();
    }
  }

  async save(state: State): Promise<void> {
    await this.ensureDirectory();
    state.updatedAt = new Date().toISOString();
    state.blockedReason = state.blocked?.reason;
    await writeAtomic(this.statePath, JSON.stringify(state, null, 2));
  }

  async event(type: string, data: unknown = {}): Promise<void> {
    await this.ensureDirectory();
    const line = JSON.stringify({ timestamp: new Date().toISOString(), type, data: redactValue(data) }) + '\n';
    const handle = await open(this.eventsPath, 'a', 0o600);
    try {
      await handle.writeFile(line);
    } finally {
      await handle.close();
    }
  }

  async readEvents(): Promise<Array<{ timestamp: string; type: string; data: any }>> {
    try {
      const source = await readFile(this.eventsPath, 'utf8');
      return source.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Persists a turn artifact (worker result, review) and returns its reference. */
  async writeArtifact(name: string, value: unknown): Promise<string> {
    await this.ensureDirectory();
    const ref = join('turns', `${name}.json`);
    await writeAtomic(join(this.directory, ref), JSON.stringify(redactValue(value), null, 2));
    return ref;
  }

  /** Path of a mission's structured output (execution.output). */
  outputPath(missionId: string): string { return join(this.directory, 'outputs', `${missionId}.json`); }

  async writeOutput(missionId: string, value: unknown): Promise<string> {
    await mkdir(join(this.directory, 'outputs'), { recursive: true, mode: 0o700 });
    await writeAtomic(this.outputPath(missionId), JSON.stringify(redactValue(value), null, 2));
    return this.outputPath(missionId);
  }

  async readOutput(missionId: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(this.outputPath(missionId), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async readArtifact<T>(ref: string): Promise<T> {
    return JSON.parse(await readFile(join(this.directory, ref), 'utf8')) as T;
  }

  async listArtifacts(): Promise<string[]> {
    try {
      return (await readdir(join(this.directory, 'turns'))).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }

  /**
   * Exclusive ownership of the state directory. A stale lock (dead pid on
   * this host) is taken over; a live owner is never killed.
   */
  async acquireLock(): Promise<void> {
    await this.ensureDirectory();
    const info: LockInfo = { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(info));
        await handle.sync();
        await handle.close();
        this.lockHeld = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.readLock();
        if (existing && existing.hostname === hostname() && !processAlive(existing.pid)) {
          await this.event('lock.stale_taken_over', { previous: existing });
          await unlink(this.lockPath).catch(() => undefined);
          continue;
        }
        throw new ColdPromptError(
          'SESSION_LOCK',
          existing
            ? `State directory ${this.directory} is owned by pid ${existing.pid} on ${existing.hostname} since ${existing.acquiredAt}. ColdPrompt will not kill it; stop that process or remove ${this.lockPath} if you are certain it is dead.`
            : `State directory ${this.directory} is locked (${this.lockPath}).`
        );
      }
    }
    throw new ColdPromptError('SESSION_LOCK', `Could not acquire ${this.lockPath}`);
  }

  async readLock(): Promise<LockInfo | undefined> {
    try {
      return JSON.parse(await readFile(this.lockPath, 'utf8')) as LockInfo;
    } catch {
      return undefined;
    }
  }

  async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    const existing = await this.readLock();
    if (existing?.pid === process.pid) await unlink(this.lockPath).catch(() => undefined);
    this.lockHeld = false;
  }
}
