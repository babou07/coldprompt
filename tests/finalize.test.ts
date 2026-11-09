import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { extractOutput } from '../src/outputs.js';
import { coldPromptText } from '../src/orchestrator.js';
import { ClaudeSupervisorAdapter } from '../src/adapters/claude.js';
import { WebServer } from '../src/web/server.js';
import { Store } from '../src/store.js';
import type { FinalizeRequest } from '../src/supervisor.js';
import { claudeSupervisor, FakeSupervisorAdapter, FakeWorkerAdapter, makeConfig, start, tempDir } from './helpers.js';

const block = (name: string, json: string) => `Report.\n\n\`\`\`coldprompt-output ${name}\n${json}\n\`\`\`\n`;

test('outputs: the last block of the right name, strict JSON only', () => {
  assert.deepEqual(extractOutput('nothing here', 'next'), { found: false });
  assert.deepEqual(extractOutput(block('other', '{"a":1}'), 'next'), { found: false });
  const two = block('next', '{"v":1}') + block('next', '{"v":2}');
  assert.deepEqual(extractOutput(two, 'next'), { found: true, ok: true, value: { v: 2 } });
  const bad = extractOutput(block('next', '{"v":1,}'), 'next');
  assert.equal(bad.found && !bad.ok, true);
});

test('config: "dir/*.yaml" session entries (sorted), proposals need that entry, finalize inputs must exist', async () => {
  const dir = await tempDir();
  try {
    const session = (id: string) => `id: ${id}\nmissions:\n  - id: ${id}-m\n    title: ${id}\n    prompt: { type: COLD_PROMPT, content: do }\n`;
    await mkdir(join(dir.path, 'accepted'));
    await writeFile(join(dir.path, 'first.yaml'), session('first'));
    await writeFile(join(dir.path, 'accepted', 'r010.yaml'), session('r010'));
    await writeFile(join(dir.path, 'accepted', 'r005.yaml'), session('r005'));
    await writeFile(join(dir.path, 'accepted', 'notes.md'), 'not a session');
    const base = `version: 1\nproject: { name: t, workingDirectory: . }\nworker: { provider: codex }\nsupervisor: { provider: claude }\n` +
      `runtime: { maxTurns: 5, maxHours: 1, statusEvery: 1, retryDelaysSeconds: [1], verifyGitCleanOnCompletion: false }\n`;
    const path = join(dir.path, 'coldprompt.yaml');

    await writeFile(path, base + 'proposals: { directory: proposed, acceptInto: accepted }\nsessions: [first.yaml, "accepted/*.yaml"]\n' +
      'finalize: { prompt: "Write the next sessions", inputs: [first-m] }\n');
    const config = await loadConfig(path);
    assert.deepEqual(config.sessions.map((s) => s.id), ['first', 'r005', 'r010']);
    assert.deepEqual(config.finalize, { prompt: 'Write the next sessions', inputs: ['first-m'] });

    await writeFile(path, base + 'proposals: { directory: proposed, acceptInto: accepted }\nsessions: [first.yaml]\n');
    await assert.rejects(loadConfig(path), /accepted\/\*\.yaml/);

    await writeFile(path, base + 'sessions: [first.yaml, "empty/*.yaml"]\nfinalize: { prompt: x, inputs: [nope] }\n');
    await assert.rejects(loadConfig(path), /Unknown mission "nope"/);
  } finally {
    await dir.cleanup();
  }
});

test('a mission with an output cannot complete without a valid block; the block is stored', async () => {
  const home = await tempDir();
  const work = await tempDir();
  try {
    const config = makeConfig({
      missions: [{ id: 'a', title: 'Measure', prompt: { type: 'COLD_PROMPT', content: 'Measure.' }, execution: { readOnly: true, output: 'next' } }]
    });
    assert.match(coldPromptText(config.missions[0]), /```coldprompt-output next/);
    const worker = new FakeWorkerAdapter(['Done, trust me.', block('next', '{"batches":[1,2]}')]);
    const supervisor = new FakeSupervisorAdapter([{ decision: 'MISSION_COMPLETE' }, { decision: 'MISSION_COMPLETE' }]);
    const h = await start(home.path, work.path, config, worker, supervisor);
    const state = await h.done as any;
    assert.equal(state.status, 'COMPLETED');
    assert.equal(worker.turnInputs.length, 2, 'the first MISSION_COMPLETE was rejected');
    assert.match(worker.turnInputs[1], /structured output is missing/);
    assert.deepEqual(JSON.parse(await readFile(h.store.outputPath('a'), 'utf8')), { batches: [1, 2] });
    assert.equal(state.missions.a.output.name, 'next');
    // The supervisor saw the output check among the per-turn checks.
    assert.deepEqual(supervisor.evaluations.map((e) => e.verification.find((v) => v.name === 'output next')?.passed), [false, true]);
  } finally {
    await home.cleanup();
    await work.cleanup();
  }
});

test('finalize: once per completed plan, gets outputs and reports, failures retried at the next run', async () => {
  const home = await tempDir();
  const work = await tempDir();
  try {
    const missions = [
      { id: 'measure', title: 'Measure', prompt: { type: 'COLD_PROMPT', content: 'Measure.' }, execution: { output: 'next' } },
      { id: 'report', title: 'Report', prompt: { type: 'COLD_PROMPT', content: 'Report.' } }
    ];
    const finalize = { prompt: 'Write the next sessions and mail the summary.', inputs: ['measure', 'report'] };
    const config = makeConfig({ missions, finalize });
    const requests: FinalizeRequest[] = [];

    // 1. The supervisor fails: recorded, the plan stays COMPLETED.
    let supervisor = new FakeSupervisorAdapter();
    supervisor.finalize = async () => { throw new Error('mail server down'); };
    let h = await start(home.path, work.path, config, new FakeWorkerAdapter([block('next', '{"n":5}'), 'Final report text']), supervisor);
    let state = await h.done as any;
    assert.equal(state.status, 'COMPLETED');
    assert.equal(state.finalize.status, 'FAILED');
    assert.match(state.finalize.error, /mail server down/);

    // 1b. The supervisor answers but reports a failure (e.g. a refused permission): FAILED too.
    supervisor = new FakeSupervisorAdapter();
    supervisor.finalize = async () => ({ ok: false, summary: 'Write denied: summary not written, mail not sent', files: [] });
    h = await start(home.path, work.path, config, new FakeWorkerAdapter(), supervisor);
    state = await h.done as any;
    assert.equal(state.finalize.status, 'FAILED');
    assert.match(state.finalize.error, /Write denied/);

    // 2. The next run retries it (no worker turn), with the output and the last report.
    supervisor = new FakeSupervisorAdapter();
    supervisor.finalize = async (request) => { requests.push(request); return { ok: true, summary: '5 sessions proposed, mail sent', files: ['proposed/r005.yaml'] }; };
    let worker = new FakeWorkerAdapter();
    h = await start(home.path, work.path, config, worker, supervisor);
    state = await h.done as any;
    assert.equal(worker.turnInputs.length, 0);
    assert.equal(state.finalize.status, 'DONE');
    assert.equal(state.finalize.afterMission, 'report');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].prompt, finalize.prompt);
    assert.deepEqual(requests[0].inputs.map((i) => [i.missionId, i.output, i.lastReport]), [['measure', { n: 5 }, undefined], ['report', undefined, 'Final report text']]);
    assert.deepEqual(requests[0].plan[0].missions.map((m) => m.status), ['COMPLETED', 'COMPLETED']);
    const events = (await h.store.readEvents()).map((e) => e.type);
    assert.ok(events.includes('plan.finalized'));

    // 3. Done: not called again ...
    h = await start(home.path, work.path, config, new FakeWorkerAdapter(), supervisor);
    await h.done;
    assert.equal(requests.length, 1);

    // 4. ... until missions are added to the plan.
    const more = makeConfig({ finalize, sessions: [{ id: 'main', missions }, { id: 'next', missions: [{ id: 'more', title: 'More', prompt: { type: 'COLD_PROMPT', content: 'More.' } }] }] });
    worker = new FakeWorkerAdapter(['more done']);
    h = await start(home.path, work.path, more, worker, supervisor);
    state = await h.done as any;
    assert.equal(worker.turnInputs.length, 1);
    assert.equal(requests.length, 2);
    assert.equal(state.finalize.afterMission, 'more');
  } finally {
    await home.cleanup();
    await work.cleanup();
  }
});

test('Claude finalize: extra permissions for that call only, structured answer', async () => {
  const calls: string[][] = [];
  const runner = async (_cmd: string, args: string[]) => {
    calls.push(args);
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    const out = schema.required.includes('summary') ? { ok: true, summary: 'ok', files: ['a.yaml'] } : { decision: 'CONTINUE', reason: 'r', workerInstruction: 'w', evidence: [] };
    return { code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', structured_output: out }), stderr: '' };
  };
  const config = claudeSupervisor({ finalize: { tools: ['Write', 'Bash', 'Skill'], allowedTools: ['Edit(//p/**)', 'Bash(/s/send.py:*)'], addDirs: ['ignored-here'] } });
  const adapter = new ClaudeSupervisorAdapter(config, '/repo', runner, 1000, ['/abs/proposed', '/abs/skill']);
  const result = await adapter.finalize({ prompt: 'p', project: 't', configDirectory: '/cfg', plan: [], inputs: [] });
  assert.deepEqual(result, { ok: true, summary: 'ok', files: ['a.yaml'] });
  const args = calls[0];
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Write,Bash,Skill');
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3), ['Edit(//p/**)', 'Bash(/s/send.py:*)']);
  assert.deepEqual(args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : [])), ['/abs/proposed', '/abs/skill']);
  // A review afterwards is back to the read-only tools.
  await adapter.evaluateTurn({
    mission: makeConfig().missions[0], missionIndex: 0, missionCount: 1, turnId: 't', missionTurn: 1, workerPrompt: 'x',
    workerResult: { sessionId: 'w', finalResponse: 'r', commands: [], fileChanges: [], errors: [] },
    gitBefore: { isRepo: false, capturedAt: '' }, gitAfter: { isRepo: false, capturedAt: '' }, commits: [], verification: [], deliveredDirectives: []
  });
  const review = calls[1];
  assert.equal(review[review.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.ok(!review.includes('--allowedTools') && !review.includes('--add-dir'));
});

test('web console: proposed sessions are listed, accepted into the plan (no id clash) or dismissed', async () => {
  const home = await tempDir();
  try {
    const proposed = join(home.path, 'proposed');
    const accepted = join(home.path, 'accepted');
    await mkdir(proposed);
    const session = (id: string) => `id: ${id}\ntitle: Batch ${id}\nmissions:\n  - id: ${id}-scope\n    title: Scope\n    prompt: { type: COLD_PROMPT, content: do }\n    execution: { readOnly: true }\n`;
    await writeFile(join(proposed, 'r005.yaml'), session('r005'));
    await writeFile(join(proposed, 'r006.yaml'), session('r001'));
    await writeFile(join(proposed, 'broken.yaml'), 'id: x\n');
    await writeFile(join(proposed, 'summary.md'), '# Summary');
    const web = new WebServer({
      store: new Store(home.path), socketPath: join(home.path, 'none.sock'), host: '127.0.0.1', port: 0, token: 't'.repeat(43), projectName: 't', reconnectMs: 20,
      proposals: { directory: proposed, acceptInto: accepted, planIds: async () => ({ sessions: ['r001'], missions: ['r001-scope'] }) }
    });
    await web.start();
    const base = `http://127.0.0.1:${web.address!.port}`;
    const headers = { Authorization: `Bearer ${'t'.repeat(43)}`, 'Content-Type': 'application/json' };
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
      const list = await (await fetch(base + '/api/proposals', { headers })).json();
      assert.deepEqual(list.data.items.map((i: any) => [i.file, i.id ?? null, Boolean(i.error)]), [['broken.yaml', null, true], ['r005.yaml', 'r005', false], ['r006.yaml', 'r001', false]]);
      assert.deepEqual(list.data.notes, [{ file: 'summary.md', text: '# Summary' }]);
      assert.equal(list.data.items[1].missions[0].readOnly, true);

      assert.equal((await post('/api/proposals/accept', { file: '../state.json' })).status, 400);
      assert.equal((await post('/api/proposals/accept', { file: 'broken.yaml' })).status, 422);
      const clash = await post('/api/proposals/accept', { file: 'r006.yaml' });
      assert.equal(clash.status, 409);
      assert.match((await clash.json()).error, /session r001, mission r001-scope/);

      const ok = await (await post('/api/proposals/accept', { file: 'r005.yaml' })).json();
      assert.equal(ok.ok, true);
      assert.deepEqual(await readdir(accepted), ['r005.yaml']);
      assert.equal((await post('/api/proposals/accept', { file: 'r005.yaml' })).status, 404);

      assert.equal((await (await post('/api/proposals/dismiss', { file: 'r006.yaml' })).json()).ok, true);
      assert.deepEqual(await readdir(join(proposed, 'dismissed')), ['r006.yaml']);
    } finally {
      await web.stop();
    }
  } finally {
    await home.cleanup();
  }
});
