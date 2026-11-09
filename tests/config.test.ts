import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configSchema } from '../src/types.js';
import { loadConfig } from '../src/config.js';
import { makeConfig, tempDir } from './helpers.js';

const base = {
  version: 1,
  project: { name: 'test', workingDirectory: '.' },
  worker: { provider: 'codex' },
  supervisor: { provider: 'claude' },
  runtime: {
    maxTurns: 10,
    maxHours: 1,
    statusEvery: 1,
    retryDelaysSeconds: [30],
    verifyGitCleanOnCompletion: true,
    autoApproveMissions: false
  },
  sessions: [{
    id: 'main',
    missions: [{
      id: 'test',
      title: 'Test mission',
      prompt: { type: 'COLD_PROMPT', content: 'Analyze code' }
    }]
  }]
};
const mission = base.sessions[0].missions[0];
/** The base plan with one session holding `missions`. */
const withMissions = (missions: unknown[], session: Record<string, unknown> = {}) => ({ ...base, sessions: [{ id: 'main', ...session, missions }] });

test('COLD_PROMPT is accepted', () => {
  const result = configSchema.safeParse(base);
  assert.equal(result.success, true);
});

test('defaults: sandbox inherited from the user Codex config, supervisor read-only tools', () => {
  const config = configSchema.parse(base);
  assert.equal(config.worker.provider, 'codex');
  assert.equal(config.supervisor.provider, 'claude');
  if (config.worker.provider !== 'codex' || config.supervisor.provider !== 'claude') return;
  assert.equal(config.worker.sandboxMode, undefined);
  assert.equal(config.worker.approvalPolicy, undefined);
  assert.deepEqual(config.supervisor.tools, ['Read', 'Grep', 'Glob']);
  assert.deepEqual(config.runtime.sessionLockRetryDelaysSeconds, [5, 15, 30, 60]);
  assert.equal(config.missions[0].execution.readOnly, false);
  assert.equal(config.missions[0].session, 'main');
  assert.equal(config.sessions[0].handoff, 'none');
});

test('HOT_PROMPT is not a valid mission prompt type', () => {
  const result = configSchema.safeParse(withMissions([{ ...mission, prompt: { type: 'HOT_PROMPT', content: 'x' } }]));
  assert.equal(result.success, false);
});

test('duplicate mission ids are rejected, also across sessions; duplicate session ids too', () => {
  assert.equal(configSchema.safeParse(withMissions([mission, mission])).success, false);
  assert.equal(configSchema.safeParse({ ...base, sessions: [{ id: 's1', missions: [mission] }, { id: 's2', missions: [mission] }] }).success, false);
  assert.equal(configSchema.safeParse({ ...base, sessions: [{ id: 's', missions: [mission] }, { id: 's', missions: [{ ...mission, id: 'other' }] }] }).success, false);
});

test('missions are flattened in order and tagged with their session', () => {
  const config = configSchema.parse({ ...base, sessions: [
    { id: 's1', missions: [{ ...mission, id: 'a' }, { ...mission, id: 'b' }] },
    { id: 's2', resumeThread: 'th-1', handoff: 'previous', missions: [{ ...mission, id: 'c' }] }
  ] });
  assert.deepEqual(config.missions.map((m) => [m.id, m.session]), [['a', 's1'], ['b', 's1'], ['c', 's2']]);
  assert.equal(config.sessions[1].resumeThread, 'th-1');
});

test('handoff: previous is rejected on the first session', () => {
  assert.equal(configSchema.safeParse(withMissions([mission], { handoff: 'previous' })).success, false);
});

test('newWorkerThread and mission-level handoff no longer exist', () => {
  assert.equal(configSchema.safeParse(withMissions([{ ...mission, execution: { newWorkerThread: true } }])).success, false);
  assert.equal(configSchema.safeParse(withMissions([{ ...mission, execution: { handoff: 'previous' } }])).success, false);
});

test('unknown mission verification references are rejected', () => {
  const result = configSchema.safeParse(withMissions([{ ...mission, verification: ['nope'] }]));
  assert.equal(result.success, false);
});

test('unknown worker keys are rejected (typos must not be ignored)', () => {
  const result = configSchema.safeParse({ ...base, worker: { provider: 'codex', sandbox: 'read-only' } });
  assert.equal(result.success, false);
});

test('empty mission or session lists and invalid runtime values are rejected', () => {
  assert.equal(configSchema.safeParse(withMissions([])).success, false);
  assert.equal(configSchema.safeParse({ ...base, sessions: [] }).success, false);
  assert.equal(configSchema.safeParse({ ...base, runtime: { ...base.runtime, maxTurns: 0 } }).success, false);
});

test('loadConfig reports file and path of validation errors', async () => {
  const dir = await tempDir();
  try {
    const path = join(dir.path, 'bad.yaml');
    await writeFile(path, 'version: 2\n');
    await assert.rejects(loadConfig(path), /bad\.yaml[\s\S]*version/);
  } finally {
    await dir.cleanup();
  }
});

const planYaml = (sessions: string[]) => [
  'version: 1',
  'project: { name: t, workingDirectory: . }',
  'worker: { provider: codex }',
  'supervisor: { provider: claude }',
  'runtime: { maxTurns: 5, maxHours: 1, statusEvery: 1, retryDelaysSeconds: [1], verifyGitCleanOnCompletion: false, autoApproveMissions: false }',
  'sessions:',
  ...sessions.map((f) => `  - ${f}`)
].join('\n') + '\n';
const sessionYaml = (id: string, missionIds: string[], extra = '') =>
  `id: ${id}\n${extra}missions:\n` + missionIds.map((m) => `  - id: ${m}\n    title: ${m}\n    prompt: { type: COLD_PROMPT, content: do ${m} }\n`).join('');

test('loadConfig reads the session files listed in coldprompt.yaml, relative to it', async () => {
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'sessions'));
    await writeFile(join(dir.path, 'coldprompt.yaml'), planYaml(['sessions/one.yaml', 'sessions/two.yaml']));
    await writeFile(join(dir.path, 'sessions/one.yaml'), sessionYaml('one', ['a', 'b']));
    await writeFile(join(dir.path, 'sessions/two.yaml'), sessionYaml('two', ['c'], 'resumeThread: th-9\nhandoff: previous\n'));
    const config = await loadConfig(join(dir.path, 'coldprompt.yaml'));
    assert.deepEqual(config.sessions.map((x) => [x.id, x.file]), [['one', 'sessions/one.yaml'], ['two', 'sessions/two.yaml']]);
    assert.deepEqual(config.missions.map((m) => m.id), ['a', 'b', 'c']);
    assert.equal(config.sessions[1].resumeThread, 'th-9');
  } finally {
    await dir.cleanup();
  }
});

test('loadConfig: clear errors for missions in coldprompt.yaml, bad session files and cross-file duplicates', async () => {
  const dir = await tempDir();
  try {
    const plan = join(dir.path, 'coldprompt.yaml');
    await writeFile(plan, planYaml(['one.yaml']) + 'missions: []\n');
    await assert.rejects(loadConfig(plan), /missions are declared in session files/);
    await writeFile(plan, planYaml(['missing.yaml']));
    await assert.rejects(loadConfig(plan), /Cannot read session file[\s\S]*missing\.yaml/);
    await writeFile(join(dir.path, 'one.yaml'), sessionYaml('one', ['a']).replace('    title: a\n', '    title: a\n    execution: { newWorkerThread: true }\n'));
    await writeFile(plan, planYaml(['one.yaml']));
    await assert.rejects(loadConfig(plan), /Invalid session file .*one\.yaml[\s\S]*newWorkerThread was removed/);
    await writeFile(join(dir.path, 'one.yaml'), sessionYaml('one', ['a']));
    await writeFile(join(dir.path, 'two.yaml'), sessionYaml('two', ['a']));
    await writeFile(plan, planYaml(['one.yaml', 'two.yaml']));
    await assert.rejects(loadConfig(plan), /two\.yaml: missions\.0\.id: Duplicate mission id "a"/);
  } finally {
    await dir.cleanup();
  }
});

test('the example coldprompt.example.yaml is valid', async () => {
  const config = await loadConfig(new URL('../coldprompt.example.yaml', import.meta.url).pathname);
  assert.ok(config.missions.length >= 1);
});

test('autoApproveMissions defaults to false; the old approval key is refused with a hint', async () => {
  assert.equal(makeConfig({ runtime: { autoApproveMissions: undefined } }).runtime.autoApproveMissions, false);
  const dir = await tempDir();
  try {
    await mkdir(join(dir.path, 'sessions'));
    await writeFile(join(dir.path, 'sessions', 'one.yaml'), 'id: one\nmissions:\n  - { id: a, title: A, prompt: { type: COLD_PROMPT, content: x } }\n');
    await writeFile(join(dir.path, 'coldprompt.yaml'), planYaml(['sessions/one.yaml']).replace('autoApproveMissions: false', 'requireHumanApprovalForMissionTransition: true'));
    await assert.rejects(loadConfig(join(dir.path, 'coldprompt.yaml')), /requireHumanApprovalForMissionTransition was replaced by runtime\.autoApproveMissions/);
  } finally {
    await dir.cleanup();
  }
});
