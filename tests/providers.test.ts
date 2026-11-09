import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import { ClaudeWorkerAdapter, type LineRunner } from '../src/adapters/claude-worker.js';
import { ClaudeSupervisorAdapter, probeClaudeModel } from '../src/adapters/claude.js';
import { CodexWorkerAdapter, probeCodexModel, type CodexLike, type CodexThreadLike } from '../src/adapters/codex.js';
import { CodexSupervisorAdapter } from '../src/adapters/codex-supervisor.js';
import { createSupervisor, createWorker } from '../src/adapters/registry.js';
import { classifyError } from '../src/errors.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Store } from '../src/store.js';
import { SUPERVISOR_SYSTEM_PROMPT, type EvaluationContext } from '../src/supervisor.js';
import { configSchema } from '../src/types.js';
import type { WorkerProgress } from '../src/worker.js';
import {
  claudeSupervisor, claudeWorker, codexSupervisor, codexWorker, FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor
} from './helpers.js';

const context = { workingDirectory: '/repo', maxWorkerOutputChars: 1000 };

// ---------------------------------------------------------------------------
// Config and registry
// ---------------------------------------------------------------------------

test('config: each role picks its provider; options are checked per provider', () => {
  const swapped = makeConfig({ worker: { provider: 'claude', permissionMode: 'acceptEdits' }, supervisor: { provider: 'codex', reasoningEffort: 'high' } });
  assert.equal(swapped.worker.provider, 'claude');
  assert.equal(swapped.supervisor.provider, 'codex');
  if (swapped.worker.provider === 'claude') assert.deepEqual(swapped.worker.readOnlyTools, ['Read', 'Grep', 'Glob']);
  const same = makeConfig({ worker: { provider: 'claude' }, supervisor: { provider: 'claude' } });
  assert.equal(same.worker.provider, same.supervisor.provider);

  const base = { version: 1, project: { name: 'x', workingDirectory: '.' }, runtime: makeConfig().runtime, sessions: makeConfig().sessions };
  assert.throws(() => configSchema.parse({ ...base, worker: { provider: 'gemini' }, supervisor: { provider: 'claude' } }), /provider/);
  // A Codex-only option on a Claude worker is a typo, not silently ignored.
  assert.throws(() => configSchema.parse({ ...base, worker: { provider: 'claude', sandboxMode: 'read-only' }, supervisor: { provider: 'claude' } }), /sandboxMode/);
  assert.throws(() => configSchema.parse({ ...base, worker: { provider: 'codex' }, supervisor: { provider: 'codex', tools: ['Read'] } }), /tools/);
});

test('registry: the configured provider decides the adapter', () => {
  assert.ok(createWorker(codexWorker(), context) instanceof CodexWorkerAdapter);
  assert.ok(createWorker(claudeWorker(), context) instanceof ClaudeWorkerAdapter);
  assert.ok(createSupervisor(claudeSupervisor(), context) instanceof ClaudeSupervisorAdapter);
  assert.ok(createSupervisor(codexSupervisor(), context) instanceof CodexSupervisorAdapter);
});

// ---------------------------------------------------------------------------
// Claude Code as worker
// ---------------------------------------------------------------------------

const line = (o: unknown) => JSON.stringify(o);
const init = (id: string) => line({ type: 'system', subtype: 'init', session_id: id });
const result = (id: string, extra: Record<string, unknown> = {}) => line({
  type: 'result', subtype: 'success', is_error: false, session_id: id, result: 'Done: tests pass.',
  usage: { input_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 6, output_tokens: 7 }, permission_denials: [], ...extra
});

/** Replays scripted stdout lines; records the args of every call. */
function lines(script: (args: string[]) => { lines: string[]; code?: number; stderr?: string }) {
  const calls: Array<{ args: string[]; input: string }> = [];
  const run: LineRunner = async (_command, args, { input, onLine }) => {
    calls.push({ args, input });
    const out = script(args);
    for (const l of out.lines) await onLine(l);
    return { code: out.code ?? 0, stderr: out.stderr ?? '' };
  };
  return { run, calls };
}

const turnLines = (id: string) => [
  init(id),
  line({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Running the tests.' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
    { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/a.ts' } },
    { type: 'tool_use', id: 't3', name: 'mcp__konnect__run_drc', input: { board: 'x' } }
  ] } }),
  line({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: '4 passing', is_error: false },
    { type: 'tool_result', tool_use_id: 't2', content: 'ok', is_error: false },
    { type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: '0 errors' }], is_error: false }
  ] } }),
  result(id)
];

test('Claude worker: first turn creates the conversation, later turns resume it; results are collected', async () => {
  const fake = lines(() => ({ lines: turnLines('s-1') }));
  const worker = new ClaudeWorkerAdapter(claudeWorker({ permissionMode: 'acceptEdits', allowedTools: ['Bash(npm test:*)'] }), fake.run);
  await worker.startSession({ workingDirectory: '/repo', readOnly: false });
  const ids: string[] = [];
  const progress: WorkerProgress[] = [];
  const first = await worker.executeTurn('Do A', { onSessionId: (id) => { ids.push(id); }, onProgress: (p) => { progress.push(p); } });

  const args = fake.calls[0].args;
  assert.equal(fake.calls[0].input, 'Do A', 'the prompt goes through stdin');
  assert.deepEqual(args.slice(0, 4), ['--print', '--output-format', 'stream-json', '--verbose']);
  assert.equal(args[4], '--session-id');
  assert.ok(args.includes('acceptEdits'));
  assert.deepEqual(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2), ['--allowedTools', 'Bash(npm test:*)']);
  assert.ok(!args.includes('--tools'), 'all tools unless configured');

  assert.deepEqual(ids, ['s-1']);
  assert.equal(first.sessionId, 's-1');
  assert.equal(first.finalResponse, 'Done: tests pass.');
  assert.deepEqual(first.commands, [{ command: 'npm test', status: 'completed' }]);
  assert.deepEqual(first.fileChanges, [{ path: 'src/a.ts', kind: 'update' }]);
  assert.deepEqual(first.usage, { inputTokens: 20, cachedInputTokens: 6, outputTokens: 7 });
  assert.deepEqual(progress.map((p) => `${p.phase}:${p.kind}:${p.summary}`), [
    'completed:message:Running the tests.', 'started:command:npm test', 'started:tool:konnect.run_drc',
    'completed:command:npm test', 'completed:file_change:update src/a.ts', 'completed:tool:konnect.run_drc'
  ]);
  assert.equal(progress[3].detail, '4 passing');
  assert.equal(progress[5].detail, '0 errors');

  await worker.executeTurn('Continue');
  assert.deepEqual(fake.calls[1].args.slice(4, 6), ['--resume', 's-1']);
  assert.equal(worker.getSessionId(), 's-1');
});

test('Claude worker: a read-only mission only gets the read-only tools, in dontAsk mode', async () => {
  const fake = lines(() => ({ lines: [init('s-2'), result('s-2')] }));
  const worker = new ClaudeWorkerAdapter(claudeWorker({ permissionMode: 'bypassPermissions', allowedTools: ['Bash'], tools: ['Bash', 'Edit'] }), fake.run);
  await worker.resumeSession('s-2', { workingDirectory: '/repo', readOnly: true });
  await worker.executeTurn('Audit');
  const args = fake.calls[0].args;
  assert.deepEqual(args.slice(4, 6), ['--resume', 's-2']);
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob']);
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
  assert.ok(!args.includes('--allowedTools') && !args.includes('bypassPermissions'));
});

test('Claude worker: failures are classified; denials are reported; no result is an error', async () => {
  const overloaded = lines(() => ({ lines: [init('s'), result('s', { is_error: true, subtype: 'error_during_execution', api_error_status: 529, result: 'Overloaded' })] }));
  const w1 = new ClaudeWorkerAdapter(claudeWorker(), overloaded.run);
  await w1.startSession({ workingDirectory: '/r', readOnly: false });
  const e1 = await w1.executeTurn('x').catch((e) => e);
  assert.equal(classifyError(e1), 'TRANSIENT_CAPACITY');
  assert.equal(w1.getSessionId(), 's', 'the conversation exists even though the turn failed');

  const silent = lines(() => ({ lines: [], code: 1, stderr: 'Not logged in' }));
  const w2 = new ClaudeWorkerAdapter(claudeWorker(), silent.run);
  await w2.startSession({ workingDirectory: '/r', readOnly: false });
  const e2 = await w2.executeTurn('x').catch((e) => e);
  assert.match(e2.message, /without a result/);
  assert.equal(classifyError(e2), 'AUTHENTICATION');
  assert.equal(w2.getSessionId(), undefined, 'no conversation was created');

  const denied = lines(() => ({ lines: [init('s'), result('s', { permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }] })] }));
  const w3 = new ClaudeWorkerAdapter(claudeWorker(), denied.run);
  await w3.startSession({ workingDirectory: '/r', readOnly: false });
  assert.deepEqual((await w3.executeTurn('x')).errors, ['permission denied: Bash (rm -rf build)']);
});

test('Claude worker: recovers when a lost attempt already created the conversation; refuses two writers', async () => {
  let attempt = 0;
  const fake = lines((args) => {
    attempt += 1;
    if (args.includes('--session-id')) return { lines: [], code: 1, stderr: `Error: Session ID ${args[args.indexOf('--session-id') + 1]} is already in use.` };
    return { lines: [init(args[args.indexOf('--resume') + 1]), result(args[args.indexOf('--resume') + 1])] };
  });
  const worker = new ClaudeWorkerAdapter(claudeWorker(), fake.run);
  await worker.startSession({ workingDirectory: '/r', readOnly: false });
  const ids: string[] = [];
  const out = await worker.executeTurn('x', { onSessionId: (id) => { ids.push(id); } });
  assert.equal(attempt, 2);
  assert.equal(fake.calls[1].args[5], fake.calls[0].args[5], 'same conversation id, now resumed');
  assert.equal(out.sessionId, ids[0]);

  let release!: () => void;
  const slow: LineRunner = async (_c, _a, { onLine }) => { await new Promise<void>((r) => { release = r; }); await onLine(init('s')); await onLine(result('s')); return { code: 0, stderr: '' }; };
  const busy = new ClaudeWorkerAdapter(claudeWorker(), slow);
  await busy.startSession({ workingDirectory: '/r', readOnly: false });
  const running = busy.executeTurn('one');
  await assert.rejects(busy.executeTurn('two'), (e) => classifyError(e) === 'SESSION_LOCK');
  release();
  await running;
});

// ---------------------------------------------------------------------------
// Codex as supervisor
// ---------------------------------------------------------------------------

class ScriptedThread implements CodexThreadLike {
  calls: Array<{ input: string; options?: TurnOptions }> = [];
  constructor(public id: string | null, private readonly answer: (n: number) => ThreadEvent[]) {}
  async runStreamed(input: string, options?: TurnOptions) {
    this.calls.push({ input, options });
    const events = this.answer(this.calls.length);
    const self = this;
    return { events: (async function* () { for (const e of events) { if (e.type === 'thread.started') self.id = e.thread_id; yield e; } })() };
  }
}

class ScriptedCodex implements CodexLike {
  started: ThreadOptions[] = [];
  resumed: string[] = [];
  threads: ScriptedThread[] = [];
  constructor(private readonly answer: (n: number) => ThreadEvent[]) {}
  startThread(options?: ThreadOptions) { this.started.push(options ?? {}); const t = new ScriptedThread(null, this.answer); this.threads.push(t); return t; }
  resumeThread(id: string, options?: ThreadOptions) { this.resumed.push(id); this.started.push(options ?? {}); const t = new ScriptedThread(id, this.answer); this.threads.push(t); return t; }
}

const answer = (text: string, threadId = 'sup-1'): ThreadEvent[] => [
  { type: 'thread.started', thread_id: threadId },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: '1', type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }
];

const review = JSON.stringify({ decision: 'CONTINUE', reason: 'more tests needed', workerInstruction: 'run the tests', evidence: ['no test run'] });

const evaluation = (): EvaluationContext => ({
  mission: makeConfig().missions[0], missionIndex: 0, missionCount: 1, turnId: 't1', missionTurn: 1,
  workerPrompt: 'Do A', workerResult: { sessionId: 'w', finalResponse: 'done', commands: [], fileChanges: [], errors: [] },
  gitBefore: { isRepo: false, capturedAt: '' }, gitAfter: { isRepo: false, capturedAt: '' }, commits: [], verification: [], deliveredDirectives: []
});

test('Codex supervisor: read-only thread, instructions on the first message only, answers bound by the JSON schema', async () => {
  const codex = new ScriptedCodex(() => answer(review));
  const supervisor = new CodexSupervisorAdapter(codexSupervisor({ model: 'gpt-x' }), '/repo', codex);
  const first = await supervisor.evaluateTurn(evaluation());
  assert.equal(first.decision, 'CONTINUE');
  assert.deepEqual(codex.started[0], { workingDirectory: '/repo', sandboxMode: 'read-only', approvalPolicy: 'never', model: 'gpt-x' });
  const thread = codex.threads[0];
  assert.ok(thread.calls[0].input.startsWith(SUPERVISOR_SYSTEM_PROMPT));
  assert.equal((thread.calls[0].options?.outputSchema as any).properties.decision.enum.length, 5);
  assert.equal(supervisor.getSessionId(), 'sup-1');
  assert.ok(supervisor.isSessionStarted());

  const reply = new ScriptedCodex(() => answer(JSON.stringify({ answer: 'because', proposedDirective: null })));
  const again = new CodexSupervisorAdapter(codexSupervisor(), '/repo', reply);
  await again.resumeSession('sup-1', true);
  const out = await again.interact({ intent: 'QUESTION', content: 'why?', status: 'RUNNING' });
  assert.equal(out.answer, 'because');
  assert.deepEqual(reply.resumed, ['sup-1']);
  assert.ok(!reply.threads[0].calls[0].input.includes(SUPERVISOR_SYSTEM_PROMPT), 'a resumed thread already has its instructions');
});

test('Codex supervisor: prose is never a decision; failures are classified', async () => {
  const prose = new CodexSupervisorAdapter(codexSupervisor(), '/r', new ScriptedCodex(() => answer('I think it should continue.')));
  await assert.rejects(prose.evaluateTurn(evaluation()), /prose is not accepted/);
  const off = new CodexSupervisorAdapter(codexSupervisor(), '/r', new ScriptedCodex(() => answer('{"decision":"MAYBE"}')));
  await assert.rejects(off.evaluateTurn(evaluation()), /does not match the schema/);
  const failed = new CodexSupervisorAdapter(codexSupervisor(), '/r', new ScriptedCodex(() => [
    { type: 'thread.started', thread_id: 'sup-2' }, { type: 'turn.failed', error: { message: '429 Too Many Requests' } }
  ]));
  const error = await failed.evaluateTurn(evaluation()).catch((e) => e);
  assert.equal(classifyError(error), 'TRANSIENT_CAPACITY');
  assert.equal(failed.getSessionId(), 'sup-2', 'the thread id is kept for the retry');
});

// ---------------------------------------------------------------------------
// Orchestrator: providers recorded with thread ids
// ---------------------------------------------------------------------------

test('thread ids are recorded with their provider; a provider change under live state is refused', async () => {
  const home = await tempDir(); const work = await tempDir('coldprompt-work-');
  try {
    const h = await start(home.path, work.path, makeConfig(), new FakeWorkerAdapter(['done']), new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE', reason: 'ok' }]));
    await h.done;
    const state = await h.store.load();
    assert.equal(state.sessions.main.workerProvider, 'fake-worker');

    // Same state, a session still open on a thread of another provider.
    await writeFile(join(home.path, 'state.json'), JSON.stringify({
      ...state, status: 'RUNNING', missionIndex: 0, activeMissionId: 'a',
      missions: { a: { status: 'ACTIVE', turns: 1, session: 'main' } },
      sessions: { main: { workerThreadId: 'th-1', workerProvider: 'codex' } },
      supervisorSessionId: 'sup-1', supervisorProvider: 'claude', supervisorSessionStarted: true
    }));
    const orchestrator = new Orchestrator({
      config: makeConfig(), store: new Store(home.path), worker: new FakeWorkerAdapter(), supervisor: new FakeSupervisorAdapter(), workingDirectory: work.path
    });
    await assert.rejects(orchestrator.open(), (e: Error) => /Provider changed/.test(e.message)
      && /codex worker thread \(th-1\) but the worker is now fake-worker/.test(e.message)
      && /belongs to claude but the supervisor is now fake-supervisor/.test(e.message));
    assert.equal(await new Store(home.path).readLock(), undefined, 'the lock is released');
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Model checks at run start
// ---------------------------------------------------------------------------

test('Claude model probe: tiny call without tools or saved session; reports the model that answered', async () => {
  const calls: string[][] = [];
  const runner = async (_c: string, args: string[]) => {
    calls.push(args);
    const bad = args.includes('no-such-model');
    return {
      code: bad ? 1 : 0, stderr: '',
      stdout: JSON.stringify(bad
        ? { type: 'result', subtype: 'success', is_error: true, api_error_status: 404, result: 'There\'s an issue with the selected model (no-such-model).' }
        : { type: 'result', subtype: 'success', is_error: false, result: 'OK', modelUsage: { 'claude-haiku-5-5': {} } })
    };
  };
  assert.deepEqual(await probeClaudeModel(runner, 'claude', '/r', 'haiku'), { model: 'claude-haiku-5-5' });
  assert.ok(calls[0].includes('--no-session-persistence'));
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--tools'), calls[0].indexOf('--tools') + 2), ['--tools', '']);
  const error = await probeClaudeModel(runner, 'claude', '/r', 'no-such-model').catch((e) => e);
  assert.match(error.message, /status 404: .*no-such-model/);
  assert.equal(classifyError(error), 'PERMANENT');
});

test('Codex model probe: read-only, ephemeral when supported, provider errors surface', async () => {
  const calls: string[][] = [];
  const runner = (stdout: string, code = 0, help = '--ephemeral') => async (_c: string, args: string[]) => {
    calls.push(args);
    if (args[1] === '--help') return { code: 0, stdout: help, stderr: '' };
    return { code, stdout, stderr: '' };
  };
  const ok = [{ type: 'thread.started', thread_id: 'x' }, { type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }].map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(await probeCodexModel({ codexPath: '/bin/codex-a', model: 'gpt-x', workingDirectory: '/r', runner: runner(ok) }), { model: 'gpt-x' });
  const args = calls[1];
  assert.deepEqual(args.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only']);
  assert.ok(args.includes('--ephemeral'));
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-x']);

  calls.length = 0;
  const failed = [
    { type: 'item.completed', item: { type: 'error', message: 'Model metadata not found (warning only)' } },
    { type: 'error', message: 'The \'gpt-6-astra\' model requires a newer version of Codex.' },
    { type: 'turn.failed', error: { message: 'The \'gpt-6-astra\' model requires a newer version of Codex.' } }
  ].map((e) => JSON.stringify(e)).join('\n');
  const error = await probeCodexModel({ codexPath: '/bin/codex-old', workingDirectory: '/r', runner: runner(failed, 1, 'no such flag') }).catch((e) => e);
  assert.equal(error.message, 'The \'gpt-6-astra\' model requires a newer version of Codex.');
  assert.ok(!calls[1].includes('--ephemeral') && !calls[1].includes('--model'));
});

test('run start: an unusable model blocks before any worker turn; resume re-checks; capacity errors do not block', async () => {
  const home = await tempDir(); const work = await tempDir('coldprompt-work-');
  try {
    const worker = new FakeWorkerAdapter(['done']);
    let probes = 0;
    let broken = true;
    worker.probe = async () => { probes += 1; if (broken) throw new Error('status 404: There\'s an issue with the selected model (opus-9).'); return { model: 'm' }; };
    const supervisor = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE', reason: 'ok' }]);
    const config = makeConfig({ worker: { provider: 'claude', model: 'opus-9' } });
    const h = await start(home.path, work.path, config, worker, supervisor);
    await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
    const blocked = h.orchestrator.snapshotState.blocked!;
    assert.equal(blocked.kind, 'PROVIDER_CHECK');
    assert.match(blocked.reason, /worker \(fake-worker, model "opus-9"\) cannot be used: status 404/);
    assert.match(blocked.reason, /Fix worker\.model/);
    assert.equal(worker.calls.length, 0, 'no worker session or turn before the check passes');

    broken = false;
    assert.equal((await h.orchestrator.handleCommand({ command: 'resume', text: 'model fixed' })).ok, true);
    await h.done;
    assert.equal(probes, 2);
    assert.equal(h.orchestrator.snapshotState.status, 'COMPLETED');
    assert.ok(!worker.turnInputs[0].includes('model fixed'), 'the resolution of a provider check is not sent to the worker');
    assert.ok((await h.store.readEvents()).some((e) => e.type === 'providers.checked'));
  } finally {
    await home.cleanup(); await work.cleanup();
  }

  const home2 = await tempDir(); const work2 = await tempDir('coldprompt-work-');
  try {
    const supervisor = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE', reason: 'ok' }]);
    supervisor.probe = async () => { throw new Error('529 overloaded'); };
    const h = await start(home2.path, work2.path, makeConfig(), new FakeWorkerAdapter(['done']), supervisor);
    await h.done;
    assert.equal(h.orchestrator.snapshotState.status, 'COMPLETED');
  } finally {
    await home2.cleanup(); await work2.cleanup();
  }
});

test('restart: a persisted provider-check block is cleared and checked again with the new configuration', async () => {
  const home = await tempDir(); const work = await tempDir('coldprompt-work-');
  try {
    const first = new FakeWorkerAdapter();
    first.probe = async () => { throw new Error('unknown model'); };
    const h1 = await start(home.path, work.path, makeConfig(), first, new FakeSupervisorAdapter());
    await waitFor(() => h1.orchestrator.snapshotState.blocked?.kind === 'PROVIDER_CHECK');
    h1.orchestrator.requestStop();
    await h1.done;
    assert.equal((await h1.store.load()).blocked?.kind, 'PROVIDER_CHECK');

    const second = new FakeWorkerAdapter(['done']);
    second.probe = async () => ({ model: 'fixed' });
    const h2 = await start(home.path, work.path, makeConfig(), second, new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE', reason: 'ok' }]));
    await h2.done;
    assert.equal(h2.orchestrator.snapshotState.status, 'COMPLETED');
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});
