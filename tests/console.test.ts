import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { ConsoleServer } from '../src/console/server.js';
import { ConsoleClient, runInteractiveConsole, sendOnce } from '../src/console/client.js';
import { parseCommandLine } from '../src/console/protocol.js';
import { deferred, FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor } from './helpers.js';

async function blockedHarness(home: string, work: string) {
  const worker = new FakeWorkerAdapter(['needs a human']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'BLOCKED', reason: 'judgment needed' }, { decision: 'MISSION_COMPLETE' }]);
  const h = await start(home, work, makeConfig(), worker, supervisor);
  const server = new ConsoleServer(h.orchestrator, h.store.socketPath);
  await server.start();
  await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
  return { ...h, server };
}

test('command line parsing', () => {
  assert.deepEqual(parseCommandLine('  tell --raw  use v2 '), { command: 'tell', raw: true, text: 'use v2' });
  assert.deepEqual(parseCommandLine('ASK why?'), { command: 'ask', raw: false, text: 'why?' });
  assert.deepEqual(parseCommandLine('resume'), { command: 'resume', raw: false, text: '' });
  assert.equal(parseCommandLine('   '), undefined);
});

test('socket is private (0600), multiple clients share events, garbage is rejected', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const h = await blockedHarness(home.path, work.path);
    assert.equal((await stat(h.store.socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(home.path)).mode & 0o777, 0o700);

    const a = new ConsoleClient(h.store.socketPath);
    const b = new ConsoleClient(h.store.socketPath);
    const seenA: string[] = []; const seenB: string[] = [];
    a.onMessage = (m) => { if (m.type === 'event') seenA.push(m.event.type); };
    b.onMessage = (m) => { if (m.type === 'event') seenB.push(m.event.type); };
    await a.connect(); await b.connect();
    const r = await a.send({ command: 'ask', text: 'what is blocked?' });
    assert.equal(r.ok, true);
    await waitFor(() => seenA.includes('hot_prompt.answered') && seenB.includes('hot_prompt.answered'));
    assert.equal((await b.send({ command: 'bogus' })).ok, false);

    const raw = createConnection(h.store.socketPath);
    const reply = deferred<string>();
    let buf = '';
    raw.on('data', (c) => { buf += c; if (buf.includes('Invalid message')) reply.resolve(buf); });
    raw.write('this is not json\n');
    assert.match(await reply.promise, /Invalid message/);
    raw.destroy();
    a.close(); b.close();

    assert.equal((await sendOnce(h.store.socketPath, { command: 'resume', text: 'go' })).response.ok, true);
    await h.done;
    await h.server.stop();
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('sendOnce waits for the supervisor answer to an ask', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const h = await blockedHarness(home.path, work.path);
    const { response, text } = await sendOnce(h.store.socketPath, { command: 'ask', text: 'status of tests?' }, 3000);
    assert.equal(response.ok, true);
    assert.match(text, /fake answer to: status of tests\?/);
    h.orchestrator.requestStop();
    await h.done;
    await h.server.stop();
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('a stale socket file is replaced; a live listener is refused', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const gate = deferred();
    const h = await start(home.path, work.path, makeConfig(), new FakeWorkerAdapter([async () => { await gate.promise; return {}; }]), new FakeSupervisorAdapter());
    // live foreign listener
    const foreign = createServer(() => undefined);
    await new Promise<void>((r) => foreign.listen(h.store.socketPath, r));
    await assert.rejects(new ConsoleServer(h.orchestrator, h.store.socketPath).start(), /Another orchestrator/);
    await new Promise<void>((r) => foreign.close(() => r()));
    // a regular file is never deleted
    await writeFile(h.store.socketPath, 'not a socket');
    await assert.rejects(new ConsoleServer(h.orchestrator, h.store.socketPath).start(), /not a socket/);
    gate.resolve();
    await h.done;
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('interactive console (SSH/Termux style line I/O) reconnects after the orchestrator restarts', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const h = await blockedHarness(home.path, work.path);
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => { text += c.toString(); });
    const repl = runInteractiveConsole(h.store.socketPath, { input, output, reconnectDelayMs: 20 });
    await waitFor(() => text.includes('BLOCKED [SUPERVISOR]'), 3000, 'hello status');
    input.write('ask is it safe?\n');
    await waitFor(() => text.includes('[answer '), 3000, 'answer');

    // Orchestrator restart (same state directory).
    h.orchestrator.requestStop();
    await h.done;
    await h.server.stop();
    await waitFor(() => text.includes('reconnecting'), 3000, 'disconnect notice');
    const h2 = await blockedHarness2(home.path, work.path);
    await waitFor(() => text.split('BLOCKED [SUPERVISOR]').length > 2, 5000, 'reconnected hello');
    input.write('resume use the safe path\n');
    await waitFor(() => text.includes('Resolution recorded'), 3000, 'resume ack');
    await h2.done;
    input.write('quit\n');
    await repl;
    await h2.server.stop();
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

async function blockedHarness2(home: string, work: string) {
  const h = await start(home, work, makeConfig(), new FakeWorkerAdapter(), new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]));
  const server = new ConsoleServer(h.orchestrator, h.store.socketPath);
  await server.start();
  return { ...h, server };
}

test('deep state directories get a short private socket path that clients compute identically', async () => {
  const base = await tempDir(); const work = await tempDir();
  try {
    const deep = `${base.path}/${'x'.repeat(60)}/${'y'.repeat(60)}`;
    const h = await blockedHarness(deep, work.path);
    assert.ok(Buffer.byteLength(h.store.socketPath) < 100);
    assert.equal(new (await import('../src/store.js')).Store(deep).socketPath, h.store.socketPath);
    assert.equal((await stat(h.store.socketPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(h.store.socketPath, '..'))).mode & 0o777, 0o700);
    const { text } = await sendOnce(h.store.socketPath, { command: 'status' }, 0);
    assert.match(text, /status: BLOCKED/);
    h.orchestrator.requestStop();
    await h.done;
    await h.server.stop();
  } finally {
    await base.cleanup(); await work.cleanup();
  }
});
