import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { z } from 'zod';
import { ColdPromptError } from './errors.js';
import { configSchema, planSchema, sessionSchema, type Config, type Session } from './types.js';

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

/**
 * The `.env` next to coldprompt.yaml, if any: `KEY=value` lines, `#` comments,
 * optional `export ` and surrounding quotes. A value may use `${VAR}` of the
 * environment or of an earlier line. Never exported to the process (workers
 * do not see it): only used to expand the plan.
 */
export async function loadDotEnv(configPath: string): Promise<Record<string, string>> {
  const path = join(dirname(resolve(configPath)), '.env');
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ColdPromptError('INVALID_CONFIG', `Cannot read ${path}: ${(error as Error).message}`);
  }
  const vars: Record<string, string> = {};
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(text);
    if (!match) throw new ColdPromptError('INVALID_CONFIG', `${path}:${index + 1}: expected KEY=value`);
    let value = match[2];
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    vars[match[1]] = expandVars(value, { ...process.env, ...vars } as Record<string, string>, `${path}:${index + 1}`);
  }
  return vars;
}

/**
 * Replaces `${NAME}` with its value. `$${` keeps a literal `${` (for shell
 * code). An unknown name is left as it is (shell variables of `run:`
 * commands), except names starting with COLDPROMPT_, which must be defined.
 */
export function expandVars(text: string, vars: Record<string, string | undefined>, where: string): string {
  return text.replace(/\$?\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    if (whole.startsWith('$$')) return whole.slice(1);
    const value = vars[name];
    if (value !== undefined) return value;
    if (name.startsWith('COLDPROMPT_')) {
      throw new ColdPromptError('INVALID_CONFIG', `${where}: \${${name}} is not defined (set it in the environment or in the .env next to coldprompt.yaml)`);
    }
    return whole;
  });
}

/** Expands `${VAR}` in every string of a parsed YAML value. */
function expandTree(value: unknown, vars: Record<string, string | undefined>, where: string): unknown {
  if (typeof value === 'string') return expandVars(value, vars, where);
  if (Array.isArray(value)) return value.map((v, i) => expandTree(v, vars, `${where}.${i}`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandTree(v, vars, `${where}.${k}`)]));
  }
  return value;
}

const formatIssues = (issues: z.ZodIssue[]): string =>
  issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');

/** Resolves a path of the config: "~/" is the home directory, otherwise relative to coldprompt.yaml. */
export function resolveConfigPath(configPath: string, path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  return resolve(dirname(resolve(configPath)), path);
}

/** "dir/r*.yaml": files of dir matching the last segment ("*" = any characters), sorted by name. */
async function expandPattern(base: string, entry: string): Promise<string[]> {
  if (!basename(entry).includes('*')) return [entry];
  if (dirname(entry).includes('*')) throw new ColdPromptError('INVALID_CONFIG', `Session entry ${entry}: "*" is only allowed in the file name`);
  const dir = dirname(entry);
  const pattern = new RegExp('^' + basename(entry).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  let names: string[];
  try {
    names = await readdir(resolve(base, dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new ColdPromptError('INVALID_CONFIG', `Cannot list ${resolve(base, dir)}: ${(error as Error).message}`);
  }
  return names.filter((n) => pattern.test(n)).sort().map((n) => join(dir, n));
}

/** Reads and validates one session file. */
export async function loadSessionFile(path: string, what = 'session file'): Promise<Omit<Session, 'file'>> {
  const parsed = sessionSchema.safeParse(await readYaml(path, what));
  if (!parsed.success) {
    const hint = parsed.error.issues.some((i) => i.code === 'unrecognized_keys' && i.keys.includes('newWorkerThread'))
      ? '\n  (newWorkerThread was removed: a session file is one Codex thread; put the mission in its own session file)'
      : '';
    throw new ColdPromptError('INVALID_CONFIG', `Invalid session file ${path}:\n${formatIssues(parsed.error.issues)}${hint}`);
  }
  return parsed.data;
}

/**
 * Loads coldprompt.yaml (the plan) and the session files it lists, in order.
 * Session paths are relative to coldprompt.yaml. `${VAR}` in the plan's
 * strings is expanded from the environment, then the `.env` next to the plan
 * (the environment wins); session files are not expanded.
 */
export async function loadConfig(path: string): Promise<Config> {
  const vars = { ...await loadDotEnv(path), ...process.env };
  const raw = expandTree(await readYaml(path, 'config'), vars, basename(path));
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
  const accepted = plan.data.proposals && resolveConfigPath(path, plan.data.proposals.acceptInto);
  if (accepted && !plan.data.sessions.some((e) => basename(e).includes('*') && resolveConfigPath(path, dirname(e)) === accepted)) {
    throw new ColdPromptError('INVALID_CONFIG', `Invalid configuration ${path}:\n  - sessions: add an entry such as "${plan.data.proposals!.acceptInto.replace(/\/$/, '')}/*.yaml" so that accepted proposals join the plan`);
  }
  const files: string[] = [];
  for (const entry of plan.data.sessions) files.push(...await expandPattern(base, entry));
  if (!files.length) throw new ColdPromptError('INVALID_CONFIG', `Invalid configuration ${path}:\n  - sessions: no session file found`);
  const sessions: unknown[] = [];
  for (const [index, file] of files.entries()) {
    sessions.push({ ...await loadSessionFile(resolve(base, file), `session file (sessions.${index})`), file });
  }

  const result = configSchema.safeParse({ ...plan.data, sessions });
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const [head, index, ...rest] = i.path;
      const where = head === 'sessions' && typeof index === 'number'
        ? `${files[index]}${rest.length ? ': ' + rest.join('.') : ''}`
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
