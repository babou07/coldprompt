import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redact } from './errors.js';
import { snapshot } from './git.js';
import type { Config, Mission, VerificationOutcome } from './types.js';

export interface VerificationContext {
  workingDirectory: string;
  mission: Mission;
  phase: 'turn' | 'completion';
  signal?: AbortSignal;
}

/** Extension point for project-specific checks (plugins export createVerifier). */
export interface Verifier {
  readonly name: string;
  readonly when: 'turn' | 'completion';
  run(context: VerificationContext): Promise<{ passed: boolean; output: string }>;
}

export type VerifierFactory = (options: Record<string, unknown>) => Verifier | Promise<Verifier>;

function tail(text: string, max = 8000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

export class CommandVerifier implements Verifier {
  constructor(readonly name: string, readonly when: 'turn' | 'completion', private readonly command: string, private readonly timeoutSeconds: number) {}

  run(context: VerificationContext): Promise<{ passed: boolean; output: string }> {
    return new Promise((resolvePromise) => {
      const child = spawn('sh', ['-c', this.command], { cwd: context.workingDirectory, stdio: ['ignore', 'pipe', 'pipe'], signal: context.signal });
      let output = '';
      const collect = (chunk: Buffer) => { output = tail(output + chunk.toString('utf8'), 64000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => { output += `\n[coldprompt] timeout after ${this.timeoutSeconds}s`; child.kill('SIGTERM'); }, this.timeoutSeconds * 1000);
      child.on('error', (error) => { clearTimeout(timer); resolvePromise({ passed: false, output: `${output}\n${error.message}` }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ passed: code === 0, output: redact(tail(`$ ${this.command}\n${output}\n[exit ${code}]`)) });
      });
    });
  }
}

export class GitCleanVerifier implements Verifier {
  readonly name = 'git-clean';
  readonly when = 'completion' as const;

  async run(context: VerificationContext): Promise<{ passed: boolean; output: string }> {
    const git = await snapshot(context.workingDirectory);
    if (!git.isRepo) return { passed: false, output: 'Not a git repository' };
    if (git.operationInProgress) return { passed: false, output: `Git ${git.operationInProgress} in progress` };
    return git.dirty
      ? { passed: false, output: `Working tree has ${git.changedFiles} uncommitted change(s)` }
      : { passed: true, output: `Clean at ${git.head}` };
  }
}

export async function buildVerifiers(config: Config, configDirectory: string): Promise<Verifier[]> {
  const verifiers: Verifier[] = config.verification.commands.map((c) => new CommandVerifier(c.name, c.when, c.run, c.timeoutSeconds));
  for (const plugin of config.verification.plugins) {
    const mod = await import(pathToFileURL(resolve(configDirectory, plugin.module)).href) as { createVerifier?: VerifierFactory };
    if (typeof mod.createVerifier !== 'function') throw new Error(`Verification plugin ${plugin.module} does not export createVerifier()`);
    const created = await mod.createVerifier(plugin.options);
    verifiers.push({ name: plugin.name, when: plugin.when, run: (ctx) => created.run(ctx) });
  }
  return verifiers;
}

/**
 * Verifiers that apply to a mission in a phase. A mission's explicit
 * `verification` list wins. Without one, every verifier applies, except
 * completion checks on read-only missions: such a mission cannot change the
 * repository, so it could never make a failing check pass.
 */
export function selectVerifiers(verifiers: Verifier[], mission: Mission, phase: 'turn' | 'completion'): Verifier[] {
  return verifiers.filter((v) => {
    if (v.when !== phase) return false;
    if (mission.verification) return mission.verification.includes(v.name);
    return !(phase === 'completion' && mission.execution.readOnly);
  });
}

/** Read-only missions that explicitly require completion checks (reported by `doctor`). */
export function readOnlyCompletionChecks(config: Config): Array<{ missionId: string; checks: string[] }> {
  const completion = new Set([...config.verification.commands, ...config.verification.plugins].filter((v) => v.when === 'completion').map((v) => v.name));
  return config.missions
    .filter((m) => m.execution.readOnly && m.verification)
    .map((m) => ({ missionId: m.id, checks: m.verification!.filter((name) => completion.has(name)) }))
    .filter((entry) => entry.checks.length > 0);
}

export async function runVerifiers(
  verifiers: Verifier[],
  context: VerificationContext,
  options: { gitClean: boolean }
): Promise<VerificationOutcome[]> {
  const selected = selectVerifiers(verifiers, context.mission, context.phase);
  if (context.phase === 'completion' && options.gitClean && !context.mission.execution.readOnly) selected.push(new GitCleanVerifier());
  const outcomes: VerificationOutcome[] = [];
  for (const verifier of selected) {
    const started = Date.now();
    try {
      const { passed, output } = await verifier.run(context);
      outcomes.push({ name: verifier.name, passed, output, durationMs: Date.now() - started });
    } catch (error) {
      outcomes.push({ name: verifier.name, passed: false, output: redact(String(error)), durationMs: Date.now() - started });
    }
  }
  return outcomes;
}

export function configDirectoryOf(configPath: string): string {
  return dirname(resolve(configPath));
}
