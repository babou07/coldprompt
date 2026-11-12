import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ConsoleServer } from '../src/console/server.js';
import { handleMessage, runMcpServer, TOOLS, type McpDeps } from '../src/mcp/server.js';
import type { CommandRequest } from '../src/orchestrator.js';
import { Store } from '../src/store.js';
import { FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor } from './helpers.js';

const call = (name: string, args: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const text = (reply: any) => reply.result.content[0].text as string;

/** Deps with a recorded fake console; `running` false makes every command fail as with no orchestrator. */
function fakeDeps(directory: string, running = true) {
  const sent: Array<{ request: CommandRequest; waitMs: number }> = [];
  const deps: McpDeps = {
    store: new Store(directory),
    send: async (request, waitMs) => {
      if (!running) throw new Error('connect ENOENT');
      sent.push({ request, waitMs });
      if (request.command === 'approve' && request.text === 'd-nope') return { response: { ok: false, error: 'Unknown directive "d-nope"' }, text: '' };
      return { response: { ok: true, data: {} }, text: `did ${request.command}${request.text ? ` ${request.text}` : ''}` };
    }
  };
  return { deps, sent };
}

test('mcp: initialize, tools/list with read-only annotations, ping, unknown method, notifications', async () => {
  const dir = await tempDir();
  try {
    const { deps } = fakeDeps(dir.path);
    const init: any = await handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, deps);
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps), undefined);
    const list: any = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps);
    const byName = Object.fromEntries(list.result.tools.map((t: any) => [t.name, t]));
    for (const name of ['status', 'events', 'turn', 'directives']) assert.equal(byName[name].annotations.readOnlyHint, true, name);
    for (const name of ['resume', 'tell', 'approve', 'skip', 'stop', 'ask_supervisor']) assert.equal(byName[name].annotations.readOnlyHint, false, name);
    assert.equal(byName.skip.annotations.destructiveHint, true);
    assert.deepEqual(byName.resume.inputSchema.required, ['resolution']);
    assert.deepEqual(await handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, deps), { jsonrpc: '2.0', id: 2, result: {} });
    assert.equal(((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'bogus' }, deps)) as any).error.code, -32601);
    assert.equal(((await handleMessage(call('nope'), deps)) as any).error.code, -32602);
  } finally {
    await dir.cleanup();
  }
});

test('mcp: commands map to the console protocol; refusals and missing arguments are tool errors', async () => {
  const dir = await tempDir();
  try {
    const { deps, sent } = fakeDeps(dir.path);
    assert.equal(text(await handleMessage(call('resume', { resolution: 'go on' }), deps)), 'did resume go on');
    await handleMessage(call('tell', { directive: 'use v2', raw: true }), deps);
    await handleMessage(call('ask_supervisor', { question: 'why?' }), deps);
    await handleMessage(call('extend', { turns: 3 }), deps);
    await handleMessage(call('approve', { id: 'mission' }), deps);
    assert.deepEqual(sent.map((s) => s.request), [
      { command: 'resume', text: 'go on' },
      { command: 'tell', text: 'use v2', raw: true },
      { command: 'ask', text: 'why?' },
      { command: 'extend', text: '3' },
      { command: 'approve', text: 'mission' }
    ]);
    assert.equal(sent[2].waitMs > 0, true, 'ask waits for the answer');
    assert.equal(sent[0].waitMs, 0);
    const refused: any = await handleMessage(call('approve', { id: 'd-nope' }), deps);
    assert.equal(refused.result.isError, true);
    assert.match(text(refused), /Unknown directive/);
    const missing: any = await handleMessage(call('resume', {}), deps);
    assert.equal(missing.result.isError, true);
    assert.match(text(missing), /Missing argument "resolution"/);
    assert.equal(sent.length, 6, 'the refused approve was sent, the missing argument was not');
  } finally {
    await dir.cleanup();
  }
});

test('mcp: status, events and turn read the state directory when no orchestrator runs', async () => {
  const dir = await tempDir();
  try {
    const { deps } = fakeDeps(dir.path, false);
    const store = deps.store;
    await store.ensureDirectory();
    const state = await store.load();
    state.status = 'BLOCKED';
    state.blocked = { kind: 'SUPERVISOR', reason: 'needs a human', at: new Date().toISOString() } as any;
    await store.save(state);
    await store.event('turn.started', { turnId: 't0001-aaaaaa' });
    await store.event('review.completed', { turnId: 't0001-aaaaaa', decision: 'BLOCKED' });
    await store.event('hot_prompt.answered', { id: 'hp-1', answer: 'x'.repeat(5000) });
    await writeFile(join(dir.path, 'turns', 't0001-aaaaaa.worker.json'), JSON.stringify({
      missionId: 'm1', prompt: 'SECRET PROMPT', result: { finalResponse: 'done the preflight', commands: [{ command: 'git status', exitCode: 0 }] }
    }));
    await writeFile(join(dir.path, 'turns', 't0001-aaaaaa.review.json'), JSON.stringify({ decision: 'BLOCKED', reason: 'scope' }));
    await writeFile(join(dir.path, 'turns', 't0002-bbbbbb.verification.json'), JSON.stringify([{ name: 'gate', passed: true }]));

    const s = text(await handleMessage(call('status'), deps));
    assert.match(s, /persisted state/);
    assert.match(s, /BLOCKED/);
    assert.match(s, /needs a human/);

    const e = text(await handleMessage(call('events', { types: ['review'] }), deps));
    assert.match(e, /review\.completed/);
    assert.doesNotMatch(e, /turn\.started/);
    assert.ok(text(await handleMessage(call('events'), deps)).includes('more characters'), 'long event data is clipped');

    const last = text(await handleMessage(call('turn'), deps));
    assert.match(last, /turn t0002-bbbbbb/);
    assert.match(last, /## verification/);
    const first = text(await handleMessage(call('turn', { turnId: 't0001' }), deps));
    assert.match(first, /done the preflight/);
    assert.match(first, /\[0\] git status/);
    assert.match(first, /"reason": "scope"/);
    assert.doesNotMatch(first, /SECRET PROMPT/);
    assert.match(text(await handleMessage(call('turn', { turnId: 't0001', part: 'worker', includePrompt: true }), deps)), /SECRET PROMPT/);
    assert.match(text(await handleMessage(call('turn', { turnId: 't9' }), deps)), /Unknown turn/);

    const r: any = await handleMessage(call('resume', { resolution: 'go' }), deps);
    assert.equal(r.result.isError, true);
    assert.match(text(r), /not running/);
  } finally {
    await dir.cleanup();
  }
});

test('mcp: stdio loop answers line by line, keeps stdout for the protocol, and rejects garbage', async () => {
  const dir = await tempDir();
  try {
    await mkdir(dir.path, { recursive: true });
    const input = new PassThrough(); const output = new PassThrough();
    let received = '';
    output.on('data', (c) => { received += c; });
    const served = runMcpServer(new Store(dir.path), { input, output });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    input.write('not json\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    input.end();
    await served;
    const replies = received.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(replies.length, 3);
    assert.equal(replies.find((r) => r.id === 1).result.serverInfo.name, 'coldprompt');
    assert.equal(replies.find((r) => r.error)?.error.code, -32700);
    assert.equal(replies.find((r) => r.id === 2).result.tools.length, TOOLS.length);
  } finally {
    await dir.cleanup();
  }
});

test('mcp: resume through the real console socket unblocks a run', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const worker = new FakeWorkerAdapter(['needs a human']);
    const supervisor = new FakeSupervisorAdapter([{ decision: 'BLOCKED', reason: 'judgment needed' }, { decision: 'MISSION_COMPLETE' }]);
    const h = await start(home.path, work.path, makeConfig(), worker, supervisor);
    const server = new ConsoleServer(h.orchestrator, h.store.socketPath);
    await server.start();
    await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
    const { sendOnce } = await import('../src/console/client.js');
    const deps: McpDeps = { store: h.store, send: (request, waitMs) => sendOnce(h.store.socketPath, request, waitMs) };
    assert.match(text(await handleMessage(call('status'), deps)), /BLOCKED/);
    const r: any = await handleMessage(call('resume', { resolution: 'the human decided' }), deps);
    assert.equal(r.result.isError, undefined, text(r));
    await h.done;
    assert.equal(h.orchestrator.snapshotState.status, 'COMPLETED');
    await server.stop();
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});
