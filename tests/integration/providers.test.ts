/**
 * Real-provider tests. Opt-in: COLDPROMPT_INTEGRATION=1 npm run test:integration
 * They run in throwaway directories, read-only, and never touch a user project.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeSupervisorAdapter } from '../../src/adapters/claude.js';
import { CodexWorkerAdapter } from '../../src/adapters/codex.js';
import { ClaudeWorkerAdapter } from '../../src/adapters/claude-worker.js';
import { CodexSupervisorAdapter } from '../../src/adapters/codex-supervisor.js';
import { claudeSupervisor, claudeWorker, codexSupervisor, codexWorker, makeConfig, tempDir } from '../helpers.js';

const enabled = process.env.COLDPROMPT_INTEGRATION === '1';
const skip = enabled ? false : 'set COLDPROMPT_INTEGRATION=1 to run real-provider tests';

test('Claude CLI: structured review, then a resumed conversation remembers it', { skip, timeout: 300_000 }, async () => {
  const dir = await tempDir();
  try {
    const config = makeConfig();
    const claude = new ClaudeSupervisorAdapter(claudeSupervisor({ model: process.env.COLDPROMPT_CLAUDE_MODEL ?? 'haiku', tools: [] }), dir.path);
    await claude.validateCli();
    const review = await claude.evaluateTurn({
      mission: config.missions[0], missionIndex: 0, missionCount: 1, turnId: 't1', missionTurn: 1,
      workerPrompt: 'Do A', workerResult: { sessionId: 'w', finalResponse: 'I created file A and ran the tests: 3 passed. The codeword is PINEAPPLE.', commands: [{ command: 'npm test', exitCode: 0, status: 'completed' }], fileChanges: [], errors: [] },
      gitBefore: { isRepo: false, capturedAt: '' }, gitAfter: { isRepo: false, capturedAt: '' }, commits: [], verification: [], deliveredDirectives: []
    });
    assert.ok(['CONTINUE', 'CLARIFY', 'BLOCKED', 'MISSION_COMPLETE', 'STOP'].includes(review.decision));
    const id = claude.getSessionId();
    const resumed = new ClaudeSupervisorAdapter(claudeSupervisor({ model: process.env.COLDPROMPT_CLAUDE_MODEL ?? 'haiku', tools: [] }), dir.path);
    await resumed.resumeSession(id!, true);
    const answer = await resumed.interact({ intent: 'QUESTION', content: 'What codeword did the worker mention in its last turn? Answer with the word only.', status: 'RUNNING' });
    assert.match(answer.answer, /PINEAPPLE/i);
    assert.equal(resumed.getSessionId(), id);
  } finally {
    await dir.cleanup();
  }
});

test('Codex SDK: read-only thread starts, reports its id, and resumes', { skip, timeout: 600_000 }, async () => {
  const dir = await tempDir('coldprompt-codex-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir.path });
    await writeFile(join(dir.path, 'README.md'), 'The secret number is 4127.\n');
    const codex = new CodexWorkerAdapter(codexWorker({ codexPath: process.env.COLDPROMPT_CODEX_PATH }));
    await codex.startSession({ workingDirectory: dir.path, readOnly: true });
    const ids: string[] = [];
    const first = await codex.executeTurn('Read README.md and reply with the secret number only. Do not modify anything.', { onSessionId: (id) => { ids.push(id); } });
    assert.match(first.finalResponse, /4127/);
    assert.equal(ids.length, 1);
    const threadId = codex.getSessionId()!;
    const again = new CodexWorkerAdapter(codexWorker({ codexPath: process.env.COLDPROMPT_CODEX_PATH }));
    await again.resumeSession(threadId, { workingDirectory: dir.path, readOnly: true });
    const second = await again.executeTurn('What number did you reply with last time? Reply with the number only, without reading any file.');
    assert.match(second.finalResponse, /4127/);
    assert.equal(again.getSessionId(), threadId);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir.path, encoding: 'utf8' }).trim(), '?? README.md');
  } finally {
    await dir.cleanup();
  }
});

test('Claude Code worker: read-only conversation starts, reports its id, and resumes', { skip, timeout: 600_000 }, async () => {
  const dir = await tempDir('coldprompt-claude-worker-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir.path });
    await writeFile(join(dir.path, 'README.md'), 'The secret number is 4127.\n');
    const config = claudeWorker({ model: process.env.COLDPROMPT_CLAUDE_MODEL ?? 'haiku' });
    const worker = new ClaudeWorkerAdapter(config);
    await worker.validateCli(dir.path);
    await worker.startSession({ workingDirectory: dir.path, readOnly: true });
    const ids: string[] = [];
    const first = await worker.executeTurn('Read README.md and reply with the secret number only. Do not modify anything.', { onSessionId: (id) => { ids.push(id); } });
    assert.match(first.finalResponse, /4127/);
    assert.equal(ids.length, 1);
    const again = new ClaudeWorkerAdapter(config);
    await again.resumeSession(ids[0], { workingDirectory: dir.path, readOnly: true });
    const second = await again.executeTurn('What number did you reply with last time? Reply with the number only, without reading any file.');
    assert.match(second.finalResponse, /4127/);
    assert.equal(again.getSessionId(), ids[0]);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir.path, encoding: 'utf8' }).trim(), '?? README.md');
  } finally {
    await dir.cleanup();
  }
});

test('Codex supervisor: structured review, then a resumed thread remembers it', { skip, timeout: 600_000 }, async () => {
  const dir = await tempDir('coldprompt-codex-sup-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir.path });
    const config = makeConfig();
    const supervisorConfig = codexSupervisor({ codexPath: process.env.COLDPROMPT_CODEX_PATH });
    const codex = new CodexSupervisorAdapter(supervisorConfig, dir.path);
    const review = await codex.evaluateTurn({
      mission: config.missions[0], missionIndex: 0, missionCount: 1, turnId: 't1', missionTurn: 1,
      workerPrompt: 'Do A', workerResult: { sessionId: 'w', finalResponse: 'I created file A and ran the tests: 3 passed. The codeword is PINEAPPLE.', commands: [{ command: 'npm test', exitCode: 0, status: 'completed' }], fileChanges: [], errors: [] },
      gitBefore: { isRepo: false, capturedAt: '' }, gitAfter: { isRepo: false, capturedAt: '' }, commits: [], verification: [], deliveredDirectives: []
    });
    assert.ok(['CONTINUE', 'CLARIFY', 'BLOCKED', 'MISSION_COMPLETE', 'STOP'].includes(review.decision));
    const id = codex.getSessionId();
    assert.ok(id);
    const resumed = new CodexSupervisorAdapter(supervisorConfig, dir.path);
    await resumed.resumeSession(id!, true);
    const answer = await resumed.interact({ intent: 'QUESTION', content: 'What codeword did the worker mention in its last turn? Answer with the word only.', status: 'RUNNING' });
    assert.match(answer.answer, /PINEAPPLE/i);
    assert.equal(resumed.getSessionId(), id);
  } finally {
    await dir.cleanup();
  }
});
