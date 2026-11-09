import type { SupervisorAdapter } from '../supervisor.js';
import type { SupervisorConfig, WorkerConfig } from '../types.js';
import type { WorkerAdapter } from '../worker.js';
import { errorMessage } from '../errors.js';
import { ClaudeSupervisorAdapter } from './claude.js';
import { ClaudeWorkerAdapter } from './claude-worker.js';
import { checkCodexBinary, CodexWorkerAdapter } from './codex.js';
import { CodexSupervisorAdapter } from './codex-supervisor.js';

/**
 * Provider registry: the only place that knows which adapters exist.
 * To add a provider: a config schema in types.ts (worker or supervisor
 * union), an adapter implementing WorkerAdapter / SupervisorAdapter, and an
 * entry below. The orchestrator never names a provider.
 */

export interface ProviderCheck { level: 'ok' | 'warn' | 'fail'; message: string }

export interface ProviderContext {
  /** The target repository. */
  workingDirectory: string;
  maxWorkerOutputChars: number;
}

interface Provider<C, A> {
  create(config: C, context: ProviderContext): A;
  /** Installation checks (doctor; failures also abort a real run). */
  check(config: C, context: ProviderContext): Promise<ProviderCheck[]>;
}

type ProvidersFor<U extends { provider: string }, A> = { [K in U['provider']]: Provider<Extract<U, { provider: K }>, A> };

const cliCheck = async (role: string, validate: () => Promise<string>): Promise<ProviderCheck[]> => {
  try {
    return [{ level: 'ok', message: `${role}: Claude CLI ${await validate()}, required options present` }];
  } catch (error) {
    return [{ level: 'fail', message: `${role}: ${errorMessage(error)}` }];
  }
};

export const WORKER_PROVIDERS: ProvidersFor<WorkerConfig, WorkerAdapter> = {
  codex: {
    create: (config) => new CodexWorkerAdapter(config),
    check: async (config) => {
      const checks = await checkCodexBinary(config.codexPath, 'worker');
      checks.push({ level: 'ok', message: `worker: Codex sandbox ${config.sandboxMode ?? 'inherited from your Codex config'}` });
      return checks;
    }
  },
  claude: {
    create: (config) => new ClaudeWorkerAdapter(config),
    check: async (config, context) => {
      const checks = await cliCheck('worker', () => new ClaudeWorkerAdapter(config).validateCli(context.workingDirectory));
      if (!config.permissionMode && !config.allowedTools?.length) {
        checks.push({ level: 'warn', message: 'worker: Claude permissions come from your Claude Code settings; in an unattended run, edits and commands they do not allow are denied. Set worker.permissionMode (e.g. acceptEdits) and worker.allowedTools.' });
      }
      checks.push({ level: 'ok', message: `worker: read-only missions use only ${config.readOnlyTools.join(', ')}` });
      return checks;
    }
  }
};

export const SUPERVISOR_PROVIDERS: ProvidersFor<SupervisorConfig, SupervisorAdapter> = {
  claude: {
    create: (config, context) => new ClaudeSupervisorAdapter(config, context.workingDirectory, undefined, context.maxWorkerOutputChars),
    check: (config, context) => cliCheck('supervisor', () => new ClaudeSupervisorAdapter(config, context.workingDirectory).validateCli())
  },
  codex: {
    create: (config, context) => new CodexSupervisorAdapter(config, context.workingDirectory, undefined, context.maxWorkerOutputChars),
    check: async (config) => [
      ...await checkCodexBinary(config.codexPath, 'supervisor'),
      { level: 'ok', message: 'supervisor: Codex runs in a read-only sandbox' }
    ]
  }
};

function workerProvider(config: WorkerConfig): Provider<WorkerConfig, WorkerAdapter> {
  return WORKER_PROVIDERS[config.provider] as Provider<WorkerConfig, WorkerAdapter>;
}

function supervisorProvider(config: SupervisorConfig): Provider<SupervisorConfig, SupervisorAdapter> {
  return SUPERVISOR_PROVIDERS[config.provider] as Provider<SupervisorConfig, SupervisorAdapter>;
}

export const createWorker = (config: WorkerConfig, context: ProviderContext): WorkerAdapter => workerProvider(config).create(config, context);
export const createSupervisor = (config: SupervisorConfig, context: ProviderContext): SupervisorAdapter => supervisorProvider(config).create(config, context);

/** Checks both roles. */
export async function checkProviders(config: { worker: WorkerConfig; supervisor: SupervisorConfig }, context: ProviderContext): Promise<ProviderCheck[]> {
  return [
    ...await workerProvider(config.worker).check(config.worker, context),
    ...await supervisorProvider(config.supervisor).check(config.supervisor, context)
  ];
}
