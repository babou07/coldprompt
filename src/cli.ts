import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig, resolveWorkingDirectory } from './config.js';
import { Store } from './store.js';
import { Orchestrator, HELP_TEXT } from './orchestrator.js';
import { snapshot } from './git.js';
import { buildVerifiers, configDirectoryOf, readOnlyCompletionChecks } from './verification.js';
import { ColdPromptError, errorMessage, redact } from './errors.js';
import { CodexWorkerAdapter } from './adapters/codex.js';
import { ClaudeSupervisorAdapter } from './adapters/claude.js';
import { FakeSupervisorAdapter, FakeWorkerAdapter } from './adapters/fake.js';
import { ConsoleServer } from './console/server.js';
import { formatStatus, runInteractiveConsole, sendOnce } from './console/client.js';
import { parseCommandLine } from './console/protocol.js';
import type { Config } from './types.js';
import { WebServer, loadOrCreateToken } from './web/server.js';
import { findOnPath, renderUnits } from './web/systemd.js';

const exec = promisify(execFile);

/** Mirrors @openai/codex-sdk's default binary resolution (vendored per platform). */
function bundledCodexPath(): string {
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`;
  const sdkEntry = fileURLToPath(import.meta.resolve('@openai/codex-sdk'));
  return join(dirname(sdkEntry), '..', 'vendor', triple, 'codex', 'codex');
}

const USAGE = `Usage: coldprompt <command>

  run [--dry-run]     Run the mission queue (owner process; starts the console socket)
  console             Interactive console (connects to the running orchestrator)
  send <command...>   Send one console command, e.g. send ask "why blocked?"
  status              Live status if running, otherwise the persisted state
  doctor              Validate config, Claude CLI options, Codex and repository
  events [n]          Print the last n events (default 20)
  web [--host H] [--port P] [--run-unit U]
                      Web console (status, live Codex activity, HOT_PROMPTs);
                      default 127.0.0.1:8787, token in <COLDPROMPT_HOME>/web-token
  systemd [--write]   Print (or write to ~/.config/systemd/user) units for run and web

Environment: COLDPROMPT_CONFIG (coldprompt.yaml), COLDPROMPT_HOME (.coldprompt next to the config).
A session file (listed under "sessions:" in coldprompt.yaml) is one Codex thread;
set "resumeThread:" in it to continue an existing thread.

Console commands:
${HELP_TEXT}`;

const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const configPath = resolve(process.env.COLDPROMPT_CONFIG ?? 'coldprompt.yaml');
const home = resolve(configDirectoryOf(configPath), process.env.COLDPROMPT_HOME ?? '.coldprompt');
const store = new Store(home);

const log = (message: string) => process.stderr.write(`${new Date().toISOString()} coldprompt: ${redact(message)}\n`);

async function isIgnored(workdir: string, path: string): Promise<boolean> {
  try {
    await exec('git', ['check-ignore', '-q', path], { cwd: workdir });
    return true;
  } catch {
    return false;
  }
}

/** The state directory must not dirty the target repository. */
async function checkHomeLocation(config: Config, workdir: string): Promise<string | undefined> {
  const rel = relative(workdir, home);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  const git = await snapshot(workdir);
  if (!git.isRepo || await isIgnored(workdir, home)) return undefined;
  return `State directory ${home} is inside the target repository and not git-ignored`
    + (config.runtime.verifyGitCleanOnCompletion ? '; git-clean verification would always fail.' : '.');
}

async function doctor(): Promise<number> {
  let failures = 0;
  const ok = (m: string) => console.log(`ok    ${m}`);
  const bad = (m: string) => { failures += 1; console.log(`FAIL  ${m}`); };
  const warn = (m: string) => console.log(`warn  ${m}`);
  let config: Config;
  try {
    config = await loadConfig(configPath);
    ok(`config ${configPath}: ${config.sessions.length} session(s), ${config.missions.length} mission(s)`);
  } catch (error) {
    bad(errorMessage(error));
    return 1;
  }
  const workdir = resolveWorkingDirectory(config, configPath);
  const git = await snapshot(workdir);
  if (git.isRepo) ok(`repository ${workdir}: ${git.branch}@${git.head?.slice(0, 10)} ${git.dirty ? `dirty (${git.changedFiles})` : 'clean'}${git.upstream ? ` ahead ${git.ahead} behind ${git.behind}` : ''}`);
  else warn(`${workdir} is not a git repository (git evidence unavailable)`);
  if (git.operationInProgress) bad(`git ${git.operationInProgress} in progress`);
  const homeIssue = await checkHomeLocation(config, workdir);
  if (homeIssue) bad(homeIssue);
  try {
    const version = await new ClaudeSupervisorAdapter(config.supervisor, workdir).validateCli();
    ok(`Claude CLI ${version}: required options present`);
  } catch (error) {
    bad(errorMessage(error));
  }
  const codexVersion = async (bin: string) => (await exec(bin, ['--version'])).stdout.trim();
  const sdkBinary = config.worker.codexPath ?? bundledCodexPath();
  try {
    const used = await codexVersion(sdkBinary);
    ok(`Codex used by the SDK: ${sdkBinary} (${used})${config.worker.sandboxMode ? `, sandbox ${config.worker.sandboxMode}` : ', sandbox inherited from your Codex config'}`);
    const system = await codexVersion('codex').catch(() => undefined);
    if (!config.worker.codexPath && system && system !== used) {
      warn(`your PATH codex is ${system} but the SDK runs its bundled ${used}; set worker.codexPath to use yours (config compatibility, thread resume)`);
    }
  } catch (error) {
    bad(`Codex CLI not runnable (${sdkBinary}): ${errorMessage(error)}`);
  }
  try {
    await buildVerifiers(config, configDirectoryOf(configPath));
    ok(`verification: ${config.verification.commands.length} command(s), ${config.verification.plugins.length} plugin(s)`);
    for (const { missionId, checks } of readOnlyCompletionChecks(config)) {
      warn(`mission ${missionId} is read-only but requires completion check(s) ${checks.join(', ')}: the worker cannot change the repository to make them pass; a failure blocks the mission`);
    }
  } catch (error) {
    bad(`verification plugins: ${errorMessage(error)}`);
  }
  const state = await store.load().catch(() => undefined);
  for (const [index, session] of config.sessions.entries()) {
    const recorded = state?.sessions?.[session.id]?.workerThreadId;
    const thread = recorded ? `Codex thread ${recorded}` : session.resumeThread ? `RESUMES existing Codex thread ${session.resumeThread}` : 'new Codex thread';
    ok(`session ${index + 1}/${config.sessions.length} ${session.id} (${session.file ?? 'inline'}): ${session.missions.length} mission(s) [${session.missions.map((m) => m.id).join(', ')}], ${thread}${session.handoff === 'previous' ? ', handoff from previous session' : ''}`);
  }
  if (process.env.CODEX_THREAD_ID) ok('CODEX_THREAD_ID is set in this environment; ColdPrompt ignores it (use resumeThread in a session file)');
  const lock = await store.readLock();
  if (lock) warn(`state directory owned by pid ${lock.pid} on ${lock.hostname} since ${lock.acquiredAt}`);
  return failures ? 1 : 0;
}

async function run(dryRun: boolean): Promise<number> {
  const config = await loadConfig(configPath);
  const workdir = resolveWorkingDirectory(config, configPath);
  let orchestratorStore = store;
  let scratch: string | undefined;
  let orchestrator: Orchestrator;

  if (dryRun) {
    // Dry-run: no provider calls, no verification commands, state in a scratch directory.
    // The target repository is only read (git with GIT_OPTIONAL_LOCKS=0).
    scratch = await mkdtemp(join(tmpdir(), 'coldprompt-dry-run-'));
    orchestratorStore = new Store(scratch);
    const worker = new FakeWorkerAdapter([], (input) => {
      log(`[dry-run] worker prompt:\n${input}\n`);
      return { finalResponse: '(dry-run: no worker executed)' };
    });
    const supervisor = new FakeSupervisorAdapter([], [], { decision: 'MISSION_COMPLETE', reason: 'dry-run', workerInstruction: '' });
    orchestrator = new Orchestrator({
      config: { ...config, runtime: { ...config.runtime, verifyGitCleanOnCompletion: false, requireHumanApprovalForMissionTransition: false } },
      store: orchestratorStore, worker, supervisor, workingDirectory: workdir, verifiers: [], log,
      autoApproveTransitions: true
    });
  } else {
    const homeIssue = await checkHomeLocation(config, workdir);
    if (homeIssue) throw new ColdPromptError('INVALID_CONFIG', `${homeIssue} Add it to .gitignore or set COLDPROMPT_HOME.`);
    const supervisor = new ClaudeSupervisorAdapter(config.supervisor, workdir, undefined, config.runtime.maxWorkerOutputChars);
    log(`Claude CLI ${await supervisor.validateCli()}`);
    const worker = new CodexWorkerAdapter(config.worker);
    const verifiers = await buildVerifiers(config, configDirectoryOf(configPath));
    orchestrator = new Orchestrator({
      config, store, worker, supervisor, workingDirectory: workdir, verifiers, log
    });
  }

  await orchestrator.open();
  const server = new ConsoleServer(orchestrator, orchestratorStore.socketPath);
  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals === 1) {
      log(`${signal}: stopping after the current turn (send again to abort the active turn; its outcome will be ambiguous).`);
      orchestrator.requestStop(signal);
    } else {
      log(`${signal}: aborting the active turn.`);
      void orchestrator.abortActiveTurn();
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await server.start();
    log(`project ${config.project.name}: ${config.missions.length} mission(s); console: COLDPROMPT_HOME=${orchestratorStore.directory} coldprompt console${dryRun ? ' [DRY RUN]' : ''}`);
    const final = await orchestrator.run();
    log(`finished with status ${final.status}`);
    return final.status === 'COMPLETED' ? 0 : final.status === 'FAILED' ? 1 : 3;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await server.stop();
    await orchestrator.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const DEFAULT_WEB_PORT = 8787;
const DEFAULT_RUN_UNIT = 'coldprompt-run.service';

async function web(): Promise<number> {
  const host = option('--host') ?? process.env.COLDPROMPT_WEB_HOST ?? '127.0.0.1';
  const port = Number(option('--port') ?? process.env.COLDPROMPT_WEB_PORT ?? DEFAULT_WEB_PORT);
  const runUnit = option('--run-unit');
  const projectName = await loadConfig(configPath).then((c) => c.project.name, () => 'coldprompt');
  const token = await loadOrCreateToken(store);
  const server = new WebServer({
    store, socketPath: store.socketPath, host, port, token, projectName, log,
    startRun: runUnit ? async () => {
      try {
        await exec('systemctl', ['--user', 'start', runUnit]);
        return { ok: true, message: `Started ${runUnit}` };
      } catch (error) {
        return { ok: false, message: `systemctl --user start ${runUnit} failed: ${redact(errorMessage(error))}` };
      }
    } : undefined
  });
  await server.start();
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (host === '0.0.0.0' || host === '::') log('warning: listening on ALL interfaces; prefer 127.0.0.1 behind "tailscale serve", or your tailnet IP');
  const shown = host.includes(':') ? `[${host}]` : host;
  log(`web console on http://${shown}:${port}/ (token: ${join(home, 'web-token')})${loopback ? '; phone access: tailscale serve --bg ' + port : ''}`);
  // The token is printed only to an interactive terminal, never to a service journal.
  if (process.stdout.isTTY) console.log(`Open: http://${loopback ? 'localhost' : shown}:${port}/#token=${token}`);
  await new Promise<void>((resolveStop) => {
    process.once('SIGINT', resolveStop);
    process.once('SIGTERM', resolveStop);
  });
  await server.stop();
  return 0;
}

async function systemdUnits(): Promise<number> {
  const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'coldprompt');
  const pathDirectories = [dirname(process.execPath)];
  for (const name of ['claude', 'codex', 'git', 'kicad-cli']) {
    const dir = await findOnPath(name);
    if (dir) pathDirectories.push(dir);
  }
  const units = renderUnits({
    launcher, configPath, pathDirectories,
    webHost: option('--host') ?? '127.0.0.1',
    webPort: Number(option('--port') ?? DEFAULT_WEB_PORT),
    runUnit: DEFAULT_RUN_UNIT
  });
  if (!args.includes('--write')) {
    for (const [name, text] of Object.entries(units)) console.log(`# ~/.config/systemd/user/${name}\n${text}`);
    console.log('# Write them with: coldprompt systemd --write');
    return 0;
  }
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(units)) {
    await writeFile(join(dir, name), text, { mode: 0o644 });
    console.log(`wrote ${join(dir, name)}`);
  }
  console.log([
    '',
    'Next:',
    '  systemctl --user daemon-reload',
    '  systemctl --user enable --now coldprompt-web.service   # web console, always on',
    `  systemctl --user start ${DEFAULT_RUN_UNIT}            # or the "Start run" button`,
    '  loginctl enable-linger "$USER"                      # keep services running after logout',
    `  tailscale serve --bg ${DEFAULT_WEB_PORT}                          # https://<host>.<tailnet>.ts.net/ from the phone`
  ].join('\n'));
  return 0;
}

async function main(): Promise<number> {
  switch (command) {
    case 'run':
      return run(args.includes('--dry-run') || process.env.DRY_RUN === '1');
    case 'console':
      await runInteractiveConsole(store.socketPath);
      return 0;
    case 'send': {
      const request = parseCommandLine(args.slice(1).join(' '));
      if (!request) { console.error('Usage: coldprompt send <command> [text]'); return 1; }
      const { response, text } = await sendOnce(store.socketPath, request);
      console.log(text);
      return response.ok ? 0 : 1;
    }
    case 'status': {
      try {
        const { text } = await sendOnce(store.socketPath, { command: 'status' }, 0);
        console.log(text);
      } catch {
        const state = await store.load();
        console.log('(orchestrator not running; persisted state)');
        console.log(formatStatus({
          status: state.status, mission: null, missionTurns: state.missionTurns, totalTurns: state.totalTurns,
          workerThreadId: state.activeMissionId ? state.sessions[state.missions[state.activeMissionId]?.session ?? '']?.workerThreadId : undefined,
          supervisorSessionId: state.supervisorSessionId,
          pendingTurn: state.pendingTurn, blocked: state.blocked, lastDecision: state.lastDecision, lastReason: state.lastReview?.reason,
          queuedHotPrompts: state.hotPrompts.filter((h) => h.status === 'QUEUED' || h.status === 'PROCESSING').length,
          lastError: state.lastError, git: state.lastGit
        }));
        console.log(`mission index: ${state.missionIndex}, active mission: ${state.activeMissionId ?? '(none)'}`);
      }
      return 0;
    }
    case 'doctor':
      return doctor();
    case 'web':
      return web();
    case 'systemd':
      return systemdUnits();
    case 'events': {
      const n = Number(args[1] ?? 20);
      for (const e of (await store.readEvents()).slice(-n)) console.log(`${e.timestamp} ${e.type} ${JSON.stringify(e.data)}`);
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    const kind = error instanceof ColdPromptError ? error.kind : 'ERROR';
    process.stderr.write(`coldprompt: ${kind}: ${redact(errorMessage(error))}\n`);
    process.exitCode = kind === 'INVALID_CONFIG' ? 78 : 1;
  }
);
