import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { Store } from './store.js';
import type { Config, State } from './types.js';

/**
 * Plan archives: the state of a finished run (state, events, turns, outputs
 * and the plan snapshot) moves to <COLDPROMPT_HOME>/archive/<name>/, so the
 * next plan starts from a fresh state. The web token stays.
 */

export const ARCHIVE_DIRECTORY = 'archive';
/** Snapshot of coldprompt.yaml and the session files, taken at each run start. */
export const PLAN_SNAPSHOT_DIRECTORY = 'plan';
const RUN_ENTRIES = ['state.json', 'events.jsonl', 'turns', 'outputs', PLAN_SNAPSHOT_DIRECTORY];

/** manual / forced: `archive` (button or CLI); auto: replaced finished plan at start; reset: run reset to start again. */
export type ArchiveReason = 'manual' | 'forced' | 'auto' | 'reset';

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** True when the state directory holds a run (state.json). */
export async function hasRun(store: Store): Promise<boolean> {
  return exists(store.statePath);
}

/**
 * Why this run is not a finished plan (undefined: it is). Finished means
 * COMPLETED, no pending turn, and its finalize step done when the plan has one.
 * `finalizeConfigured` is used for states written before the plan recorded it.
 */
export function notFinishedReason(state: State, finalizeConfigured = false): string | undefined {
  if (state.status !== 'COMPLETED') return `the plan is not complete (status ${state.status})`;
  if (state.pendingTurn) return 'a turn is still pending';
  if (state.finalize?.status === 'FAILED') return `its finalize step failed (${state.finalize.error ?? 'see the console'}); Start run retries it`;
  if ((state.finalizeConfigured ?? finalizeConfigured) && state.finalize?.status !== 'DONE') return 'its finalize step has not run yet; Start run runs it';
  return undefined;
}

/** Where a session file goes in a snapshot: its path relative to coldprompt.yaml, or external/<name>. */
function snapshotName(file: string): string {
  const n = normalize(file);
  return isAbsolute(n) || n.startsWith('..') ? join('external', n.split(/[\\/]/).at(-1)!) : n;
}

/** Copies coldprompt.yaml and the plan's session files into `target`. */
export async function copyPlan(target: string, configPath: string, files: string[]): Promise<void> {
  const base = dirname(resolve(configPath));
  await mkdir(target, { recursive: true, mode: 0o700 });
  await copyFile(configPath, join(target, 'coldprompt.yaml'));
  for (const file of files) {
    const to = join(target, snapshotName(file));
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(resolve(base, file), to);
  }
}

/** Replaces the plan snapshot of the state directory (run start). */
export async function snapshotPlan(store: Store, configPath: string, config: Config): Promise<void> {
  const target = join(store.directory, PLAN_SNAPSHOT_DIRECTORY);
  const fresh = `${target}.${process.pid}.tmp`;
  await copyPlan(fresh, configPath, config.sessions.flatMap((s) => (s.file ? [s.file] : [])));
  const old = `${target}.${process.pid}.old`;
  if (await exists(target)) await rename(target, old);
  await rename(fresh, target);
  await rm(old, { recursive: true, force: true });
}

function archiveName(state: State, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace(/:/g, '');
  const ids = Object.keys(state.sessions);
  const plan = ids.length ? (ids.length > 1 ? `${ids[0]}--${ids.at(-1)}` : ids[0]) : 'plan';
  return `${stamp}-${plan}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
}

export interface ArchiveOptions {
  reason: ArchiveReason;
  /** Used when the run has no plan snapshot (started before snapshots existed). */
  configPath?: string;
  config?: Config;
  now?: Date;
}

/**
 * Moves the run out of the state directory. The caller holds the store lock.
 * Returns the archive directory.
 */
export async function archiveRun(store: Store, options: ArchiveOptions): Promise<string> {
  const state = await store.load();
  const at = options.now ?? new Date();
  const root = join(store.directory, ARCHIVE_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let target = join(root, archiveName(state, at));
  for (let n = 2; await exists(target); n += 1) target = join(root, `${archiveName(state, at)}-${n}`);
  await mkdir(target, { mode: 0o700 });

  let plan: 'snapshot' | 'current config' | 'none' = 'snapshot';
  if (!(await exists(join(store.directory, PLAN_SNAPSHOT_DIRECTORY)))) {
    // Older run: copy the current files, but only if they still describe this run.
    const files = options.config?.sessions.filter((s) => s.file && state.sessions[s.id]).map((s) => s.file!) ?? [];
    if (options.configPath && files.length) {
      await copyPlan(join(target, PLAN_SNAPSHOT_DIRECTORY), options.configPath, files);
      plan = 'current config';
    } else {
      plan = 'none';
    }
  }
  for (const entry of RUN_ENTRIES) {
    const from = join(store.directory, entry);
    if (await exists(from)) await rename(from, join(target, entry));
  }
  const completed = Object.values(state.missions).filter((m) => m.status === 'COMPLETED').length;
  await writeFile(join(target, 'archive.json'), JSON.stringify({
    archivedAt: at.toISOString(),
    reason: options.reason,
    status: state.status,
    sessions: Object.keys(state.sessions),
    missions: { total: Object.keys(state.missions).length, completed },
    finalize: state.finalize ?? null,
    plan,
    runCreatedAt: state.createdAt
  }, null, 2) + '\n', { mode: 0o600 });
  return target;
}

/** Whether the run in the state directory can be archived now (the orchestrator being stopped is the caller's check). */
export async function archiveCheck(store: Store, config?: Config): Promise<{ archivable: boolean; reason?: string }> {
  if (!(await hasRun(store))) return { archivable: false, reason: 'there is no run to archive' };
  const reason = notFinishedReason(await store.load(), Boolean(config?.finalize));
  return reason ? { archivable: false, reason } : { archivable: true };
}

/**
 * Archives the run as one exclusive owner of the state directory (refused
 * while the orchestrator runs). Without `force`, only a finished plan.
 * `reset` archives any run (finished or not) with the reason "reset", so the
 * plan starts again from its first mission at the next start.
 */
export async function archivePlan(store: Store, options: { configPath?: string; config?: Config; force?: boolean; reset?: boolean }): Promise<{ ok: true; directory: string } | { ok: false; error: string }> {
  try {
    await store.acquireLock();
  } catch (error) {
    return { ok: false, error: `ColdPrompt is running (${(error as Error).message})` };
  }
  try {
    if (!(await hasRun(store))) return { ok: false, error: 'There is no run to archive' };
    const reason = notFinishedReason(await store.load(), Boolean(options.config?.finalize));
    if (reason && !options.force && !options.reset) return { ok: false, error: `Not archived: ${reason}. Use "coldprompt archive --force" to archive it anyway.` };
    const directory = await archiveRun(store, { reason: options.reset ? 'reset' : reason ? 'forced' : 'manual', configPath: options.configPath, config: options.config });
    return { ok: true, directory };
  } finally {
    await store.releaseLock();
  }
}

/** Commits recorded by the worker turns of the run in the state directory, oldest first. */
export async function runCommits(store: Store): Promise<string[]> {
  const dir = join(store.directory, 'turns');
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.worker.json')).sort(); } catch { return []; }
  const commits: string[] = [];
  for (const name of names) {
    try {
      const turn = JSON.parse(await readFile(join(dir, name), 'utf8')) as { commits?: unknown };
      if (Array.isArray(turn.commits)) for (const c of turn.commits) if (typeof c === 'string' && !commits.includes(c)) commits.push(c);
    } catch { /* unreadable turn: skip */ }
  }
  return commits;
}

/**
 * Plan files (coldprompt.yaml and the current session files) that differ from
 * the snapshot taken when the run started: the running orchestrator still uses
 * the old ones until it restarts. Empty when there is no snapshot.
 */
export async function planChanges(store: Store, configPath: string, config?: Config): Promise<string[]> {
  const snapshotDir = join(store.directory, PLAN_SNAPSHOT_DIRECTORY);
  if (!(await exists(snapshotDir))) return [];
  const read = (path: string) => readFile(path).then((b) => b.toString('utf8'), () => undefined);
  const base = dirname(resolve(configPath));
  const pairs: Array<[string, string, string]> = [['coldprompt.yaml', resolve(configPath), join(snapshotDir, 'coldprompt.yaml')]];
  for (const s of config?.sessions ?? []) {
    if (s.file) pairs.push([s.file, resolve(base, s.file), join(snapshotDir, snapshotName(s.file))]);
  }
  const changed: string[] = [];
  for (const [name, current, saved] of pairs) {
    if ((await read(current)) !== (await read(saved))) changed.push(name);
  }
  return changed;
}
