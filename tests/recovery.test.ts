import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { cp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { deferred, FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor } from './helpers.js';

const turnCount = (w: FakeWorkerAdapter) => w.calls.filter((c) => c.kind === 'turn').length;

/** Copies the state directory as a crashed process would have left it (lock included, owner dead). */
async function crashCopy(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true });
  await writeFile(join(to, 'owner.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, hostname: (await import('node:os')).hostname(), acquiredAt: 'then' }));
  await rm(join(to, 'console.sock'), { force: true });
}

async function dirs() {
  const a = await tempDir(); const b = await tempDir(); const w = await tempDir('coldprompt-work-');
  return { a: a.path, b: b.path, work: w.path, cleanup: async () => { await a.cleanup(); await b.cleanup(); await w.cleanup(); } };
}

test('crash during a worker turn: restart blocks on the ambiguous turn and never re-runs it automatically', async () => {
  const d = await dirs();
  try {
    const gate = deferred();
    const worker = new FakeWorkerAdapter(['turn 1', async () => { await gate.promise; return { finalResponse: 'never seen' }; }]);
    const h = await start(d.a, d.work, makeConfig(), worker, new FakeSupervisorAdapter([{ decision: 'CONTINUE', workerInstruction: 'step two' }]));
    await waitFor(() => turnCount(worker) === 2);
    await waitFor(async () => (await h.store.load()).pendingTurn?.phase === 'WORKER_RUNNING');
    const threadId = (await h.store.load()).sessions.main.workerThreadId;
    await crashCopy(d.a, d.b);

    const worker2 = new FakeWorkerAdapter(['after resolution']);
    const supervisor2 = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]);
    const h2 = await start(d.b, d.work, makeConfig(), worker2, supervisor2);
    await waitFor(() => h2.orchestrator.snapshotState.status === 'BLOCKED');
    const state = h2.orchestrator.snapshotState;
    assert.equal(state.blocked?.kind, 'AMBIGUOUS_TURN');
    assert.equal(state.pendingTurn, undefined);
    assert.equal(state.totalTurns, 1, 'the interrupted turn is not counted');
    assert.equal(turnCount(worker2), 0, 'no automatic re-execution');
    assert.ok((await h2.store.listArtifacts()).some((f) => f.endsWith('.abandoned.json')));

    await h2.orchestrator.handleCommand({ command: 'resume', text: 'Turn 2 did not finish; re-check the tree and redo step two.' });
    await h2.done;
    assert.deepEqual(worker2.calls[0], { kind: 'resume', sessionId: threadId, readOnly: false });
    assert.match(worker2.turnInputs[0], /re-check the tree[\s\S]*step two/);
    assert.equal((await h2.store.load()).status, 'COMPLETED');

    gate.resolve();
    await h.orchestrator.abortActiveTurn();
    await h.done;
  } finally {
    await d.cleanup();
  }
});

test('forced stop (abort) during a turn is also recovered as ambiguous', async () => {
  const d = await dirs();
  try {
    const worker = new FakeWorkerAdapter([() => new Promise(() => undefined)]);
    const h = await start(d.a, d.work, makeConfig(), worker, new FakeSupervisorAdapter());
    await waitFor(() => turnCount(worker) === 1);
    await h.orchestrator.abortActiveTurn();
    await h.done;
    assert.equal((await h.store.load()).pendingTurn?.phase, 'WORKER_RUNNING');

    const worker2 = new FakeWorkerAdapter();
    const h2 = await start(d.a, d.work, makeConfig(), worker2, new FakeSupervisorAdapter());
    await waitFor(() => h2.orchestrator.snapshotState.status === 'BLOCKED');
    assert.equal(h2.orchestrator.snapshotState.blocked?.kind, 'AMBIGUOUS_TURN');
    assert.equal(turnCount(worker2), 0);
    h2.orchestrator.requestStop();
    await h2.done;
  } finally {
    await d.cleanup();
  }
});

test('crash after the worker turn but before review: restart reviews it without re-running the worker', async () => {
  const d = await dirs();
  try {
    const reviewGate = deferred();
    const worker = new FakeWorkerAdapter(['result 1']);
    const supervisor = new FakeSupervisorAdapter([async () => { await reviewGate.promise; return { decision: 'CONTINUE' }; }]);
    const h = await start(d.a, d.work, makeConfig(), worker, supervisor);
    await waitFor(async () => (await h.store.load()).pendingTurn?.phase === 'WORKER_DONE');
    await crashCopy(d.a, d.b);

    const worker2 = new FakeWorkerAdapter();
    const supervisor2 = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]);
    const h2 = await start(d.b, d.work, makeConfig(), worker2, supervisor2);
    await h2.done;
    assert.equal(turnCount(worker2), 0, 'completed worker turn is not duplicated');
    assert.equal(supervisor2.evaluations.length, 1);
    assert.equal(supervisor2.evaluations[0].workerResult.finalResponse, 'result 1');
    const state = await h2.store.load();
    assert.equal(state.status, 'COMPLETED');
    assert.equal(state.totalTurns, 1);

    reviewGate.resolve();
    await h.done;
  } finally {
    await d.cleanup();
  }
});

test('crash after the review but before applying it: restart applies the persisted decision only', async () => {
  const d = await dirs();
  try {
    let stop = () => {};
    const worker = new FakeWorkerAdapter(['r1']);
    const supervisor = new FakeSupervisorAdapter([async () => { stop(); return { decision: 'CONTINUE', workerInstruction: 'persisted instruction' }; }]);
    const h = await start(d.a, d.work, makeConfig(), worker, supervisor);
    stop = () => h.orchestrator.requestStop();
    // Stop right after the first review, then rewind the state to "REVIEWED, not applied".
    await h.done;
    assert.equal(turnCount(worker), 1);
    const store = new Store(d.a);
    const state = await store.load();
    const turnId = state.lastReviewRef!.replace('turns/', '').replace('.review.json', '');
    state.pendingTurn = {
      turnId, missionId: 'a', missionTurn: 1, phase: 'REVIEWED', prompt: 'p', inputSource: 'COLD_PROMPT',
      deliveredDirectiveIds: [], startedAt: state.createdAt, gitBefore: { isRepo: false, capturedAt: state.createdAt },
      resultRef: state.lastResultRef, reviewRef: state.lastReviewRef
    };
    state.nextWorkerInput = undefined;
    state.status = 'RUNNING';
    await store.save(state);

    const worker2 = new FakeWorkerAdapter();
    const supervisor2 = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]);
    const h2 = await start(d.a, d.work, makeConfig(), worker2, supervisor2);
    await h2.done;
    assert.equal(turnCount(worker2), 1);
    assert.match(worker2.turnInputs[0], /persisted instruction/);
    assert.equal(supervisor2.evaluations.length, 1, 'the earlier review is not repeated');
    assert.equal((await store.load()).totalTurns, 2);
  } finally {
    await d.cleanup();
  }
});

test('graceful stop lets the active turn finish; restart continues without duplicating it', async () => {
  const d = await dirs();
  try {
    const gate = deferred();
    const worker = new FakeWorkerAdapter([async () => { await gate.promise; return { finalResponse: 'turn 1' }; }]);
    const supervisor = new FakeSupervisorAdapter([{ decision: 'CONTINUE', workerInstruction: 'turn two please' }]);
    const h = await start(d.a, d.work, makeConfig(), worker, supervisor);
    await waitFor(() => turnCount(worker) === 1);
    h.orchestrator.requestStop();
    gate.resolve();
    await h.done;
    let state = await h.store.load();
    assert.equal(state.status, 'STOPPED');
    assert.equal(state.totalTurns, 1);
    assert.equal(state.pendingTurn, undefined);
    assert.ok(!worker.calls.some((c) => c.kind === 'cancel'));

    const worker2 = new FakeWorkerAdapter(['turn 2']);
    const h2 = await start(d.a, d.work, makeConfig(), worker2, new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]));
    await h2.done;
    assert.equal(turnCount(worker2), 1);
    assert.match(worker2.turnInputs[0], /turn two please/);
    assert.doesNotMatch(worker2.turnInputs[0], /COLD_PROMPT|Mission a:/);
    state = await h2.store.load();
    assert.equal(state.totalTurns, 2);
    assert.equal(worker2.calls[0].kind, 'resume');
  } finally {
    await d.cleanup();
  }
});

test('queued and in-flight HOT_PROMPTs survive a crash and are answered after restart', async () => {
  const d = await dirs();
  try {
    const hold = deferred();
    const worker = new FakeWorkerAdapter([async () => { await hold.promise; return {}; }]);
    const supervisor = new FakeSupervisorAdapter([], [() => new Promise(() => undefined)]);
    const h = await start(d.a, d.work, makeConfig(), worker, supervisor);
    await waitFor(() => turnCount(worker) === 1);
    await h.orchestrator.handleCommand({ command: 'ask', text: 'first (in flight)' });
    await h.orchestrator.handleCommand({ command: 'ask', text: 'second (queued)' });
    await h.orchestrator.handleCommand({ command: 'tell', text: 'pending human directive', raw: true });
    await waitFor(async () => (await h.store.load()).hotPrompts.some((p) => p.status === 'PROCESSING'));
    await crashCopy(d.a, d.b);

    const worker2 = new FakeWorkerAdapter();
    const supervisor2 = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }], [{ answer: 'A1' }, { answer: 'A2' }]);
    const h2 = await start(d.b, d.work, makeConfig(), worker2, supervisor2);
    await waitFor(() => h2.orchestrator.snapshotState.hotPrompts.filter((p) => p.status === 'ANSWERED').length === 2);
    // The crash happened mid-turn, so the run is BLOCKED on the ambiguous turn: questions are still answered.
    assert.equal(h2.orchestrator.snapshotState.blocked?.kind, 'AMBIGUOUS_TURN');
    assert.equal(turnCount(worker2), 0);
    assert.equal(h2.orchestrator.snapshotState.directives[0].status, 'APPROVED', 'pending directive kept');
    h2.orchestrator.requestStop();
    await h2.done;
    const state = await h2.store.load();
    assert.deepEqual(state.hotPrompts.filter((p) => p.intent === 'QUESTION').map((p) => [p.content, p.answer]), [
      ['first (in flight)', 'A1'], ['second (queued)', 'A2']
    ]);
    assert.equal(state.status, 'BLOCKED');
    hold.resolve();
    await h.orchestrator.abortActiveTurn();
    await h.done;
  } finally {
    await d.cleanup();
  }
});

test('supervisor conversation is resumed with the persisted session id', async () => {
  const d = await dirs();
  try {
    const worker = new FakeWorkerAdapter();
    const supervisor = new FakeSupervisorAdapter([{ decision: 'CONTINUE' }], [], { decision: 'CONTINUE' });
    const h = await start(d.a, d.work, makeConfig({ runtime: { maxTurns: 1 } }), worker, supervisor);
    await h.done;
    const sessionId = (await h.store.load()).supervisorSessionId;
    assert.ok(sessionId);
    const supervisor2 = new FakeSupervisorAdapter();
    const h2 = await start(d.a, d.work, makeConfig(), new FakeWorkerAdapter(), supervisor2);
    await h2.done;
    assert.equal(supervisor2.getSessionId(), sessionId);
    assert.equal((await h2.store.load()).supervisorSessionId, sessionId);
  } finally {
    await d.cleanup();
  }
});

test('v1 state files migrate without losing HOT_PROMPTs or the blocked state', async () => {
  const d = await dirs();
  try {
    await writeFile(join(d.a, 'state.json'), JSON.stringify({
      version: 1, status: 'BLOCKED', missionIndex: 0, missionTurns: 2, totalTurns: 2, workerThreadId: 'th-1',
      blockedReason: 'legacy block', pendingWorkerDirective: 'legacy directive',
      hotPrompts: [{ id: 'h1', type: 'HOT_PROMPT', intent: 'QUESTION', content: 'old q', createdAt: 'x', status: 'QUEUED' }],
      updatedAt: 'x'
    }));
    const state = await new Store(d.a).load();
    assert.equal(state.version, 3);
    assert.equal(state.blocked?.reason, 'legacy block');
    assert.equal(state.hotPrompts[0].content, 'old q');
    assert.equal(state.directives[0].content, 'legacy directive');
    assert.equal(state.legacyWorkerThreadId, 'th-1');
  } finally {
    await d.cleanup();
  }
});

test('v2 state: the shared thread goes to the current session and is resumed', async () => {
  const d = await dirs();
  try {
    await writeFile(join(d.a, 'state.json'), JSON.stringify({
      version: 2, status: 'RUNNING', missionIndex: 1, activeMissionId: 'b', missionTurns: 0, totalTurns: 1,
      missions: { a: { status: 'COMPLETED', turns: 1, workerThreadId: 'th-audit' }, b: { status: 'ACTIVE', turns: 0 } },
      workerThreadId: 'th-shared', supervisorSessionStarted: false, pauseRequested: false, hotPrompts: [], directives: [],
      createdAt: 'x', updatedAt: 'x'
    }));
    const config = makeConfig({ sessions: [
      { id: 's1', missions: [{ id: 'a', title: 'A', prompt: { type: 'COLD_PROMPT', content: 'A' } }] },
      { id: 's2', missions: [{ id: 'b', title: 'B', prompt: { type: 'COLD_PROMPT', content: 'B' } }] }
    ] });
    const worker = new FakeWorkerAdapter();
    const h = await start(d.a, d.work, config, worker, new FakeSupervisorAdapter());
    await h.done;
    assert.deepEqual(worker.calls[0], { kind: 'resume', sessionId: 'th-shared', readOnly: false });
    const state = await h.store.load();
    assert.equal(state.sessions.s2.workerThreadId, 'th-shared');
    assert.equal(state.legacyWorkerThreadId, undefined);
    assert.equal((state.missions.a as any).workerThreadId, undefined, 'per-mission threads are dropped');
  } finally {
    await d.cleanup();
  }
});

test('a stale lock from a dead process is taken over; a live one is refused', async () => {
  const d = await dirs();
  try {
    const store = new Store(d.a);
    await store.ensureDirectory();
    await writeFile(store.lockPath, JSON.stringify({ pid: 2 ** 22 + 999, hostname: (await import('node:os')).hostname(), acquiredAt: 'then' }));
    await store.acquireLock();
    assert.equal((await store.readLock())?.pid, process.pid);
    await store.releaseLock();
    await writeFile(store.lockPath, JSON.stringify({ pid: process.ppid, hostname: (await import('node:os')).hostname(), acquiredAt: 'now' }));
    await assert.rejects(new Store(d.a).acquireLock(), /will not kill/);
  } finally {
    await d.cleanup();
  }
});

test('restart refuses a reordered mission list, and runs missions appended after completion', async () => {
  const d = await dirs();
  try {
    const two = makeConfig({ missions: [
      { id: 'a', title: 'A', prompt: { type: 'COLD_PROMPT', content: 'A' } },
      { id: 'b', title: 'B', prompt: { type: 'COLD_PROMPT', content: 'B' } }
    ] });
    const h = await start(d.a, d.work, makeConfig(), new FakeWorkerAdapter(), new FakeSupervisorAdapter());
    await h.done;
    assert.equal((await h.store.load()).status, 'COMPLETED');

    const reordered = makeConfig({ missions: [two.missions[1], two.missions[0]] });
    const { Orchestrator } = await import('../src/orchestrator.js');
    const bad = new Orchestrator({ config: reordered, store: new Store(d.a), worker: new FakeWorkerAdapter(), supervisor: new FakeSupervisorAdapter(), workingDirectory: d.work });
    await assert.rejects(bad.open(), /no longer matches/);

    const worker = new FakeWorkerAdapter();
    const h2 = await start(d.a, d.work, two, worker, new FakeSupervisorAdapter());
    await h2.done;
    assert.equal(worker.turnInputs.length, 1);
    assert.match(worker.turnInputs[0], /Mission b/);
    assert.equal((await h2.store.load()).status, 'COMPLETED');
  } finally {
    await d.cleanup();
  }
});

test('time spent BLOCKED does not count toward maxHours', async () => {
  const d = await dirs();
  try {
    let clock = 0;
    const worker = new FakeWorkerAdapter();
    const supervisor = new FakeSupervisorAdapter([{ decision: 'BLOCKED', reason: 'wait' }, { decision: 'MISSION_COMPLETE' }]);
    const h = await start(d.a, d.work, makeConfig({ runtime: { maxHours: 1 } }), worker, supervisor, { now: () => clock });
    await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED');
    // The run loop must be waiting for the human before the clock moves.
    await waitFor(() => (h.orchestrator as any).waiter !== undefined, 3000, 'run loop waiting');
    clock += 10 * 3_600_000; // the human answers ten hours later
    await h.orchestrator.handleCommand({ command: 'resume', text: 'ok' });
    await h.done;
    assert.equal((await h.store.load()).status, 'COMPLETED');
    assert.equal(worker.turnInputs.length, 2);
  } finally {
    await d.cleanup();
  }
});
