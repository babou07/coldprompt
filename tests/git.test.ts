import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitsBetween, snapshot } from '../src/git.js';
import { buildVerifiers, GitCleanVerifier } from '../src/verification.js';
import { FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor } from './helpers.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
}

async function repo() {
  const dir = await tempDir('coldprompt-repo-');
  git(dir.path, 'init', '-q', '-b', 'main');
  await writeFile(join(dir.path, 'a.txt'), 'a\n');
  git(dir.path, 'add', '.');
  git(dir.path, 'commit', '-qm', 'init');
  return dir;
}

test('snapshot records HEAD, cleanliness, ahead/behind and commits created', async () => {
  const r = await repo(); const remote = await tempDir('coldprompt-remote-');
  try {
    git(remote.path, 'init', '-q', '--bare');
    git(r.path, 'remote', 'add', 'origin', remote.path);
    git(r.path, 'push', '-q', '-u', 'origin', 'main');
    const before = await snapshot(r.path);
    assert.equal(before.isRepo, true);
    assert.equal(before.dirty, false);
    assert.equal(before.branch, 'main');
    assert.equal(before.upstream, 'origin/main');
    assert.equal(before.ahead, 0);
    await writeFile(join(r.path, 'b.txt'), 'b\n');
    assert.equal((await snapshot(r.path)).dirty, true);
    git(r.path, 'add', '.');
    git(r.path, 'commit', '-qm', 'b');
    const after = await snapshot(r.path);
    assert.equal(after.ahead, 1);
    assert.deepEqual(await commitsBetween(r.path, before.head, after.head), [after.head]);
    assert.equal((await snapshot(remote.path)).isRepo, false, 'bare repo has no work tree');
  } finally {
    await r.cleanup(); await remote.cleanup();
  }
});

test('turn records carry git evidence and commits; git-clean gates completion', async () => {
  const r = await repo(); const home = await tempDir();
  try {
    const worker = new FakeWorkerAdapter([
      async () => { await writeFile(join(r.path, 'new.txt'), 'x'); git(r.path, 'add', '.'); git(r.path, 'commit', '-qm', 'worker commit'); return { finalResponse: 'committed' }; },
      async () => { await writeFile(join(r.path, 'dirty.txt'), 'x'); return { finalResponse: 'left dirty' }; },
      async () => { git(r.path, 'add', '.'); git(r.path, 'commit', '-qm', 'clean up'); return { finalResponse: 'clean' }; }
    ]);
    const supervisor = new FakeSupervisorAdapter([{ decision: 'CONTINUE' }, { decision: 'MISSION_COMPLETE' }, { decision: 'MISSION_COMPLETE' }]);
    const h = await start(home.path, r.path, makeConfig({ runtime: { verifyGitCleanOnCompletion: true } }), worker, supervisor);
    await h.done;
    assert.equal(supervisor.evaluations[0].commits.length, 1);
    assert.equal(supervisor.evaluations[1].gitAfter.dirty, true);
    assert.match(worker.turnInputs[2], /git-clean FAILED[\s\S]*uncommitted/);
    const state = await h.store.load();
    assert.equal(state.status, 'COMPLETED');
    assert.equal(state.lastGit?.dirty, false);
  } finally {
    await r.cleanup(); await home.cleanup();
  }
});

test('analysis missions need no commits', async () => {
  const r = await repo(); const home = await tempDir();
  try {
    const config = makeConfig({ runtime: { verifyGitCleanOnCompletion: true }, missions: [{ id: 'an', title: 'Analysis', prompt: { type: 'COLD_PROMPT', content: 'analyze' }, execution: { readOnly: true } }] });
    const h = await start(home.path, r.path, config, new FakeWorkerAdapter(['report']), new FakeSupervisorAdapter());
    await h.done;
    assert.equal((await h.store.load()).status, 'COMPLETED');
  } finally {
    await r.cleanup(); await home.cleanup();
  }
});

test('a read-only mission that changes the repository is blocked before review', async () => {
  const r = await repo(); const home = await tempDir();
  try {
    const config = makeConfig({ missions: [{ id: 'audit', title: 'Audit', prompt: { type: 'COLD_PROMPT', content: 'audit' }, execution: { readOnly: true } }] });
    const worker = new FakeWorkerAdapter([async () => { await writeFile(join(r.path, 'a.txt'), 'changed'); return { finalResponse: 'oops' }; }]);
    const supervisor = new FakeSupervisorAdapter();
    const h = await start(home.path, r.path, config, worker, supervisor);
    await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
    assert.equal(h.orchestrator.snapshotState.blocked?.kind, 'READ_ONLY_VIOLATION');
    assert.equal(h.orchestrator.snapshotState.pendingTurn?.phase, 'WORKER_DONE');
    assert.equal(supervisor.evaluations.length, 0);
    git(r.path, 'checkout', '--', 'a.txt');
    await h.orchestrator.handleCommand({ command: 'resume', text: 'reverted the change manually' });
    await h.done;
    assert.equal(supervisor.evaluations.length, 1, 'the persisted turn is reviewed after resolution');
  } finally {
    await r.cleanup(); await home.cleanup();
  }
});

test('an in-progress merge is an unsafe repository state: no worker turn starts', async () => {
  const r = await repo(); const home = await tempDir();
  try {
    git(r.path, 'checkout', '-qb', 'other');
    await writeFile(join(r.path, 'a.txt'), 'other\n');
    git(r.path, 'commit', '-qam', 'other');
    git(r.path, 'checkout', '-q', 'main');
    await writeFile(join(r.path, 'a.txt'), 'main\n');
    git(r.path, 'commit', '-qam', 'main');
    try { git(r.path, 'merge', 'other'); } catch { /* conflict expected */ }
    assert.equal((await snapshot(r.path)).operationInProgress, 'merge');
    const worker = new FakeWorkerAdapter();
    const h = await start(home.path, r.path, makeConfig(), worker, new FakeSupervisorAdapter());
    await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
    assert.equal(h.orchestrator.snapshotState.blocked?.kind, 'UNSAFE_REPOSITORY');
    assert.equal(worker.turnInputs.length, 0);
    assert.equal((await new GitCleanVerifier().run({ workingDirectory: r.path, mission: makeConfig().missions[0], phase: 'completion' })).passed, false);
    h.orchestrator.requestStop();
    await h.done;
  } finally {
    await r.cleanup(); await home.cleanup();
  }
});

test('project-specific verification plugins are loaded from the config directory', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir.path, 'check.mjs'), `export function createVerifier(options) {
      return { name: 'ignored', when: 'turn', async run(ctx) { return { passed: ctx.phase === options.phase, output: 'domain check ' + ctx.mission.id }; } };
    }`);
    const config = makeConfig({ verification: { plugins: [{ name: 'domain', module: './check.mjs', options: { phase: 'completion' } }] } });
    const [verifier] = await buildVerifiers(config, dir.path);
    assert.equal(verifier.name, 'domain');
    assert.equal(verifier.when, 'completion');
    const result = await verifier.run({ workingDirectory: dir.path, mission: config.missions[0], phase: 'completion' });
    assert.deepEqual(result, { passed: true, output: 'domain check a' });
  } finally {
    await dir.cleanup();
  }
});
