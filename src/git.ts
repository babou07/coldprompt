import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { GitSnapshot } from './types.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** Read-only snapshot of the repository (GIT_OPTIONAL_LOCKS=0 avoids index writes). */
export async function snapshot(cwd: string): Promise<GitSnapshot> {
  const capturedAt = new Date().toISOString();
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return { isRepo: false, capturedAt };
  const [head, branch, status, upstream, gitDirRaw] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(cwd, ['rev-parse', '--git-dir'])
  ]);
  const changedFiles = status ? status.split('\n').filter(Boolean).length : 0;
  const result: GitSnapshot = { isRepo: true, head, branch, dirty: changedFiles > 0, changedFiles, capturedAt };
  if (upstream) {
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    const [behind, ahead] = (counts ?? '').split(/\s+/).map(Number);
    Object.assign(result, { upstream, ahead: ahead || 0, behind: behind || 0 });
  }
  if (gitDirRaw) {
    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : join(cwd, gitDirRaw);
    for (const [file, name] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']] as const) {
      if (await exists(join(gitDir, file))) { result.operationInProgress = name; break; }
    }
  }
  return result;
}

export async function commitsBetween(cwd: string, before?: string, after?: string): Promise<string[]> {
  if (!before || !after || before === after) return [];
  const out = await git(cwd, ['rev-list', '--reverse', `${before}..${after}`]);
  return out ? out.split('\n').filter(Boolean) : [];
}

export function repositoryChanged(before: GitSnapshot, after: GitSnapshot): boolean {
  if (!before.isRepo || !after.isRepo) return false;
  return before.head !== after.head || (!before.dirty && Boolean(after.dirty)) || before.changedFiles !== after.changedFiles;
}
