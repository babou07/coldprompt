import { delimiter, dirname, join } from 'node:path';

export interface UnitOptions {
  /** Absolute path of bin/coldprompt. */
  launcher: string;
  /** Absolute path of the coldprompt.yaml to run. */
  configPath: string;
  /** Directories that must be on PATH (node, codex, claude). */
  pathDirectories: string[];
  webHost: string;
  webPort: number;
  runUnit: string;
}

const quote = (value: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`);

/**
 * systemd user units replacing tmux: the orchestrator (started on demand,
 * never restarted automatically) and the web console (always on).
 *
 * The run unit stops gracefully: SIGTERM reaches only the orchestrator
 * (KillMode=mixed), which finishes the current worker turn first, so a stop
 * may take as long as that turn. Codex child processes are never killed
 * mid-turn by systemd unless the stop is forced.
 */
export function renderUnits(options: UnitOptions): Record<string, string> {
  const path = [...new Set([...options.pathDirectories, '/usr/local/bin', '/usr/bin', '/bin'])].join(delimiter);
  const common = [
    `WorkingDirectory=${quote(dirname(options.configPath))}`,
    `Environment=${quote(`COLDPROMPT_CONFIG=${options.configPath}`)}`,
    `Environment=${quote(`PATH=${path}`)}`,
    // A DRY_RUN left in the user's environment must not turn a real run into a dry-run.
    'UnsetEnvironment=DRY_RUN'
  ];
  const run = [
    '[Unit]',
    `Description=ColdPrompt orchestrator (${options.configPath})`,
    '',
    '[Service]',
    'Type=simple',
    ...common,
    `ExecStart=${quote(options.launcher)} run`,
    'KillMode=mixed',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=infinity',
    'Restart=no',
    // Exit 3 = stopped while waiting for a human (BLOCKED / PAUSED): a normal end, not a failure.
    'SuccessExitStatus=3',
    ''
  ].join('\n');
  const web = [
    '[Unit]',
    `Description=ColdPrompt web console (${options.configPath})`,
    '',
    '[Service]',
    'Type=simple',
    ...common,
    `ExecStart=${quote(options.launcher)} web --host ${options.webHost} --port ${options.webPort} --run-unit ${options.runUnit}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
  return { [options.runUnit]: run, 'coldprompt-web.service': web };
}

/** First directory on PATH containing `name`, if any (no shell involved). */
export async function findOnPath(name: string, pathValue = process.env.PATH ?? ''): Promise<string | undefined> {
  const { access, constants } = await import('node:fs/promises');
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    try {
      await access(join(dir, name), constants.X_OK);
      return dir;
    } catch { /* next */ }
  }
  return undefined;
}

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface StartUnitOptions {
  exec: Exec;
  /** How long to watch the unit after the start: a broken config exits within seconds. */
  watchMs?: number;
  pollMs?: number;
  /** Turns a message into one safe to show (secrets masked). */
  redact?: (text: string) => string;
  /** `restart`: stops the running unit first (graceful: the current turn ends), then starts it. */
  verb?: 'start' | 'restart';
}

/**
 * `systemctl --user start <unit>`, then watches it briefly: when the run ends
 * right away (invalid config, refused state), the reason comes from the last
 * journal lines of that start instead of a misleading "started".
 */
export async function startUnit(unit: string, options: StartUnitOptions): Promise<{ ok: boolean; message: string }> {
  const clean = options.redact ?? ((text: string) => text);
  const verb = options.verb ?? 'start';
  const run = async (args: string[]): Promise<string> => {
    try { return (await options.exec('systemctl', ['--user', ...args])).stdout.trim(); } catch (error) {
      return String((error as { stdout?: string }).stdout ?? '').trim();
    }
  };
  try {
    await options.exec('systemctl', ['--user', verb, unit]);
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, message: clean(`systemctl --user ${verb} ${unit} failed: ${(err.stderr || err.message || '').trim()}`) };
  }
  const deadline = Date.now() + (options.watchMs ?? 8000);
  while (Date.now() < deadline) {
    const state = await run(['is-active', unit]);
    if (state !== 'active' && state !== 'activating') {
      const invocation = await run(['show', '-p', 'InvocationID', '--value', unit]);
      let lines = '';
      try {
        const args = ['--user', '-u', unit, '-n', '12', '--no-pager', '-o', 'cat'];
        if (invocation) args.push(`_SYSTEMD_INVOCATION_ID=${invocation}`);
        lines = (await options.exec('journalctl', args)).stdout.trim();
      } catch { /* journal unavailable */ }
      return { ok: false, message: clean(`${unit} ended right after starting (${state || 'unknown'})${lines ? ':\n' + lines : ''}`) };
    }
    await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
  }
  return { ok: true, message: `${verb === 'restart' ? 'Restarted' : 'Started'} ${unit}` };
}
