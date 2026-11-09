import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { archiveCheck, archivePlan, notFinishedReason } from '../src/archive.js';
import { initialState, Store } from '../src/store.js';
import { WebServer } from '../src/web/server.js';
import { FakeSupervisorAdapter, FakeWorkerAdapter, start, tempDir } from './helpers.js';

const plan = (sessions: string[], extra = '') => [
  'version: 1',
  'project: { name: test, workingDirectory: . }',
  'worker: { provider: codex }',
  'supervisor: { provider: claude }',
  'runtime: { maxTurns: 50, maxHours: 1, statusEvery: 100, retryDelaysSeconds: [30], verifyGitCleanOnCompletion: false, autoApproveMissions: true }',
  'sessions:',
  ...sessions.map((s) => `  - sessions/${s}.yaml`),
  extra
].join('\n') + '\n';
const session = (id: string, missions: string[]) =>
  `id: ${id}\nmissions:\n${missions.map((m) => `  - id: ${m}\n    title: ${m}\n    prompt: { type: COLD_PROMPT, content: do ${m} }\n`).join('')}`;

async function writePlan(dir: string, sessions: Record<string, string[]>, extra = ''): Promise<string> {
  await mkdir(join(dir, 'sessions'), { recursive: true });
  for (const [id, missions] of Object.entries(sessions)) await writeFile(join(dir, 'sessions', `${id}.yaml`), session(id, missions));
  const path = join(dir, 'coldprompt.yaml');
  await writeFile(path, plan(Object.keys(sessions), extra));
  return path;
}

test('archive: a finished plan is COMPLETED, without a pending turn, finalize done when configured', () => {
  const s = { ...initialState(), status: 'COMPLETED' as const };
  assert.equal(notFinishedReason(s), undefined);
  assert.match(notFinishedReason({ ...s, status: 'BLOCKED' })!, /not complete \(status BLOCKED\)/);
  assert.match(notFinishedReason({ ...s, finalize: { status: 'FAILED', afterMission: 'a', at: '', error: 'smtp' } })!, /finalize step failed \(smtp\)/);
  assert.match(notFinishedReason({ ...s, finalizeConfigured: true })!, /has not run yet/);
  assert.match(notFinishedReason(s, true)!, /has not run yet/);
  assert.equal(notFinishedReason({ ...s, finalizeConfigured: false }, true), undefined, 'the state records the plan as it ran');
  assert.equal(notFinishedReason({ ...s, finalizeConfigured: true, finalize: { status: 'DONE', afterMission: 'a', at: '' } }), undefined);
});

test('a finished plan replaced in the configuration is archived at the next start; the new plan runs from its first mission', async () => {
  const home = await tempDir();
  const work = await tempDir();
  try {
    const first = await writePlan(work.path, { s1: ['a', 'b'] });
    let h = await start(home.path, work.path, await loadConfig(first), new FakeWorkerAdapter(['A', 'B']), new FakeSupervisorAdapter(), { configPath: first });
    assert.equal((await h.done as any).status, 'COMPLETED');
    assert.deepEqual((await readdir(join(home.path, 'plan'))).sort(), ['coldprompt.yaml', 'sessions']);

    // A new plan with as many missions: before, it silently resumed at index 2.
    const second = await writePlan(work.path, { s2: ['x', 'y', 'z'] });
    const worker = new FakeWorkerAdapter(['X', 'Y', 'Z']);
    h = await start(home.path, work.path, await loadConfig(second), worker, new FakeSupervisorAdapter(), { configPath: second });
    const state = await h.done as any;
    assert.equal(state.status, 'COMPLETED');
    assert.deepEqual(Object.keys(state.missions), ['x', 'y', 'z']);
    assert.equal(worker.turnInputs.length, 3);
    assert.match(worker.turnInputs[0], /do x/);

    const archives = await readdir(join(home.path, 'archive'));
    assert.equal(archives.length, 1);
    assert.match(archives[0], /^\d{4}-\d{2}-\d{2}T\d{4}-s1$/);
    const dir = join(home.path, 'archive', archives[0]);
    assert.deepEqual((await readdir(dir)).sort(), ['archive.json', 'events.jsonl', 'plan', 'state.json', 'turns']);
    const info = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    assert.equal(info.reason, 'auto');
    assert.deepEqual(info.missions, { total: 2, completed: 2 });
    assert.equal(info.plan, 'snapshot');
    assert.match(await readFile(join(dir, 'plan', 'sessions', 's1.yaml'), 'utf8'), /id: s1/);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).missions), ['a', 'b']);
    const events = await new Store(home.path).readEvents();
    assert.equal(events.find((e) => e.type === 'plan.archived')?.data.reason, 'auto');
    assert.match(await readFile(join(home.path, 'plan', 'sessions', 's2.yaml'), 'utf8'), /id: s2/);
  } finally {
    await home.cleanup();
    await work.cleanup();
  }
});

test('an unfinished plan replaced in the configuration is refused, not archived', async () => {
  const home = await tempDir();
  const work = await tempDir();
  try {
    const first = await writePlan(work.path, { s1: ['a', 'b'] });
    const store = new Store(home.path);
    await store.save({ ...initialState(), status: 'STOPPED', missionIndex: 1, missions: { a: { status: 'COMPLETED', session: 's1' } } as any });
    const second = await writePlan(work.path, { s2: ['x', 'y'] });
    await assert.rejects(
      start(home.path, work.path, await loadConfig(second), new FakeWorkerAdapter(), new FakeSupervisorAdapter(), { configPath: second }),
      /completed mission "a" is no longer in the plan[\s\S]*not finished \(the plan is not complete \(status STOPPED\)\)[\s\S]*coldprompt archive --force/
    );
    assert.deepEqual(await readdir(home.path).then((n) => n.filter((f) => f === 'archive')), []);
    void first;
  } finally {
    await home.cleanup();
    await work.cleanup();
  }
});

test('coldprompt archive: refused while running or unfinished (unless forced); the web token stays', async () => {
  const home = await tempDir();
  const work = await tempDir();
  try {
    const path = await writePlan(work.path, { s1: ['a'] }, 'finalize: { prompt: mail it }');
    const config = await loadConfig(path);
    const store = new Store(home.path);
    assert.deepEqual(await archiveCheck(store, config), { archivable: false, reason: 'there is no run to archive' });
    await writeFile(join(home.path, 'web-token'), 'x'.repeat(43));
    await store.save({ ...initialState(), status: 'COMPLETED', missionIndex: 1, sessions: { s1: {} }, missions: { a: { status: 'COMPLETED', session: 's1' } } as any });

    const owner = new Store(home.path);
    await owner.acquireLock();
    const busy = await archivePlan(store, { configPath: path, config });
    assert.equal(busy.ok, false);
    assert.match((busy as any).error, /ColdPrompt is running/);
    await owner.releaseLock();

    const pending = await archivePlan(store, { configPath: path, config });
    assert.match((pending as any).error, /finalize step has not run yet[\s\S]*--force/);
    const forced = await archivePlan(store, { configPath: path, config, force: true });
    assert.equal(forced.ok, true);
    const dir = (forced as any).directory as string;
    const info = JSON.parse(await readFile(join(dir, 'archive.json'), 'utf8'));
    assert.equal(info.reason, 'forced');
    assert.equal(info.plan, 'current config', 'a run without snapshot gets a copy of the matching current files');
    assert.match(await readFile(join(dir, 'plan', 'coldprompt.yaml'), 'utf8'), /sessions\/s1\.yaml/);
    assert.deepEqual((await readdir(home.path)).filter((f) => f !== 'turns').sort(), ['archive', 'web-token']);
    assert.equal(await store.load().then((s) => s.status), 'IDLE');
  } finally {
    await home.cleanup();
    await work.cleanup();
  }
});

test('web console: "Archive plan" only for a finished plan while stopped', async () => {
  const home = await tempDir();
  try {
    const store = new Store(home.path);
    await store.save({ ...initialState(), status: 'BLOCKED' });
    const web = new WebServer({
      store, socketPath: join(home.path, 'none.sock'), host: '127.0.0.1', port: 0, token: 't'.repeat(43), projectName: 't', reconnectMs: 20,
      archive: { check: () => archiveCheck(store), run: () => archivePlan(store, {}) }
    });
    await web.start();
    const base = `http://127.0.0.1:${web.address!.port}`;
    const headers = { Authorization: `Bearer ${'t'.repeat(43)}`, 'Content-Type': 'application/json' };
    const get = async () => (await (await fetch(base + '/api/archive', { headers })).json()).data;
    const post = () => fetch(base + '/api/archive', { method: 'POST', headers, body: '{}' });
    try {
      assert.deepEqual(await get(), { archivable: false, reason: 'the plan is not complete (status BLOCKED)' });
      const refused = await post();
      assert.equal(refused.status, 409);
      assert.match((await refused.json()).error, /not complete/);

      await store.save({ ...initialState(), status: 'COMPLETED' });
      assert.deepEqual(await get(), { archivable: true });
      const ok = await (await post()).json();
      assert.equal(ok.ok, true);
      assert.match(ok.data.message, /Plan archived to .*archive/);
      assert.equal((await readdir(join(home.path, 'archive'))).length, 1);
      assert.deepEqual(await get(), { archivable: false, reason: 'there is no run to archive' });
    } finally {
      await web.stop();
    }
  } finally {
    await home.cleanup();
  }
});

test('a finished plan whose missions were only reordered or partly kept is refused, with the archive hint', async () => {
  const home = await tempDir();
  const work = await tempDir();
  try {
    const first = await writePlan(work.path, { s1: ['a', 'b'] });
    const h = await start(home.path, work.path, await loadConfig(first), new FakeWorkerAdapter(['A', 'B']), new FakeSupervisorAdapter(), { configPath: first });
    assert.equal((await h.done as any).status, 'COMPLETED');
    const kept = await writePlan(work.path, { s1: ['b', 'x'] });
    await assert.rejects(
      start(home.path, work.path, await loadConfig(kept), new FakeWorkerAdapter(), new FakeSupervisorAdapter(), { configPath: kept }),
      /still contains missions of the previous run[\s\S]*coldprompt archive/
    );
    assert.equal((await readdir(home.path)).includes('archive'), false);
  } finally {
    await home.cleanup();
    await work.cleanup();
  }
});
