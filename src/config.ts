import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import type { z } from 'zod';
import { ColdPromptError } from './errors.js';
import { configSchema, planSchema, sessionSchema, type Config } from './types.js';

async function readYaml(path: string, what: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new ColdPromptError('INVALID_CONFIG', `Cannot read ${what} ${path}: ${(error as Error).message}`);
  }
  try {
    return YAML.parse(source);
  } catch (error) {
    throw new ColdPromptError('INVALID_CONFIG', `Invalid YAML in ${path}: ${(error as Error).message}`);
  }
}

const formatIssues = (issues: z.ZodIssue[]): string =>
  issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');

/**
 * Loads coldprompt.yaml (the plan) and the session files it lists, in order.
 * Session paths are relative to coldprompt.yaml.
 */
export async function loadConfig(path: string): Promise<Config> {
  const raw = await readYaml(path, 'config');
  if (raw && typeof raw === 'object' && 'missions' in raw) {
    throw new ColdPromptError('INVALID_CONFIG',
      `Invalid configuration ${path}:\n  - missions: missions are declared in session files, not in coldprompt.yaml. ` +
      'Move them to e.g. sessions/main.yaml (with an "id:" and a "missions:" list) and list that file under "sessions:".');
  }
  const plan = planSchema.safeParse(raw);
  if (!plan.success) {
    const renamed = plan.error.issues.some((i) => i.code === 'unrecognized_keys' && i.keys.includes('requireHumanApprovalForMissionTransition'))
      ? '\n  (requireHumanApprovalForMissionTransition was replaced by runtime.autoApproveMissions, default false: every mission end waits for "approve mission")'
      : '';
    throw new ColdPromptError('INVALID_CONFIG', `Invalid configuration ${path}:\n${formatIssues(plan.error.issues)}${renamed}`);
  }

  const base = dirname(resolve(path));
  const sessions: unknown[] = [];
  for (const [index, file] of plan.data.sessions.entries()) {
    const sessionPath = resolve(base, file);
    const parsed = sessionSchema.safeParse(await readYaml(sessionPath, `session file (sessions.${index})`));
    if (!parsed.success) {
      const hint = parsed.error.issues.some((i) => i.code === 'unrecognized_keys' && i.keys.includes('newWorkerThread'))
        ? '\n  (newWorkerThread was removed: a session file is one Codex thread; put the mission in its own session file)'
        : '';
      throw new ColdPromptError('INVALID_CONFIG', `Invalid session file ${sessionPath}:\n${formatIssues(parsed.error.issues)}${hint}`);
    }
    sessions.push({ ...parsed.data, file });
  }

  const result = configSchema.safeParse({ ...plan.data, sessions });
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const [head, index, ...rest] = i.path;
      const where = head === 'sessions' && typeof index === 'number'
        ? `${plan.data.sessions[index]}${rest.length ? ': ' + rest.join('.') : ''}`
        : i.path.join('.') || '(root)';
      return `  - ${where}: ${i.message}`;
    }).join('\n');
    throw new ColdPromptError('INVALID_CONFIG', `Invalid configuration ${path}:\n${issues}`);
  }
  return result.data;
}

/** The target repository, resolved relative to the config file. */
export function resolveWorkingDirectory(config: Config, configPath: string): string {
  return resolve(dirname(resolve(configPath)), config.project.workingDirectory);
}
