/**
 * AGENTS.md §14 acceptance scenario, end to end over the Unix-socket console,
 * with fake worker/supervisor adapters.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ConsoleServer } from '../src/console/server.js';
import { sendOnce } from '../src/console/client.js';
import { deferred, FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir, waitFor } from './helpers.js';

const config = makeConfig({
  missions: [
    { id: 'A', title: 'Mission A', prompt: { type: 'COLD_PROMPT', content: 'Refactor the parser' }, completionCriteria: ['tests pass'] },
    { id: 'B', title: 'Mission B', prompt: { type: 'COLD_PROMPT', content: 'Write documentation' }, completionCriteria: ['docs exist'] }
  ]
});

test('acceptance: two missions, BLOCKED interaction from a remote console, resume, completion, restart', async () => {
  const home = await tempDir(); const work = await tempDir();
  try {
    const bGate = deferred();
    const worker = new FakeWorkerAdapter([
      'A1: parser split', 'A2: tests added',
      'A3: two incompatible grammars; which one?',            // 4. needs human judgment
      'A4: used grammar v2 as resolved; tests pass',
      'B1: docs outline',
      async () => { await bGate.promise; return { finalResponse: 'B2: docs written' }; }
    ]);
    const supervisor = new FakeSupervisorAdapter([
      { decision: 'CONTINUE', workerInstruction: 'Add tests' },                    // 3.
      { decision: 'CONTINUE', workerInstruction: 'Handle grammar' },
      { decision: 'BLOCKED', reason: 'Grammar choice needs a human', workerInstruction: '' }, // 5.
      { decision: 'MISSION_COMPLETE', reason: 'tests pass, evidence given' },        // 13.
      { decision: 'CONTINUE', workerInstruction: 'Write the docs' },
      { decision: 'CONTINUE', workerInstruction: 'Review the docs' }
    ], [{ answer: 'v2 keeps backwards compatibility', proposedDirective: 'Adopt grammar v2' }]);

    // 1-2. ColdPrompt starts mission A; Codex executes multiple turns.
    const h = await start(home.path, work.path, config, worker, supervisor);
    const server = new ConsoleServer(h.orchestrator, h.store.socketPath);
    await server.start();

    // 5-6. BLOCKED stops worker execution.
    await waitFor(() => h.orchestrator.snapshotState.status === 'BLOCKED', 3000, 'BLOCKED');
    const blockedTurns = worker.turnInputs.length;
    assert.equal(blockedTurns, 3);
    const threadA = h.orchestrator.snapshotState.sessions.main.workerThreadId;

    // 7-9. User connects (Termux/SSH), asks Claude a question; worker unchanged.
    const asked = await sendOnce(h.store.socketPath, { command: 'ask', text: 'Which grammar should we use?' }, 3000);
    assert.match(asked.text, /v2 keeps backwards compatibility/);
    assert.equal(worker.turnInputs.length, blockedTurns);
    assert.equal(h.orchestrator.snapshotState.status, 'BLOCKED');
    const proposed = h.orchestrator.snapshotState.directives.find((d) => d.status === 'PROPOSED');
    assert.ok(proposed, 'Claude proposal recorded, not approved');

    // 10. User submits a directive (approves Claude's proposal and adds their own).
    assert.equal((await sendOnce(h.store.socketPath, { command: 'approve', text: proposed!.id })).response.ok, true);
    assert.equal((await sendOnce(h.store.socketPath, { command: 'tell', text: 'Keep v1 behind a flag', raw: true })).response.ok, true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(worker.turnInputs.length, blockedTurns, 'directives alone do not resume');

    // 11. Explicit RESOLUTION.
    assert.equal((await sendOnce(h.store.socketPath, { command: 'resume' })).response.ok, false);
    assert.equal((await sendOnce(h.store.socketPath, { command: 'resume', text: 'Use grammar v2' })).response.ok, true);

    // 12. Same Codex session resumed with the resolution and directives.
    await waitFor(() => worker.turnInputs.length >= 4, 3000, 'turn 4');
    const turn4 = worker.calls.filter((c) => c.kind === 'turn')[3];
    assert.equal(turn4.sessionId, threadA);
    assert.match(turn4.input!, /Use grammar v2[\s\S]*Adopt grammar v2[\s\S]*Keep v1 behind a flag/);

    // 13-14. MISSION_COMPLETE validated; mission B starts.
    await waitFor(() => h.orchestrator.snapshotState.missions.B?.status === 'ACTIVE' && worker.turnInputs.length === 6, 3000, 'mission B turn 2');
    const state = h.orchestrator.snapshotState;
    assert.equal(state.missions.A.status, 'COMPLETED');
    assert.match(worker.turnInputs[4], /Mission B: Mission B[\s\S]*Write documentation/);

    // 15. Restart while B's second turn is running (graceful stop), then resume.
    h.orchestrator.requestStop();
    bGate.resolve();
    await h.done;
    await server.stop();
    const persisted = await h.store.load();
    assert.equal(persisted.totalTurns, 6);
    assert.equal(persisted.pendingTurn, undefined);
    assert.equal(persisted.missionIndex, 1);

    const worker2 = new FakeWorkerAdapter(['B3: docs reviewed']);
    const supervisor2 = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }]);
    const h2 = await start(home.path, work.path, config, worker2, supervisor2);
    const server2 = new ConsoleServer(h2.orchestrator, h2.store.socketPath);
    await server2.start();
    await h2.done;
    await server2.stop();
    const final = await h2.store.load();
    assert.equal(final.status, 'COMPLETED');
    assert.equal(worker2.turnInputs.length, 1, 'no completed turn repeated');
    assert.doesNotMatch(worker2.turnInputs[0], /Write documentation/, 'B cold prompt not re-sent');
    assert.match(worker2.turnInputs[0], /Review the docs/, 'continues from the persisted supervisor instruction');
    assert.equal(worker2.calls[0].kind, 'resume');
    assert.equal(worker2.calls[0].sessionId, threadA);
    assert.equal(final.totalTurns, 7);
    assert.equal(supervisor2.getSessionId(), persisted.supervisorSessionId, 'same Claude conversation');
    assert.ok(!supervisor.concurrentWriterDetected && !supervisor2.concurrentWriterDetected);
    assert.deepEqual(final.hotPrompts.map((p) => [p.intent, p.status]), [
      ['QUESTION', 'ANSWERED'], ['DIRECTIVE', 'APPLIED'], ['RESOLUTION', 'APPLIED']
    ]);

    // Audit trail: every transition is in the append-only log.
    const types = (await h2.store.readEvents()).map((e) => e.type);
    for (const t of ['runtime.blocked', 'hot_prompt.answered', 'directive.approved', 'runtime.resumed', 'mission.completed', 'runtime.completed']) {
      assert.ok(types.includes(t), `event ${t} logged`);
    }
  } finally {
    await home.cleanup(); await work.cleanup();
  }
});
