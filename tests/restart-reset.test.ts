import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { archivePlan, planChanges, runCommits, snapshotPlan } from '../src/archive.js';
import { ConsoleServer } from '../src/console/server.js';
import { initialState, Store } from '../src/store.js';
import { WebServer } from '../src/web/server.js';
import { startUnit } from '../src/web/systemd.js';
import { deferred, FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor } from './helpers.js';

const TOKEN = 't'.repeat(43);

async function writePlan(dir: string, content = 'do a'): Promise<string> {
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await writeFile(join(dir, 'sessions', 's1.yaml'), `id: s1\nmissions:\n  - id: a\n    title: a\n    prompt: { type: COLD_PROMPT, content: ${content} }\n`);
  const path = join(dir, 'coldprompt.yaml');
  await writeFile(path, [
    'version: 1',
    'project: { name: test, workingDirectory: . }',
    'worker: { provider: codex }',
    'supervisor: { provider: claude }',
    'runtime: { maxTurns: 50, maxHours: 1, statusEvery: 100, retryDelaysSeconds: [30], verifyGitCleanOnCompletion: false, autoApproveMissions: true }',
    'sessions:',
    '  - sessions/s1.yaml',
    ''
  ].join('\n'));
  return path;
}

async function webOn(store: Store, options: Partial<ConstructorParameters<typeof WebServer>[0]>) {
  const web = new WebServer({ store, socketPath: store.socketPath, host: '127.0.0.1', port: 0, token: TOKEN, projectName: 't', reconnectMs: 20, ...options });
  await web.start();
  const base = `http://127.0.0.1:${web.address!.port}`;
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const get = async (path: string) => (await fetch(base + path, { headers })).json() as Promise<any>;
  const post = (path: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { web, base, headers, get, post };
}

test('planChanges: plan files that differ from the snapshot taken at the run start', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const path = await writePlan(work.path);
    const store = new Store(home.path);
    assert.deepEqual(await planChanges(store, path, await loadConfig(path)), [], 'no snapshot, nothing to compare');
    await store.ensureDirectory();
    await snapshotPlan(store, path, await loadConfig(path));
    assert.deepEqual(await planChanges(store, path, await loadConfig(path)), []);
    await writePlan(work.path, 'do b');
    assert.deepEqual(await planChanges(store, path, await loadConfig(path)), ['sessions/s1.yaml']);
    await writeFile(path, (await readFile(path, 'utf8')).replace('name: test', 'name: other'));
    assert.deepEqual(await planChanges(store, path, await loadConfig(path)), ['coldprompt.yaml', 'sessions/s1.yaml']);
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('reset: archives any stopped run as "reset", lists its commits, never while running', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const path = await writePlan(work.path);
    const config = await loadConfig(path);
    const store = new Store(home.path);
    await store.save({ ...initialState(), status: 'BLOCKED', sessions: { s1: {} }, missions: { a: { status: 'ACTIVE', session: 's1' } } as any });
    await mkdir(join(home.path, 'turns'), { recursive: true });
    await writeFile(join(home.path, 'turns', 't0001-x.worker.json'), JSON.stringify({ commits: ['aaa'] }));
    await writeFile(join(home.path, 'turns', 't0002-y.worker.json'), JSON.stringify({ commits: ['bbb', 'aaa'] }));
    await writeFile(join(home.path, 'turns', 't0002-y.review.json'), JSON.stringify({ commits: ['zzz'] }));
    assert.deepEqual(await runCommits(store), ['aaa', 'bbb']);

    const owner = new Store(home.path);
    await owner.acquireLock();
    assert.match(((await archivePlan(store, { configPath: path, config, reset: true })) as any).error, /ColdPrompt is running/);
    await owner.releaseLock();

    const reset = await archivePlan(store, { configPath: path, config, reset: true });
    assert.equal(reset.ok, true);
    const info = JSON.parse(await readFile(join((reset as any).directory, 'archive.json'), 'utf8'));
    assert.equal(info.reason, 'reset');
    assert.equal(info.status, 'BLOCKED');
    assert.equal((await store.load()).status, 'IDLE');
    assert.deepEqual(await runCommits(store), []);
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('web console: Reset run only while stopped; optional start right after', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const path = await writePlan(work.path);
    const config = await loadConfig(path);
    const store = new Store(home.path);
    await store.save({ ...initialState(), status: 'BLOCKED', sessions: { s1: {} }, missions: { a: { status: 'ACTIVE', session: 's1' } } as any });
    let started = 0;
    const { web, get, post } = await webOn(store, {
      startRun: async () => { started += 1; return { ok: true, message: 'Started run.service' }; },
      reset: {
        check: async () => ({ resettable: true, commits: ['abc1234 pcb(route): something'] }),
        run: () => archivePlan(store, { configPath: path, config, reset: true })
      }
    });
    try {
      assert.deepEqual((await get('/api/reset')).data, { resettable: true, commits: ['abc1234 pcb(route): something'] });
      (web as any).restarting = true; // busy: same as running
      assert.equal((await get('/api/reset')).data.resettable, false);
      assert.equal((await post('/api/reset')).status, 409, 'refused while running');
      (web as any).restarting = false;

      const res = await (await post('/api/reset', { start: true })).json() as any;
      assert.equal(res.ok, true);
      assert.match(res.data.message, /Run reset \(archived to .*archive.*\); Started run\.service/);
      assert.equal(started, 1);
      assert.equal((await readdir(join(home.path, 'archive'))).length, 1);
      assert.equal((await store.load()).status, 'IDLE');
    } finally {
      await web.stop();
    }
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('web console: Restart only while running, answered at once, outcome sent as an event', async () => {
  const home = await tempDir(); const work = await tempDir('coldprompt-work-');
  try {
    const store = new Store(home.path);
    const gate = deferred<void>();
    let calls = 0;
    const { web, base, headers, post, get } = await webOn(store, {
      restartRun: async () => { calls += 1; await gate.promise; return { ok: true, message: 'Restarted run.service' }; },
      planChanges: async () => ['coldprompt.yaml']
    });
    try {
      assert.equal((await post('/api/restart')).status, 409, 'not running: Start run instead');
      assert.deepEqual((await get('/api/config-changes')).data, { files: ['coldprompt.yaml'] });

      const h = await start(home.path, work.path, makeConfig(), new FakeWorkerAdapter(['done']), new FakeSupervisorAdapter([{ decision: 'BLOCKED', reason: 'wait' }]));
      const consoleServer = new ConsoleServer(h.orchestrator, h.store.socketPath);
      await consoleServer.start();
      await waitFor(() => web['connected'] === true, 3000, 'connected');

      const stream = await fetch(base + '/api/stream', { headers });
      const accepted = await post('/api/restart');
      assert.equal(accepted.status, 202);
      assert.match(((await accepted.json()) as any).data.message, /current turn finishes first/);
      assert.equal((await post('/api/restart')).status, 409, 'one restart at a time');
      gate.resolve();

      const reader = stream.body!.getReader();
      let text = '';
      const deadline = Date.now() + 3000;
      while (!text.includes('event: restart') && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /event: restart\ndata: \{"ok":true,"message":"Restarted run.service"\}/);
      assert.equal(calls, 1);
      await reader.cancel();

      h.orchestrator.requestStop();
      await h.done;
      await consoleServer.stop();
    } finally {
      await web.stop();
    }
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('startUnit with verb restart', async () => {
  const seen: string[][] = [];
  const exec = async (file: string, args: string[]) => { seen.push([file, ...args]); return { stdout: 'active\n' }; };
  assert.deepEqual(await startUnit('run.service', { exec, verb: 'restart', watchMs: 20, pollMs: 5 }), { ok: true, message: 'Restarted run.service' });
  assert.deepEqual(seen[0], ['systemctl', '--user', 'restart', 'run.service']);
});
