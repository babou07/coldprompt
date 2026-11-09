import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ConsoleServer } from '../src/console/server.js';
import { WebServer, loadOrCreateToken } from '../src/web/server.js';
import { renderUnits, startUnit } from '../src/web/systemd.js';
import { describeItem } from '../src/adapters/codex.js';
import { Store } from '../src/store.js';
import { deferred, FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor } from './helpers.js';

const TOKEN = 't'.repeat(43);

async function startWeb(store: Store, startRun?: () => Promise<{ ok: boolean; message: string }>) {
  const web = new WebServer({ store, socketPath: store.socketPath, host: '127.0.0.1', port: 0, token: TOKEN, projectName: 'test', reconnectMs: 20, startRun });
  await web.start();
  const base = `http://127.0.0.1:${web.address!.port}`;
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(base + path, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  const post = (path: string, body: unknown, token: string | null = TOKEN) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, token);
  return { web, base, call, post };
}

/** Reads server-sent events from a fetch response until `until` returns true. */
async function readEvents(res: Response, until: (events: Array<{ event: string; data: any }>) => boolean, timeoutMs = 3000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (!until(events)) {
    if (Date.now() > deadline) throw new Error(`timed out; got ${events.map((e) => e.event + ':' + (e.data?.type ?? '')).join(', ')}`);
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (name && data) events.push({ event: name, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

test('web token is random, private (0600) and reused', async () => {
  const home = await tempDir();
  try {
    const store = new Store(home.path);
    const first = await loadOrCreateToken(store);
    assert.ok(first.length >= 40);
    assert.equal((await stat(join(home.path, 'web-token'))).mode & 0o777, 0o600);
    assert.equal(await loadOrCreateToken(store), first);
  } finally {
    await home.cleanup();
  }
});

test('web console: auth, command allowlist, live worker activity, turn reports', async () => {
  const home = await tempDir(); const work = await tempDir('coldprompt-work-');
  const release = deferred();
  let h: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const worker = new FakeWorkerAdapter([async (_input, _session, options) => {
      await options.onProgress?.({ phase: 'started', kind: 'command', summary: 'npm test' });
      await release.promise;
      await options.onProgress?.({ phase: 'completed', kind: 'command', summary: 'npm test', status: 'completed', detail: '4 passing' });
      return { finalResponse: 'All four tests pass.' };
    }]);
    const supervisor = new FakeSupervisorAdapter([{ decision: 'BLOCKED', reason: 'judgment needed' }]);
    h = await start(home.path, work.path, makeConfig(), worker, supervisor);
    const consoleServer = new ConsoleServer(h.orchestrator, h.store.socketPath);
    await consoleServer.start();
    const { web, call, post } = await startWeb(h.store);
    try {
      // Static page: no auth, strict CSP.
      const page = await call('/', {}, null);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'.*script-src 'self'/);
      assert.match(await page.text(), /<script src="\/app.js"/);

      // API: bearer token required; a wrong token of the right length is refused too.
      assert.equal((await call('/api/stream', {}, null)).status, 401);
      assert.equal((await call('/api/stream', {}, 'x'.repeat(43))).status, 401);
      assert.equal((await post('/api/command', { command: 'status' }, null)).status, 401);

      // JSON only (blocks HTML-form CSRF), allowlisted commands only.
      const form = await call('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'command=stop' });
      assert.equal(form.status, 415);
      assert.equal((await post('/api/command', { command: 'quit' })).status, 400);

      // Live stream: hello snapshot, then worker progress while the turn runs.
      await waitFor(() => web['connected'] === true, 3000, 'web connected to the orchestrator');
      const run = h;
      await waitFor(async () => (await run.store.readEvents()).some((e) => e.type === 'worker.progress'), 3000, 'progress persisted');
      const stream = await call('/api/stream');
      assert.equal(stream.status, 200);
      const live = readEvents(stream, (events) => events.some((e) => e.event === 'event' && e.data.type === 'worker.progress' && e.data.data.phase === 'completed'));
      await new Promise((r) => setTimeout(r, 50));
      release.resolve();
      const events = await live;
      assert.equal(events[0].event, 'hello');
      assert.equal(events[0].data.project, 'test');
      assert.ok(events[0].data.history.some((e: any) => e.type === 'worker.progress' && e.data.summary === 'npm test'), 'history includes the running command');
      const done = events.find((e) => e.event === 'event' && e.data.data?.phase === 'completed')!;
      assert.equal(done.data.data.detail, '4 passing');
      assert.ok(done.data.at, 'live events carry a timestamp');

      await waitFor(() => run.orchestrator.snapshotState.status === 'BLOCKED');
      const status = await (await post('/api/command', { command: 'status' })).json();
      assert.equal(status.ok, true);
      assert.equal(status.data.blocked.kind, 'SUPERVISOR');
      // The plan checklist: every session and mission with its progress.
      assert.deepEqual(status.data.plan, [{ id: 'main', title: null, index: 1, missions: [{ id: 'a', title: 'Mission A', index: 1, status: 'ACTIVE' }] }]);

      // Turn report from artifacts; ids cannot escape the turns directory.
      const turnId = run.orchestrator.snapshotState.lastReview ? (await run.store.readEvents()).find((e) => e.type === 'turn.completed')!.data.turnId : '';
      const report = await (await call(`/api/turn/${turnId}`)).json();
      assert.equal(report.ok, true);
      assert.equal(report.data.finalResponse, 'All four tests pass.');
      assert.equal(report.data.review.decision, 'BLOCKED');
      assert.equal((await call('/api/turn/..%2F..%2Fstate')).status, 400);
      assert.equal((await call('/api/turn/t9999-ffffff')).status, 404);

      // Resolution through the web goes through the orchestrator's validation.
      assert.equal((await (await post('/api/command', { command: 'resume', text: '' })).json()).ok, false);
      assert.equal((await (await post('/api/command', { command: 'stop' })).json()).ok, true);
      await run.done;
      // Start is disabled unless a run unit is configured; while connected it is refused anyway.
      assert.ok([409, 501].includes((await post('/api/start', {})).status));
    } finally {
      await web.stop();
      await consoleServer.stop();
    }
  } finally {
    release.resolve();
    h?.orchestrator.requestStop();
    await h?.done.catch(() => undefined);
    await home.cleanup(); await work.cleanup();
  }
});

test('web console reports the orchestrator as offline and reconnects', async () => {
  const home = await tempDir(); const work = await tempDir('coldprompt-work-');
  try {
    const store = new Store(home.path);
    const { web, call } = await startWeb(store);
    try {
      const res = await call('/api/stream');
      const [hello] = await readEvents(res, (events) => events.length >= 1);
      assert.equal(hello.data.connected, false);

      const worker = new FakeWorkerAdapter(['done']);
      const supervisor = new FakeSupervisorAdapter([{ decision: 'BLOCKED', reason: 'wait' }]);
      const h = await start(home.path, work.path, makeConfig(), worker, supervisor);
      const consoleServer = new ConsoleServer(h.orchestrator, h.store.socketPath);
      await consoleServer.start();
      await waitFor(() => web['connected'] === true, 3000, 'reconnected');
      // Failed attempts while offline must not leave extra connections (duplicate events).
      await new Promise((r) => setTimeout(r, 100));
      assert.equal((consoleServer as any).clients.size, 1);
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

test('Codex stream items become compact progress records', () => {
  const started = describeItem({ id: '1', type: 'command_execution', command: 'git status', aggregated_output: '', status: 'in_progress' }, 'started');
  assert.deepEqual(started, { phase: 'started', kind: 'command', summary: 'git status', status: 'in_progress', detail: undefined });
  const finished = describeItem({ id: '1', type: 'command_execution', command: 'git status', aggregated_output: 'x'.repeat(5000), exit_code: 0, status: 'completed' }, 'completed')!;
  assert.ok(finished.detail!.length <= 2001);
  assert.equal(describeItem({ id: '1', type: 'command_execution', command: 'ls', aggregated_output: 'a', status: 'in_progress' }, 'updated'), undefined, 'output updates are not streamed');
  const tool = describeItem({ id: '2', type: 'mcp_tool_call', server: 'konnect', tool: 'run_drc', arguments: { board: 'x' }, status: 'in_progress' }, 'started')!;
  assert.equal(tool.summary, 'konnect.run_drc');
  assert.match(tool.detail!, /board/);
  const plan = describeItem({ id: '3', type: 'todo_list', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }] }, 'updated')!;
  assert.equal(plan.summary, '1/2 steps done');
  assert.equal(describeItem({ id: '4', type: 'agent_message', text: 'Hello\nworld' }, 'completed')!.summary, 'Hello');
});

test('systemd units: graceful stop, no restart, web always on', () => {
  const units = renderUnits({
    launcher: '/home/u/coldprompt/bin/coldprompt', configPath: '/home/u/work/coldprompt.yaml',
    pathDirectories: ['/home/u/.nvm/bin', '/home/u/.local/bin'], webHost: '127.0.0.1', webPort: 8787, runUnit: 'coldprompt-run.service'
  });
  const run = units['coldprompt-run.service'];
  const web = units['coldprompt-web.service'];
  assert.match(run, /KillMode=mixed/);
  assert.match(run, /TimeoutStopSec=infinity/);
  assert.match(run, /Restart=no/);
  assert.match(run, /SuccessExitStatus=3/);
  assert.match(run, /UnsetEnvironment=DRY_RUN/);
  assert.match(run, /WorkingDirectory=\/home\/u\/work\n/);
  assert.match(run, /Environment=COLDPROMPT_CONFIG=\/home\/u\/work\/coldprompt.yaml/);
  assert.match(run, /PATH=\/home\/u\/.nvm\/bin:\/home\/u\/.local\/bin:/);
  assert.match(web, /ExecStart=\/home\/u\/coldprompt\/bin\/coldprompt web --host 127.0.0.1 --port 8787 --run-unit coldprompt-run.service/);
  assert.match(web, /WantedBy=default.target/);
  assert.doesNotMatch(run, /\[Install\]/, 'the run is started on purpose, never at login');
});

test('web console: Start run only when stopped, one start at a time, failures reported', async () => {
  const home = await tempDir();
  try {
    const store = new Store(home.path);
    const gate = deferred<void>();
    let calls = 0;
    const { web, call, post } = await startWeb(store, async () => {
      calls += 1;
      await gate.promise;
      return calls === 1 ? { ok: true, message: 'Started coldprompt-run.service' } : { ok: false, message: 'coldprompt-run.service ended right after starting (failed):\nInvalid config' };
    });
    try {
      const hello = (await readEvents(await call('/api/stream'), (e) => e.length > 0))[0];
      assert.equal(hello.data.canStart, true);
      assert.equal(hello.data.connected, false);
      assert.equal((await post('/api/start', {}, null)).status, 401);
      const first = post('/api/start', {});
      await waitFor(() => calls === 1);
      assert.equal((await post('/api/start', {})).status, 409, 'a second click while starting is refused');
      gate.resolve();
      assert.deepEqual(await (await first).json(), { ok: true, data: { message: 'Started coldprompt-run.service' } });
      const failed = await post('/api/start', {});
      assert.equal(failed.status, 500);
      assert.match((await failed.json()).error, /Invalid config/);
    } finally {
      await web.stop();
    }
    // Without a run unit, the page gets canStart false and the API says so.
    const plain = await startWeb(store);
    try {
      assert.equal((await readEvents(await plain.call('/api/stream'), (e) => e.length > 0))[0].data.canStart, false);
      assert.equal((await plain.post('/api/start', {})).status, 501);
    } finally {
      await plain.web.stop();
    }
  } finally {
    await home.cleanup();
  }
});

test('startUnit: started, ended right away (journal of that start, redacted), systemctl refused', async () => {
  const fake = (states: string[], options: { startError?: Error } = {}) => {
    const seen: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      seen.push([file, ...args]);
      if (args[1] === 'start' && options.startError) throw options.startError;
      if (args[1] === 'is-active') {
        const state = states.shift() ?? 'active';
        if (state !== 'active') throw Object.assign(new Error('exit 3'), { stdout: state + '\n' });
        return { stdout: 'active\n' };
      }
      if (args[1] === 'show') return { stdout: 'abc123\n' };
      if (file === 'journalctl') return { stdout: 'Invalid config: token=SECRET\n' };
      return { stdout: '' };
    };
    return { exec, seen };
  };
  const ok = fake(['activating', 'active']);
  assert.deepEqual(await startUnit('run.service', { exec: ok.exec, watchMs: 30, pollMs: 5 }), { ok: true, message: 'Started run.service' });
  assert.deepEqual(ok.seen[0], ['systemctl', '--user', 'start', 'run.service']);

  const dead = fake(['failed']);
  const result = await startUnit('run.service', { exec: dead.exec, watchMs: 1000, pollMs: 5, redact: (s) => s.replace('SECRET', '[redacted]') });
  assert.equal(result.ok, false);
  assert.match(result.message, /ended right after starting \(failed\):\nInvalid config: token=\[redacted\]/);
  assert.ok(dead.seen.some((c) => c[0] === 'journalctl' && c.includes('_SYSTEMD_INVOCATION_ID=abc123')), 'only the journal of this start');

  const refused = fake([], { startError: Object.assign(new Error('boom'), { stderr: 'Unit not found.' }) });
  assert.deepEqual(await startUnit('run.service', { exec: refused.exec }), { ok: false, message: 'systemctl --user start run.service failed: Unit not found.' });
});
