import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Store } from '../src/store.js';
import { HANDOFF_MAX_CHARS, Orchestrator } from '../src/orchestrator.js';
import { CommandVerifier, readOnlyCompletionChecks } from '../src/verification.js';
import { ColdPromptError } from '../src/errors.js';
import { deferred, FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor } from './helpers.js';

async function withDirs(fn: (home: string, work: string) => Promise<void>): Promise<void> {
  const home = await tempDir();
  const work = await tempDir('coldprompt-work-');
  try {
    await fn(home.path, work.path);
  } finally {
    await home.cleanup();
    await work.cleanup();
  }
}

const turnCount = (w: FakeWorkerAdapter) => w.calls.filter((c) => c.kind === 'turn').length;

test('CONTINUE then MISSION_COMPLETE completes the run on one resumed session', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter(['turn 1', 'turn 2', 'turn 3']);
  const supervisor = new FakeSupervisorAdapter([
    { decision: 'CONTINUE', workerInstruction: 'Next: write tests' },
    { decision: 'CLARIFY', workerInstruction: 'Show test output' },
    { decision: 'MISSION_COMPLETE' }
  ]);
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await h.done;
  const state = await h.store.load();
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.totalTurns, 3);
  assert.equal(state.missions.a.status, 'COMPLETED');
  assert.equal(worker.calls.filter((c) => c.kind === 'start').length, 1);
  const inputs = worker.turnInputs;
  assert.match(inputs[0], /Mission a: Mission A[\s\S]*Do A[\s\S]*A done/);
  assert.match(inputs[1], /Next: write tests/);
  assert.match(inputs[2], /Show test output/);
  const sessions = new Set(worker.calls.filter((c) => c.kind === 'turn').map((c) => c.sessionId));
  assert.equal(sessions.size, 1);
  assert.equal(state.sessions.main.workerThreadId, [...sessions][0]);
  assert.equal(state.pendingTurn, undefined);
}));

test('a worker claiming DONE is not completion: only the supervisor decision counts', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter(['DONE. Mission complete.', 'still DONE']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'CONTINUE', workerInstruction: 'Prove it' }, { decision: 'MISSION_COMPLETE' }]);
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await h.done;
  assert.equal(turnCount(worker), 2);
}));

test('BLOCKED prohibits worker execution; questions do not touch the worker; RESUME needs explicit resolution', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter(['needs judgment', 'after resolution']);
  const supervisor = new FakeSupervisorAdapter(
    [{ decision: 'BLOCKED', reason: 'Choose API v1 or v2', workerInstruction: '' }, { decision: 'MISSION_COMPLETE' }],
    [{ answer: 'v2 is safer', proposedDirective: 'Use API v2 everywhere' }]
  );
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED', 3000, 'BLOCKED');
  const blocked = await h.store.load();
  assert.equal(blocked.blocked?.kind, 'SUPERVISOR');
  assert.equal(blocked.blocked?.reason, 'Choose API v1 or v2');
  assert.ok(blocked.lastReviewRef && blocked.lastResultRef, 'worker result and review persisted');
  assert.equal(turnCount(worker), 1);

  // Question while BLOCKED: answered by the supervisor, worker untouched.
  const callsBefore = worker.calls.length;
  const ask = await h.orchestrator.handleCommand({ command: 'ask', text: 'Which API is safer?' });
  assert.equal(ask.ok, true);
  await waitFor(() => h.orchestrator.snapshotState.hotPrompts.some((p) => p.status === 'ANSWERED'), 3000, 'answer');
  let state = h.orchestrator.snapshotState;
  assert.equal(state.hotPrompts[0].answer, 'v2 is safer');
  assert.equal(state.status, 'BLOCKED');
  assert.equal(worker.calls.length, callsBefore);

  // Claude's proposal is not approved by default.
  const proposal = state.directives[0];
  assert.equal(proposal.author, 'SUPERVISOR');
  assert.equal(proposal.status, 'PROPOSED');

  // Pause/stray commands cannot unblock; resume without resolution is refused.
  assert.equal((await h.orchestrator.handleCommand({ command: 'resume' })).ok, false);
  assert.equal((await h.orchestrator.handleCommand({ command: 'pause' })).ok, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(turnCount(worker), 1);
  assert.equal(h.orchestrator.snapshotState.status, 'BLOCKED');

  assert.equal((await h.orchestrator.handleCommand({ command: 'approve', text: proposal.id })).ok, true);
  assert.equal((await h.orchestrator.handleCommand({ command: 'tell', text: 'Keep the changelog updated', raw: true })).ok, true);
  assert.equal((await h.orchestrator.handleCommand({ command: 'resume', text: 'Go with v2' })).ok, true);
  await h.done;

  state = await h.store.load();
  assert.equal(state.status, 'COMPLETED');
  const second = worker.turnInputs[1];
  assert.match(second, /Human RESOLUTION\nGo with v2/);
  assert.match(second, /Use API v2 everywhere/);
  assert.match(second, /Keep the changelog updated/);
  const turns = worker.calls.filter((c) => c.kind === 'turn');
  assert.equal(turns[0].sessionId, turns[1].sessionId, 'same worker session continued');
  assert.ok(state.directives.every((d) => d.status === 'DELIVERED'));
  assert.deepEqual(state.hotPrompts.map((p) => p.intent), ['QUESTION', 'DIRECTIVE', 'RESOLUTION']);
  assert.equal(supervisor.evaluations[1].resolution, 'Go with v2');
}));

test('a proposed directive is never delivered without approval', () => withDirs(async (home, work) => {
  const gate = deferred();
  const worker = new FakeWorkerAdapter([async () => { await gate.promise; return { finalResponse: '1' }; }, '2']);
  const supervisor = new FakeSupervisorAdapter(
    [{ decision: 'CONTINUE', workerInstruction: 'go on' }, { decision: 'MISSION_COMPLETE' }],
    [{ answer: 'prepared', proposedDirective: 'Delete the legacy module' }]
  );
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await waitFor(() => turnCount(worker) === 1);
  await h.orchestrator.handleCommand({ command: 'tell', text: 'remove legacy stuff' });
  await waitFor(() => h.orchestrator.snapshotState.directives.length === 1);
  gate.resolve();
  await h.done;
  assert.doesNotMatch(worker.turnInputs[1], /Delete the legacy module/);
  const state = await h.store.load();
  assert.equal(state.directives[0].status, 'PROPOSED');
  assert.equal(supervisor.interactions[0].intent, 'DIRECTIVE');
}));

test('questions during an active worker turn neither interrupt it nor run concurrently with reviews', () => withDirs(async (home, work) => {
  const gate = deferred();
  const reviewGate = deferred();
  const worker = new FakeWorkerAdapter([async () => { await gate.promise; return { finalResponse: 'long turn' }; }]);
  const supervisor = new FakeSupervisorAdapter(
    [async () => { await reviewGate.promise; return { decision: 'MISSION_COMPLETE' }; }],
    [async () => { await new Promise((r) => setTimeout(r, 20)); return { answer: 'a1' }; }, { answer: 'a2' }, { answer: 'a3' }]
  );
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await waitFor(() => turnCount(worker) === 1);
  await h.orchestrator.handleCommand({ command: 'ask', text: 'q1' });
  gate.resolve();
  await waitFor(() => supervisor.evaluations.length === 1 || h.orchestrator.snapshotState.pendingTurn?.phase === 'WORKER_DONE');
  await h.orchestrator.handleCommand({ command: 'ask', text: 'q2' });
  await h.orchestrator.handleCommand({ command: 'ask', text: 'q3' });
  reviewGate.resolve();
  await h.done;
  assert.equal(supervisor.concurrentWriterDetected, false);
  assert.ok(!worker.calls.some((c) => c.kind === 'cancel'));
  const state = await h.store.load();
  assert.deepEqual(state.hotPrompts.map((p) => p.status), ['ANSWERED', 'ANSWERED', 'ANSWERED']);
}));

test('pause takes effect at the next boundary and resume continues', () => withDirs(async (home, work) => {
  const gate = deferred();
  const worker = new FakeWorkerAdapter([async () => { await gate.promise; return { finalResponse: '1' }; }, '2']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'CONTINUE' }, { decision: 'MISSION_COMPLETE' }]);
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await waitFor(() => turnCount(worker) === 1);
  assert.equal((await h.orchestrator.handleCommand({ command: 'pause' })).ok, true);
  gate.resolve();
  await waitFor(() => h.orchestrator.snapshotState.status === 'PAUSED');
  assert.equal(h.orchestrator.snapshotState.totalTurns, 1, 'active turn completed and persisted first');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(turnCount(worker), 1);
  assert.equal((await h.orchestrator.handleCommand({ command: 'resume' })).ok, true);
  await h.done;
  assert.equal((await h.store.load()).status, 'COMPLETED');
}));

test('transient capacity errors use bounded 30/60/120/240s retries on the same session', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter([new Error('429 Too Many Requests'), new Error('503 overloaded'), 'ok']);
  const supervisor = new FakeSupervisorAdapter();
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await h.done;
  assert.deepEqual(h.sleeps, [30_000, 60_000]);
  assert.equal(worker.calls.filter((c) => c.kind === 'start').length, 1);
  const state = await h.store.load();
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.totalTurns, 1);
}));

test('exhausted capacity retries block instead of looping or replacing the session', () => withDirs(async (home, work) => {
  const err = () => new Error('rate limit exceeded');
  const worker = new FakeWorkerAdapter([err(), err(), err(), err(), err()]);
  const h = await start(home, work, makeConfig(), worker, new FakeSupervisorAdapter());
  await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
  assert.deepEqual(h.sleeps, [30_000, 60_000, 120_000, 240_000]);
  const state = h.orchestrator.snapshotState;
  assert.equal(state.blocked?.kind, 'RETRIES_EXHAUSTED');
  assert.equal(state.totalTurns, 0);
  assert.equal(state.pendingTurn, undefined);
  assert.equal(state.nextWorkerInput?.source, 'COLD_PROMPT', 'cold prompt kept for the retry');
  h.orchestrator.requestStop();
  await h.done;
}));

test('active-writer conflicts retry with bounded delays, then block with diagnostics; nothing is killed', () => withDirs(async (home, work) => {
  const lock = () => new Error('thread store: another process is the active writer for this thread');
  const worker = new FakeWorkerAdapter([lock(), lock(), 'ok']);
  const config = makeConfig({ runtime: { sessionLockRetryDelaysSeconds: [1, 2] } });
  const h = await start(home, work, config, worker, new FakeSupervisorAdapter());
  await h.done;
  assert.deepEqual(h.sleeps, [1000, 2000]);
  assert.equal((await h.store.load()).status, 'COMPLETED');
  assert.ok(!worker.calls.some((c) => c.kind === 'cancel'));

  const home2 = await tempDir();
  try {
    const worker2 = new FakeWorkerAdapter([lock(), lock(), lock()]);
    const h2 = await start(home2.path, work, config, worker2, new FakeSupervisorAdapter());
    await waitFor(() => h2.orchestrator.snapshotState.status === 'BLOCKED');
    const state = h2.orchestrator.snapshotState;
    assert.equal(state.blocked?.kind, 'SESSION_LOCK');
    assert.match(state.blocked!.reason, /will not kill/);
    h2.orchestrator.requestStop();
    await h2.done;
  } finally {
    await home2.cleanup();
  }
}));

test('authentication and permanent errors fail without retry and without a new session on resume', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter(['first ok', new Error('401 Unauthorized'), 'after login']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'CONTINUE' }, { decision: 'MISSION_COMPLETE' }]);
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await waitFor(() => h.orchestrator.snapshotState.status === 'FAILED');
  assert.deepEqual(h.sleeps, []);
  assert.match(h.orchestrator.snapshotState.blocked!.reason, /authentication/i);
  assert.equal((await h.orchestrator.handleCommand({ command: 'resume', text: 'logged in again' })).ok, true);
  await h.done;
  assert.equal(worker.calls.filter((c) => c.kind === 'start').length, 1);
  const turns = worker.calls.filter((c) => c.kind === 'turn');
  assert.equal(new Set(turns.map((t) => t.sessionId)).size, 1);
}));

test('supervisor STOP fails the run and requires a resolution', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter(['rm -rf attempt']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'STOP', reason: 'Destructive command' }]);
  const h = await start(home, work, makeConfig(), worker, supervisor);
  await waitFor(() => h.orchestrator.snapshotState.status === 'FAILED');
  assert.equal(h.orchestrator.snapshotState.blocked?.kind, 'FAILURE');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(turnCount(worker), 1);
  h.orchestrator.requestStop();
  await h.done;
  assert.equal((await h.store.load()).status, 'FAILED', 'stop keeps FAILED for the next run');
}));

test('deterministic verification can reject MISSION_COMPLETE', () => withDirs(async (home, work) => {
  let pass = false;
  const verifier = { name: 'tests', when: 'completion' as const, run: async () => ({ passed: pass, output: pass ? 'ok' : '2 failing' }) };
  const worker = new FakeWorkerAdapter(['done!', async () => { pass = true; return { finalResponse: 'fixed' }; }]);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }, { decision: 'MISSION_COMPLETE' }]);
  const h = await start(home, work, makeConfig(), worker, supervisor, { verifiers: [verifier] });
  await h.done;
  assert.equal(turnCount(worker), 2);
  assert.match(worker.turnInputs[1], /deterministic verification failed[\s\S]*2 failing/);
  assert.match(supervisor.evaluations[1].previousCompletionRejected ?? '', /2 failing/);
  assert.equal((await h.store.load()).status, 'COMPLETED');
}));

const readOnlyMission = (verification?: string[]) => ({
  id: 'audit', title: 'Audit', prompt: { type: 'COLD_PROMPT', content: 'Report bugs' },
  execution: { readOnly: true }, ...(verification ? { verification } : {})
});

test('read-only missions skip completion checks unless they list them', () => withDirs(async (home, work) => {
  let ran = 0;
  const verifier = { name: 'tests', when: 'completion' as const, run: async () => { ran += 1; return { passed: false, output: '1 failing' }; } };
  const worker = new FakeWorkerAdapter(['found the bug']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]);
  const config = makeConfig({ verification: { commands: [{ name: 'tests', run: 'false' }] }, missions: [readOnlyMission()] });
  const h = await start(home, work, config, worker, supervisor, { verifiers: [verifier] });
  await h.done;
  assert.equal(ran, 0);
  assert.equal(turnCount(worker), 1);
  assert.equal((await h.store.load()).status, 'COMPLETED');
}));

test('failed completion checks on a read-only mission block instead of asking the worker to fix them', () => withDirs(async (home, work) => {
  const verifier = { name: 'tests', when: 'completion' as const, run: async () => ({ passed: false, output: '1 failing' }) };
  const worker = new FakeWorkerAdapter(['found the bug']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]);
  const config = makeConfig({ verification: { commands: [{ name: 'tests', run: 'false' }] }, missions: [readOnlyMission(['tests'])] });
  const h = await start(home, work, config, worker, supervisor, { verifiers: [verifier] });
  await waitFor(() => h.orchestrator.snapshotState.blocked?.kind === 'VERIFICATION_FAILED', 3000, 'VERIFICATION_FAILED');
  const blocked = await h.store.load();
  assert.equal(blocked.status, 'BLOCKED');
  assert.match(blocked.blocked?.reason ?? '', /1 failing/);
  assert.equal(blocked.pendingTurn, undefined);
  assert.equal(turnCount(worker), 1, 'the read-only worker is not asked to fix anything');
  const approved = await h.orchestrator.handleCommand({ command: 'approve', text: 'mission' });
  assert.equal(approved.ok, true);
  await h.done;
  assert.equal(turnCount(worker), 1);
  assert.equal((await h.store.load()).status, 'COMPLETED');
}));

test('readOnlyCompletionChecks reports read-only missions that require completion checks', () => {
  const config = makeConfig({
    verification: { commands: [{ name: 'tests', run: 'npm test' }, { name: 'lint', run: 'npm run lint', when: 'turn' }] },
    missions: [
      readOnlyMission(['tests', 'lint']),
      { ...readOnlyMission(), id: 'audit2' },
      { ...readOnlyMission(['lint']), id: 'audit3' },
      { id: 'fix', title: 'Fix', prompt: { type: 'COLD_PROMPT', content: 'Fix' }, verification: ['tests'] }
    ]
  });
  assert.deepEqual(readOnlyCompletionChecks(config), [{ missionId: 'audit', checks: ['tests'] }]);
});

const plainMission = (id: string, execution: Record<string, unknown> = {}) => ({
  id, title: `Mission ${id}`, prompt: { type: 'COLD_PROMPT', content: `Do ${id}` }, execution
});

/** Approves every mission transition (session boundaries always need one). */
async function approveTransitions(h: Awaited<ReturnType<typeof start>>, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await waitFor(() => h.orchestrator.snapshotState.blocked?.kind === 'MISSION_APPROVAL', 3000, `transition ${i + 1}`);
    assert.equal((await h.orchestrator.handleCommand({ command: 'approve', text: 'mission' })).ok, true);
  }
}

test('handoff: previous gives a session the worker reports of the previous session', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter(['report A1', 'report A2', 'report B', 'audit C', 'work D']);
  const supervisor = new FakeSupervisorAdapter([
    { decision: 'CONTINUE', workerInstruction: 'go on' }, { decision: 'MISSION_COMPLETE' },
    { decision: 'MISSION_COMPLETE' }, { decision: 'MISSION_COMPLETE' }, { decision: 'MISSION_COMPLETE' }
  ]);
  const config = makeConfig({ sessions: [
    { id: 's1', missions: [plainMission('a'), plainMission('b')] },
    { id: 'audit', handoff: 'previous', missions: [plainMission('c', { readOnly: true })] },
    { id: 's3', missions: [plainMission('d')] }
  ] });
  const h = await start(home, work, config, worker, supervisor);
  await h.done;
  assert.equal((await h.store.load()).status, 'COMPLETED');
  assert.doesNotMatch(worker.turnInputs[2], /Handoff/, 'missions inside a session share the thread: no handoff');
  const auditPrompt = worker.turnInputs[3];
  assert.match(auditPrompt, /^# Mission c/);
  assert.match(auditPrompt, /## Handoff from session s1[\s\S]*claims to verify[\s\S]*report A1[\s\S]*report A2[\s\S]*report B/);
  assert.doesNotMatch(worker.turnInputs[4], /Handoff/, 'sessions without handoff get the plain cold prompt');
}));

test('handoff keeps the most recent reports within the size budget', () => withDirs(async (home, work) => {
  const big = (tag: string) => `${tag}:${'x'.repeat(Math.ceil(HANDOFF_MAX_CHARS * 0.6))}`;
  const worker = new FakeWorkerAdapter([big('first'), big('second'), 'audit']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'CONTINUE', workerInstruction: 'go on' }, { decision: 'MISSION_COMPLETE' }, { decision: 'MISSION_COMPLETE' }]);
  const config = makeConfig({ sessions: [{ id: 's1', missions: [plainMission('a')] }, { id: 's2', handoff: 'previous', missions: [plainMission('b')] }] });
  const h = await start(home, work, config, worker, supervisor);
  await h.done;
  const prompt = worker.turnInputs[2];
  assert.match(prompt, /1 older report\(s\) omitted/);
  assert.match(prompt, /second:/);
  assert.doesNotMatch(prompt, /first:/);
}));

test('command verifiers run in the working directory', async () => {
  const work = await tempDir();
  try {
    const mission = makeConfig().missions[0];
    const ok = await new CommandVerifier('pwd', 'completion', 'test "$(pwd)" = "$PWD" && exit 0', 5).run({ workingDirectory: work.path, mission, phase: 'completion' });
    assert.equal(ok.passed, true);
    const bad = await new CommandVerifier('fail', 'completion', 'echo boom; exit 3', 5).run({ workingDirectory: work.path, mission, phase: 'completion' });
    assert.equal(bad.passed, false);
    assert.match(bad.output, /boom[\s\S]*exit 3/);
  } finally {
    await work.cleanup();
  }
});

test('sessions: missions of a session share one thread, each session gets a new one, transitions are gated', () => withDirs(async (home, work) => {
  const config = makeConfig({
    sessions: [
      { id: 's1', missions: [
        { id: 'a', title: 'A', prompt: { type: 'COLD_PROMPT', content: 'Do A' } },
        { id: 'b', title: 'B', prompt: { type: 'COLD_PROMPT', content: 'Do B' } }
      ] },
      // The end of s1 waits for a human (mission b asks for it); the rest is automatic.
      { id: 's2', missions: [{ id: 'audit', title: 'Audit', prompt: { type: 'COLD_PROMPT', content: 'Audit' }, execution: { readOnly: true } }] }
    ]
  });
  config.missions[1].requireHumanApproval = true;
  const worker = new FakeWorkerAdapter();
  const h = await start(home, work, config, worker, new FakeSupervisorAdapter());
  // a -> b inside s1: no approval (autoApproveMissions in tests).
  await waitFor(() => h.orchestrator.snapshotState.blocked?.kind === 'MISSION_APPROVAL');
  assert.equal(h.orchestrator.snapshotState.missionIndex, 1, 'blocked at the end of s1, after b');
  assert.match(h.orchestrator.snapshotState.blocked!.reason, /ends session s1[\s\S]*session s2 on a new worker thread/);
  const status = h.orchestrator.statusSummary() as any;
  assert.deepEqual(status.session, { id: 's1', title: null, index: 1, of: 2 });
  assert.equal(status.mission.inSession, 2);
  assert.equal((await h.orchestrator.handleCommand({ command: 'approve', text: 'mission' })).ok, true);
  await h.done;
  const state = await h.store.load();
  assert.equal(state.status, 'COMPLETED');
  const turns = worker.calls.filter((c) => c.kind === 'turn');
  assert.equal(turns.length, 3);
  assert.equal(turns[1].sessionId, turns[0].sessionId, 'b continues the thread of a');
  assert.notEqual(turns[2].sessionId, turns[0].sessionId, 's2 starts a new thread');
  assert.equal(worker.calls.filter((c) => c.kind === 'start').length, 2);
  assert.equal(state.sessions.s1.workerThreadId, turns[0].sessionId);
  assert.equal(state.sessions.s2.workerThreadId, turns[2].sessionId);
  assert.ok(state.sessions.s1.completedAt && state.sessions.s2.completedAt);
  assert.ok(worker.calls.some((c) => c.kind === 'start' && c.readOnly === true));
  assert.match(worker.turnInputs[2], /READ-ONLY/);
  const events = (await h.store.readEvents()).map((e) => e.type);
  assert.equal(events.filter((t) => t === 'session.started').length, 2);
}));

test('dry-run (autoApproveTransitions) crosses session boundaries without approval', () => withDirs(async (home, work) => {
  const config = makeConfig({ runtime: { autoApproveMissions: false }, sessions: [
    { id: 's1', missions: [plainMission('a')] }, { id: 's2', missions: [plainMission('b')] }
  ] });
  const h = await start(home, work, config, new FakeWorkerAdapter(), new FakeSupervisorAdapter(), { autoApproveTransitions: true });
  await h.done;
  assert.equal((await h.store.load()).status, 'COMPLETED');
}));

test('autoApproveMissions false (default) waits for a human at every mission end, inside a session too', () => withDirs(async (home, work) => {
  const config = makeConfig({ runtime: { autoApproveMissions: false }, missions: [plainMission('a'), plainMission('b')] });
  const h = await start(home, work, config, new FakeWorkerAdapter(), new FakeSupervisorAdapter());
  await waitFor(() => h.orchestrator.snapshotState.blocked?.kind === 'MISSION_APPROVAL');
  assert.doesNotMatch(h.orchestrator.snapshotState.blocked!.reason, /ends session/);
  await approveTransitions(h, 2);
  await h.done;
  assert.equal((await h.store.load()).status, 'COMPLETED');
}));

test('autoApproveMissions true: completed missions move on, across sessions too; real blocks still stop the run', () => withDirs(async (home, work) => {
  const config = makeConfig({ runtime: { autoApproveMissions: true }, sessions: [
    { id: 's1', missions: [plainMission('a'), plainMission('b')] },
    { id: 's2', missions: [plainMission('c')] }
  ] });
  const supervisor = new FakeSupervisorAdapter([
    { decision: 'MISSION_COMPLETE' }, { decision: 'MISSION_COMPLETE' },
    { decision: 'BLOCKED', reason: 'KiCad IPC unreachable' }, { decision: 'MISSION_COMPLETE' }
  ]);
  const worker = new FakeWorkerAdapter();
  const h = await start(home, work, config, worker, supervisor);
  await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
  assert.equal(h.orchestrator.snapshotState.blocked!.kind, 'SUPERVISOR', 'a supervisor block is not auto-approved');
  assert.equal(h.orchestrator.snapshotState.activeMissionId, 'c', 'a, b and the s1 -> s2 boundary went by without a human');
  assert.equal((await h.orchestrator.handleCommand({ command: 'resume', text: 'KiCad is open now' })).ok, true);
  await h.done;
  assert.equal((await h.store.load()).status, 'COMPLETED');
  const auto = (await h.store.readEvents()).filter((e) => e.type === 'mission.auto_approved');
  assert.deepEqual(auto.map((e) => [e.data.missionId, e.data.nextSessionId]), [['a', undefined], ['b', 's2'], ['c', undefined]]);
}));

test('autoApproveMissions: a mission with requireHumanApproval: true still waits for a human', () => withDirs(async (home, work) => {
  const config = makeConfig({ runtime: { autoApproveMissions: true }, missions: [plainMission('a'), plainMission('b')] });
  config.missions[0].requireHumanApproval = true;
  const h = await start(home, work, config, new FakeWorkerAdapter(), new FakeSupervisorAdapter());
  await waitFor(() => h.orchestrator.snapshotState.blocked?.kind === 'MISSION_APPROVAL');
  assert.equal(h.orchestrator.snapshotState.activeMissionId, 'a');
  await approveTransitions(h, 1);
  await h.done;
  assert.equal((await h.store.load()).status, 'COMPLETED');
}));

test('maxTurns stops between turns', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter();
  const supervisor = new FakeSupervisorAdapter([], [], { decision: 'CONTINUE' });
  const h = await start(home, work, makeConfig({ runtime: { maxTurns: 3 } }), worker, supervisor);
  await h.done;
  const state = await h.store.load();
  assert.equal(state.status, 'STOPPED');
  assert.equal(turnCount(worker), 3);
  assert.match(state.lastError?.message ?? '', /maxTurns/);
}));

test('per-mission maxTurns blocks the mission', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter();
  const supervisor = new FakeSupervisorAdapter([], [], { decision: 'CONTINUE' });
  const config = makeConfig({ missions: [{ id: 'a', title: 'A', prompt: { type: 'COLD_PROMPT', content: 'x' }, execution: { maxTurns: 2 } }] });
  const h = await start(home, work, config, worker, supervisor);
  await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
  assert.equal(h.orchestrator.snapshotState.blocked?.kind, 'MISSION_LIMIT');
  assert.equal(turnCount(worker), 2);
  h.orchestrator.requestStop();
  await h.done;
}));

test('resumeThread continues an existing Codex thread; CODEX_THREAD_ID is ignored', () => withDirs(async (home, work) => {
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = 'thread-from-env';
  try {
    const worker = new FakeWorkerAdapter();
    const config = makeConfig({ sessions: [
      { id: 'old', resumeThread: 'thread-existing', missions: [plainMission('a')] },
      { id: 'fresh', missions: [plainMission('b')] }
    ] });
    const h = await start(home, work, config, worker, new FakeSupervisorAdapter());
    await h.done;
    assert.deepEqual(worker.calls.slice(0, 2).map((c) => [c.kind, c.sessionId]), [['resume', 'thread-existing'], ['turn', 'thread-existing']]);
    assert.equal(worker.calls[2].kind, 'start', 'the next session starts a new thread');
    assert.ok(!worker.calls.some((c) => c.sessionId === 'thread-from-env'));
    const state = await h.store.load();
    assert.equal(state.sessions.old.workerThreadId, 'thread-existing');
    const resumed = (await h.store.readEvents()).find((e) => e.type === 'worker.session_resumed')!;
    assert.equal((resumed.data as any).fromResumeThread, true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous;
  }
}));

test('only one orchestrator may own a state directory', () => withDirs(async (home, work) => {
  const gate = deferred();
  const worker = new FakeWorkerAdapter([async () => { await gate.promise; return {}; }]);
  const h = await start(home, work, makeConfig(), worker, new FakeSupervisorAdapter());
  const other = new Orchestrator({ config: makeConfig(), store: new Store(home), worker: new FakeWorkerAdapter(), supervisor: new FakeSupervisorAdapter(), workingDirectory: work });
  await assert.rejects(other.open(), (e: unknown) => e instanceof ColdPromptError && e.kind === 'SESSION_LOCK');
  gate.resolve();
  await h.done;
}));

test('state-changing commands are serialized and every HOT_PROMPT is persisted', () => withDirs(async (home, work) => {
  const gate = deferred();
  const worker = new FakeWorkerAdapter([async () => { await gate.promise; return {}; }]);
  const h = await start(home, work, makeConfig(), worker, new FakeSupervisorAdapter());
  await waitFor(() => turnCount(worker) === 1);
  await Promise.all(Array.from({ length: 20 }, (_, i) => h.orchestrator.handleCommand({ command: 'tell', text: `directive ${i}`, raw: true })));
  const persisted = await h.store.load();
  assert.equal(persisted.directives.length, 20);
  assert.equal(persisted.hotPrompts.length, 20);
  gate.resolve();
  await h.done;
}));

test('a CONTINUE that sends the worker to a later mission is asked again once; the plan moves on itself', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const config = makeConfig({
      missions: [
        { id: 'c01-regions', title: 'C01-M01 — Regions', prompt: { type: 'COLD_PROMPT', content: 'Map regions' }, completionCriteria: ['map'], execution: { readOnly: true } },
        { id: 'c01-corridors', title: 'C01-M02 — Corridors', prompt: { type: 'COLD_PROMPT', content: 'Corridors' } },
        { id: 'c01-report', title: 'C01-M03 — Report', prompt: { type: 'COLD_PROMPT', content: 'Report' } }
      ]
    });
    const supervisor = new FakeSupervisorAdapter([
      { decision: 'CONTINUE', workerInstruction: 'Mission C01-M01 is accepted. Proceed to C01-M02, the corridor study.' },
      { decision: 'MISSION_COMPLETE', workerInstruction: '' },
      { decision: 'CONTINUE', workerInstruction: 'Keep going; the report is mission 3.' },
      { decision: 'MISSION_COMPLETE', workerInstruction: '' },
      { decision: 'MISSION_COMPLETE', workerInstruction: '' }
    ]);
    const h = await start(home.path, work.path, config, new FakeWorkerAdapter(['regions', 'corridors', 'report']), supervisor);
    const state = await h.done as any;
    assert.equal(state.status, 'COMPLETED');
    assert.equal(supervisor.evaluations.length, 5, 'one extra review per refused answer');
    assert.match(supervisor.evaluations[1].correction!, /refers to c01-corridors \("C01-M02"\)[\s\S]*return MISSION_COMPLETE/);
    assert.match(supervisor.evaluations[3].correction!, /refers to c01-report \("mission 3"\)/);
    assert.equal(supervisor.evaluations[0].correction, undefined);
    const corrected = (await h.store.readEvents()).filter((e) => e.type === 'review.corrected');
    assert.equal(corrected.length, 2);
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('a CONTINUE that only names the current mission or an earlier one is accepted', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const config = makeConfig({
      missions: [
        { id: 'a', title: 'M1 — A', prompt: { type: 'COLD_PROMPT', content: 'A' } },
        { id: 'b', title: 'M2 — B', prompt: { type: 'COLD_PROMPT', content: 'B' } }
      ]
    });
    const supervisor = new FakeSupervisorAdapter([
      { decision: 'MISSION_COMPLETE', workerInstruction: '' },
      { decision: 'CONTINUE', workerInstruction: 'Reuse the map of M1 and mission 1; finish M2.' },
      { decision: 'MISSION_COMPLETE', workerInstruction: '' }
    ]);
    const h = await start(home.path, work.path, config, new FakeWorkerAdapter(['a', 'b1', 'b2']), supervisor);
    assert.equal((await h.done as any).status, 'COMPLETED');
    assert.equal(supervisor.evaluations.length, 3);
    assert.equal((await h.store.readEvents()).filter((e) => e.type === 'review.corrected').length, 0);
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});

test('extend: a mission at its turn limit gets more turns and resumes on the same thread', () => withDirs(async (home, work) => {
  const worker = new FakeWorkerAdapter(['t1', 't2', 't3']);
  const supervisor = new FakeSupervisorAdapter([{ decision: 'CONTINUE' }, { decision: 'CONTINUE' }, { decision: 'MISSION_COMPLETE' }]);
  const config = makeConfig({ missions: [{ id: 'a', title: 'A', prompt: { type: 'COLD_PROMPT', content: 'Do A' }, execution: { maxTurns: 1 } }] });
  const h = await start(home, work, config, worker, supervisor);
  await waitFor(() => h.orchestrator.snapshotState.blocked?.kind === 'MISSION_LIMIT', 3000, 'MISSION_LIMIT');
  assert.match(h.orchestrator.snapshotState.blocked!.reason, /"extend <n>" adds turns/);
  assert.equal((await h.orchestrator.handleCommand({ command: 'extend', text: '0' })).ok, false);
  const r = await h.orchestrator.handleCommand({ command: 'extend', text: '1' });
  assert.equal(r.ok, true);
  assert.match((r as any).data.message, /limit now 2 turns \(1 used\); resuming/);
  await waitFor(() => h.orchestrator.snapshotState.blocked?.kind === 'MISSION_LIMIT' && turnCount(worker) === 2, 3000, 'limit again after one more turn');
  await h.orchestrator.handleCommand({ command: 'extend', text: '5' });
  await h.done;
  const state = await h.store.load();
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.missions.a.extraTurns, 6);
  assert.equal(turnCount(worker), 3);
  assert.equal(worker.calls.filter((c) => c.kind === 'start').length, 1, 'one worker thread');
}));

test('complete: ends a blocked mission only if its completion checks pass; skip ends it without checks', () => withDirs(async (home, work) => {
  let pass = false;
  const verifier = { name: 'tests', when: 'completion' as const, run: async () => ({ passed: pass, output: pass ? 'ok' : '1 failing' }) };
  const worker = new FakeWorkerAdapter(['a1', 'b1', 'c1']);
  const supervisor = new FakeSupervisorAdapter([
    { decision: 'BLOCKED', reason: 'need a human' },
    { decision: 'BLOCKED', reason: 'stuck again' },
    { decision: 'MISSION_COMPLETE' }
  ]);
  const config = makeConfig({
    verification: { commands: [{ name: 'tests', run: 'true' }] },
    missions: [
      { id: 'a', title: 'A', prompt: { type: 'COLD_PROMPT', content: 'Do A' } },
      { id: 'b', title: 'B', prompt: { type: 'COLD_PROMPT', content: 'Do B' } },
      { id: 'c', title: 'C', prompt: { type: 'COLD_PROMPT', content: 'Do C' } }
    ]
  });
  const h = await start(home, work, config, worker, supervisor, { verifiers: [verifier] });
  await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED', 3000, 'blocked on a');
  const failed = await h.orchestrator.handleCommand({ command: 'complete' });
  assert.equal(failed.ok, false);
  assert.match((failed as any).error, /Completion checks failed[\s\S]*1 failing[\s\S]*"skip"/);
  assert.equal(h.orchestrator.snapshotState.status, 'BLOCKED', 'still blocked on a');
  pass = true;
  assert.equal((await h.orchestrator.handleCommand({ command: 'complete' })).ok, true);
  await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED' && h.orchestrator.snapshotState.activeMissionId === 'b', 3000, 'blocked on b');
  assert.equal((await h.orchestrator.handleCommand({ command: 'skip' })).ok, true);
  await h.done;
  const state = await h.store.load();
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.missions.a.skipped, undefined);
  assert.equal(state.missions.b.skipped, true);
  assert.equal(state.missions.b.status, 'COMPLETED');
  assert.equal(turnCount(worker), 3, 'b was skipped after one turn, c ran');
  const types = (await h.store.readEvents()).map((e) => e.type);
  assert.ok(types.includes('mission.skipped'));
}));

test('complete and skip are refused while a turn may run', () => withDirs(async (home, work) => {
  const gate = deferred<void>();
  const worker = new FakeWorkerAdapter([async () => { await gate.promise; return { finalResponse: 'done' }; }]);
  const h = await start(home, work, makeConfig(), worker, new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]));
  await waitFor(() => h.orchestrator.snapshotState.pendingTurn !== undefined, 3000, 'turn running');
  for (const command of ['complete', 'skip']) {
    const r = await h.orchestrator.handleCommand({ command });
    assert.equal(r.ok, false);
    assert.match((r as any).error, /The run is RUNNING/);
  }
  gate.resolve();
  await h.done;
}));
