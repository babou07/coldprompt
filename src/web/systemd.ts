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
