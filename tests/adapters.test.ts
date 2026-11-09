import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import { CodexWorkerAdapter, type CodexLike, type CodexThreadLike } from '../src/adapters/codex.js';
import { ClaudeSupervisorAdapter, type CommandRunner, type RunResult } from '../src/adapters/claude.js';
import { classifyError, redact } from '../src/errors.js';
import { claudeSupervisor, codexWorker, makeConfig } from './helpers.js';
import type { EvaluationContext } from '../src/supervisor.js';

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

class FakeThread implements CodexThreadLike {
  id: string | null;
  inputs: string[] = [];
  constructor(id: string | null, private readonly script: (signal?: AbortSignal) => ThreadEvent[] | Promise<ThreadEvent[]>) { this.id = id; }
  async runStreamed(input: string, options?: TurnOptions) {
    this.inputs.push(input);
    const events = await this.script(options?.signal);
    const self = this;
    return {
      events: (async function* () {
        for (const e of events) {
          if (e.type === 'thread.started') self.id = e.thread_id;
          yield e;
        }
      })()
    };
  }
}

class FakeCodex implements CodexLike {
  started: ThreadOptions[] = [];
  resumed: Array<{ id: string; options?: ThreadOptions }> = [];
  constructor(private readonly script: (signal?: AbortSignal) => ThreadEvent[] | Promise<ThreadEvent[]>) {}
  last?: FakeThread;
  startThread(options?: ThreadOptions) { this.started.push(options ?? {}); return (this.last = new FakeThread(null, this.script)); }
  resumeThread(id: string, options?: ThreadOptions) { this.resumed.push({ id, options }); return (this.last = new FakeThread(id, this.script)); }
}

const okTurn = (id = 'th-new'): ThreadEvent[] => [
  { type: 'thread.started', thread_id: id },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: '2', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } },
  { type: 'item.completed', item: { id: '3', type: 'agent_message', text: 'All tests pass.' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } }
];

test('Codex: inherits sandbox/approval from the user config unless set; read-only forces read-only', () => {
  const codex = new CodexWorkerAdapter(codexWorker(), new FakeCodex(() => okTurn()));
  const normal = codex.threadOptions({ workingDirectory: '/repo', readOnly: false });
  assert.equal(normal.sandboxMode, undefined);
  assert.equal(normal.approvalPolicy, undefined);
  assert.equal(codex.threadOptions({ workingDirectory: '/repo', readOnly: true }).sandboxMode, 'read-only');
  const custom = new CodexWorkerAdapter(codexWorker({ sandboxMode: 'danger-full-access', model: 'gpt-x' }), new FakeCodex(() => okTurn()));
  assert.deepEqual(custom.threadOptions({ workingDirectory: '/r', readOnly: false }), { workingDirectory: '/r', model: 'gpt-x', sandboxMode: 'danger-full-access' });
});

test('Codex: new thread id is reported as soon as thread.started arrives; results are collected', async () => {
  const fake = new FakeCodex(() => okTurn('th-42'));
  const codex = new CodexWorkerAdapter(codexWorker(), fake);
  await codex.startSession({ workingDirectory: '/repo', readOnly: false });
  const seen: string[] = [];
  const result = await codex.executeTurn('hello', { onSessionId: (id) => { seen.push(id); } });
  assert.deepEqual(seen, ['th-42']);
  assert.equal(codex.getSessionId(), 'th-42');
  assert.equal(result.finalResponse, 'All tests pass.');
  assert.deepEqual(result.commands, [{ command: 'npm test', exitCode: 0, status: 'completed' }]);
  assert.deepEqual(result.fileChanges, [{ path: 'src/a.ts', kind: 'update' }]);
  assert.equal(result.usage?.outputTokens, 5);
});

test('Codex: resume uses the given thread and refuses a second concurrent writer', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fake = new FakeCodex(async () => { await gate; return okTurn('th-1').slice(1); });
  const codex = new CodexWorkerAdapter(codexWorker(), fake);
  await codex.resumeSession('th-1', { workingDirectory: '/repo', readOnly: false });
  assert.equal(fake.resumed[0].id, 'th-1');
  const first = codex.executeTurn('a');
  await assert.rejects(codex.executeTurn('b'), (e: unknown) => classifyError(e) === 'SESSION_LOCK');
  await assert.rejects(codex.resumeSession('th-2', { workingDirectory: '/repo', readOnly: false }), /already running/);
  release();
  const result = await first;
  assert.equal(result.sessionId, 'th-1');
});

test('Codex: turn.failed surfaces a classifiable error', async () => {
  const codex = new CodexWorkerAdapter(codexWorker(), new FakeCodex(() => [
    { type: 'thread.started', thread_id: 'th-9' },
    { type: 'turn.failed', error: { message: 'stream error: 429 Too Many Requests' } }
  ]));
  await codex.startSession({ workingDirectory: '/r', readOnly: false });
  await assert.rejects(codex.executeTurn('x'), (e: unknown) => classifyError(e) === 'TRANSIENT_CAPACITY');
  assert.equal(codex.getSessionId(), 'th-9', 'thread id kept after failure: no silent new session');
});

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

function recordingRunner(responses: Array<Partial<RunResult> | ((args: string[]) => Partial<RunResult>)>) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const runner: CommandRunner = async (_cmd, args, { input }) => {
    calls.push({ args, input });
    const r = responses.shift() ?? {};
    const value = typeof r === 'function' ? r(args) : r;
    return { code: 0, stdout: '', stderr: '', ...value };
  };
  return { calls, runner };
}

const cliJson = (structured: unknown, extra: Record<string, unknown> = {}) => ({
  stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: extra.session_id ?? 'S', result: JSON.stringify(structured), structured_output: structured, ...extra })
});

const ctx = (): EvaluationContext => ({
  mission: makeConfig().missions[0], missionIndex: 0, missionCount: 1, turnId: 't1', missionTurn: 1,
  workerPrompt: 'p', workerResult: { sessionId: 'w', finalResponse: 'did it', commands: [], fileChanges: [], errors: [] },
  gitBefore: { isRepo: false, capturedAt: '' }, gitAfter: { isRepo: false, capturedAt: '' }, commits: [], verification: [], deliveredDirectives: []
});

const review = { decision: 'CONTINUE', reason: 'r', workerInstruction: 'next', evidence: ['e'] };

test('Claude: first call creates the session with --session-id, later calls --resume it', async () => {
  const { calls, runner } = recordingRunner([
    (args) => cliJson(review, { session_id: args[args.indexOf('--session-id') + 1] }),
    (args) => cliJson({ answer: 'a', proposedDirective: null }, { session_id: args[args.indexOf('--resume') + 1] })
  ]);
  const claude = new ClaudeSupervisorAdapter(claudeSupervisor(), '/repo', runner);
  const r = await claude.evaluateTurn(ctx());
  assert.equal(r.decision, 'CONTINUE');
  const id = claude.getSessionId()!;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.ok(calls[0].args.includes('--session-id'));
  assert.ok(!calls[0].args.includes('--resume'));
  assert.match(calls[0].input!, /did it/, 'prompt goes through stdin');
  const schema = JSON.parse(calls[0].args[calls[0].args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema.properties.decision.enum, ['CONTINUE', 'CLARIFY', 'BLOCKED', 'MISSION_COMPLETE', 'STOP']);
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  await claude.interact({ intent: 'QUESTION', content: 'q?', status: 'BLOCKED' });
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--resume'), calls[1].args.indexOf('--resume') + 2), ['--resume', id]);
  assert.equal(claude.isSessionStarted(), true);
});

test('Claude: a persisted session id is resumed after restart', async () => {
  const { calls, runner } = recordingRunner([cliJson(review, { session_id: 'abc' })]);
  const claude = new ClaudeSupervisorAdapter(claudeSupervisor(), '/repo', runner);
  await claude.resumeSession('abc', true);
  await claude.evaluateTurn(ctx());
  assert.ok(calls[0].args.includes('--resume') && calls[0].args.includes('abc'));
});

test('Claude: prose or schema-violating output is never treated as a control decision', async () => {
  const prose = recordingRunner([{ stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'S', result: 'I think MISSION_COMPLETE.' }) }]);
  await assert.rejects(new ClaudeSupervisorAdapter(claudeSupervisor(), '/r', prose.runner).evaluateTurn(ctx()), /prose is not accepted/);
  const bad = recordingRunner([cliJson({ decision: 'SHIP_IT', reason: '', workerInstruction: '', evidence: [] })]);
  await assert.rejects(new ClaudeSupervisorAdapter(claudeSupervisor(), '/r', bad.runner).evaluateTurn(ctx()), /does not match the schema/);
  const text = recordingRunner([{ code: 1, stdout: 'not json', stderr: 'boom' }]);
  await assert.rejects(new ClaudeSupervisorAdapter(claudeSupervisor(), '/r', text.runner).evaluateTurn(ctx()), /without JSON/);
});

test('Claude: API errors are classified (capacity vs auth)', async () => {
  const overloaded = recordingRunner([{ code: 1, stdout: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'S', api_error_status: 529, result: 'Overloaded' }) }]);
  const e1 = await new ClaudeSupervisorAdapter(claudeSupervisor(), '/r', overloaded.runner).evaluateTurn(ctx()).catch((e) => e);
  assert.equal(classifyError(e1), 'TRANSIENT_CAPACITY');
  const auth = recordingRunner([{ code: 1, stdout: JSON.stringify({ type: 'result', subtype: 'error', is_error: true, api_error_status: 401, result: 'Invalid API key' }) }]);
  const e2 = await new ClaudeSupervisorAdapter(claudeSupervisor(), '/r', auth.runner).evaluateTurn(ctx()).catch((e) => e);
  assert.equal(classifyError(e2), 'AUTHENTICATION');
});

test('Claude: recovers when the session was created by a call whose result was lost', async () => {
  const { calls, runner } = recordingRunner([
    { code: 1, stdout: '', stderr: 'Error: Session ID 123 is already in use.' },
    (args) => cliJson(review, { session_id: args[args.indexOf('--resume') + 1] })
  ]);
  const claude = new ClaudeSupervisorAdapter(claudeSupervisor(), '/r', runner);
  await claude.evaluateTurn(ctx());
  assert.ok(calls[1].args.includes('--resume'));
});

test('Claude: CLI options are validated against the installed version', async () => {
  const helpOk = '-p, --print\n--output-format\n--json-schema\n-r, --resume\n--session-id\n--append-system-prompt\n--tools\n--model\n--permission-mode <mode> (choices: "acceptEdits", "auto", "dontAsk", "plan")';
  const good = recordingRunner([{ stdout: '2.1.319 (Claude Code)' }, { stdout: helpOk }]);
  assert.equal(await new ClaudeSupervisorAdapter(claudeSupervisor(), '/r', good.runner).validateCli(), '2.1.319 (Claude Code)');
  const old = recordingRunner([{ stdout: '1.0.0' }, { stdout: '-p, --print\n--output-format\n--resume' }]);
  await assert.rejects(new ClaudeSupervisorAdapter(claudeSupervisor(), '/r', old.runner).validateCli(), /lacks required options: --json-schema/);
  const mode = recordingRunner([{ stdout: '2' }, { stdout: helpOk }]);
  await assert.rejects(new ClaudeSupervisorAdapter(claudeSupervisor({ permissionMode: 'bypassPermissions' }), '/r', mode.runner).validateCli(), /permission mode/);
});

test('secrets are redacted from logs', () => {
  process.env.COLDPROMPT_TEST_API_KEY = 'super-secret-value-123';
  try {
    assert.equal(redact('key=super-secret-value-123 sk-abcdefghijklmnopqrstuvwx'), 'key=[REDACTED] [REDACTED]');
  } finally {
    delete process.env.COLDPROMPT_TEST_API_KEY;
  }
});
