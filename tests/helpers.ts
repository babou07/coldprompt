import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeSupervisorSchema, claudeWorkerSchema, codexSupervisorSchema, codexWorkerSchema, configSchema,
  type ClaudeSupervisorConfig, type ClaudeWorkerConfig, type CodexSupervisorConfig, type CodexWorkerConfig, type Config
} from '../src/types.js';
import { Store } from '../src/store.js';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator.js';
import { FakeSupervisorAdapter, FakeWorkerAdapter } from '../src/adapters/fake.js';

export async function tempDir(prefix = 'coldprompt-test-'): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Provider configs with their defaults applied. */
export const codexWorker = (o: Record<string, unknown> = {}): CodexWorkerConfig => codexWorkerSchema.parse({ provider: 'codex', ...o });
export const claudeWorker = (o: Record<string, unknown> = {}): ClaudeWorkerConfig => claudeWorkerSchema.parse({ provider: 'claude', ...o });
export const claudeSupervisor = (o: Record<string, unknown> = {}): ClaudeSupervisorConfig => claudeSupervisorSchema.parse({ provider: 'claude', ...o });
export const codexSupervisor = (o: Record<string, unknown> = {}): CodexSupervisorConfig => codexSupervisorSchema.parse({ provider: 'codex', ...o });

/**
 * A loaded plan. `missions` gives one session ("main"); `sessions` gives several
 * ({ id, missions, resumeThread?, handoff? }).
 */
export function makeConfig(overrides: Record<string, any> = {}): Config {
  const { runtime, missions, sessions, ...rest } = overrides;
  return configSchema.parse({
    version: 1,
    project: { name: 'test', workingDirectory: '.' },
    worker: { provider: 'codex' },
    supervisor: { provider: 'claude' },
    runtime: {
      maxTurns: 50,
      maxHours: 1,
      statusEvery: 100,
      retryDelaysSeconds: [30, 60, 120, 240],
      verifyGitCleanOnCompletion: false,
      requireHumanApprovalForMissionTransition: false,
      ...runtime
    },
    sessions: sessions ?? [{
      id: 'main',
      missions: missions ?? [
        { id: 'a', title: 'Mission A', prompt: { type: 'COLD_PROMPT', content: 'Do A' }, completionCriteria: ['A done'] }
      ]
    }],
    ...rest
  });
}

export interface Harness {
  orchestrator: Orchestrator;
  worker: FakeWorkerAdapter;
  supervisor: FakeSupervisorAdapter;
  store: Store;
  sleeps: number[];
  done: Promise<unknown>;
}

/** Opens an orchestrator over a fake worker/supervisor and starts run() in the background. */
export async function start(
  home: string,
  workdir: string,
  config: Config,
  worker: FakeWorkerAdapter,
  supervisor: FakeSupervisorAdapter,
  extra: Partial<OrchestratorOptions> = {}
): Promise<Harness> {
  const store = new Store(home);
  const sleeps: number[] = [];
  const orchestrator = new Orchestrator({
    config, store, worker, supervisor, workingDirectory: workdir,
    sleep: async (ms) => { sleeps.push(ms); },
    ...extra
  });
  await orchestrator.open();
  const done = orchestrator.run().finally(() => orchestrator.close());
  return { orchestrator, worker, supervisor, store, sleeps, done };
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export { FakeSupervisorAdapter, FakeWorkerAdapter };
