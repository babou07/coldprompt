import { spawn } from 'node:child_process';

/** Child-process helpers shared by the CLI-based adapters (injectable for tests). */

export interface RunResult { code: number | null; stdout: string; stderr: string }

export type CommandRunner = (
  command: string,
  args: string[],
  options: { input?: string; cwd: string; signal?: AbortSignal; timeoutMs: number }
) => Promise<RunResult>;

export const spawnRunner: CommandRunner = (command, args, { input, cwd, signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
  });
