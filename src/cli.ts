import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig, resolveConfigPath, resolveWorkingDirectory } from './config.js';
import { Store } from './store.js';
import { archiveCheck, archivePlan, hasRun, notFinishedReason, planChanges, runCommits } from './archive.js';
import { Orchestrator, HELP_TEXT } from './orchestrator.js';
import { snapshot } from './git.js';
import { buildVerifiers, configDirectoryOf, readOnlyCompletionChecks } from './verification.js';
import { ColdPromptError, errorMessage, redact } from './errors.js';
import { checkProviders, createSupervisor, createWorker, type ProviderContext } from './adapters/registry.js';
import { FakeSupervisorAdapter, FakeWorkerAdapter } from './adapters/fake.js';
import { ConsoleServer } from './console/server.js';
import { formatPersistedState, runInteractiveConsole, sendOnce } from './console/client.js';
import { runMcpServer } from './mcp/server.js';
import { buildFinalizePrompt } from './supervisor.js';
import { parseCommandLine } from './console/protocol.js';
import type { Config } from './types.js';
import { WebServer, loadOrCreateToken } from './web/server.js';
import { findOnPath, renderUnits, startUnit } from './web/systemd.js';

const exec = promisify(execFile);

const USAGE = `Usage: coldprompt <command>

  run [--dry-run]     Run the mission queue (owner process; starts the console socket)
  console             Interactive console (connects to the running orchestrator)
  send <command...>   Send one console command, e.g. send ask "why blocked?"
  status              Live status if running, otherwise the persisted state
  doctor              Validate config, worker and supervisor CLIs, repository
  events [n]          Print the last n events (default 20)
  mcp                 MCP server on stdio for a Claude Code session: the console
                      commands as tools (status, events, turn, ask_supervisor,
                      resume, tell, approve, extend, ...) on the running plan
  web [--host H] [--port P] [--run-unit U]
                      Web console (status, live worker activity, HOT_PROMPTs);
                      default 127.0.0.1:8787, token in <COLDPROMPT_HOME>/web-token
  systemd [--write]   Print (or write to ~/.config/systemd/user) units for run and web
  archive [--force]   Move the finished run (state, events, turns, outputs, plan
                      snapshot) to <COLDPROMPT_HOME>/archive/ so the next plan starts
                      fresh; --force also archives an unfinished run
  reset               Archive the stopped run (reason "reset"), finished or not, so the
                      plan starts again from its first mission; the repository and the
                      commits the run made are not touched

Environment: COLDPROMPT_CONFIG (coldprompt.yaml), COLDPROMPT_HOME (.coldprompt next to the config).
A session file (listed under "sessions:" in coldprompt.yaml) is one worker thread
(Codex thread or Claude conversation); set "resumeThread:" in it to continue one.

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
  // Trailing slash: a ".coldprompt/" pattern only matches directories, and the
  // state directory may not exist yet.
  if (!git.isRepo || await isIgnored(workdir, `${home}/`)) return undefined;
  return `State directory ${home} is inside the target repository and not git-ignored`
    + (config.runtime.verifyGitCleanOnCompletion ? '; git-clean verification would always fail.' : '.');
}

function providerContext(config: Config, workdir: string): ProviderContext {
  return { workingDirectory: workdir, maxWorkerOutputChars: config.runtime.maxWorkerOutputChars, configPath };
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
  const model = (m: string | null | undefined) => (m ? `model ${m}` : 'default model');
  ok(`worker: ${config.worker.provider} (${model(config.worker.model)}), supervisor: ${config.supervisor.provider} (${model(config.supervisor.model)}); models are checked when a run starts`);
  for (const check of await checkProviders(config, providerContext(config, workdir))) {
    (check.level === 'ok' ? ok : check.level === 'warn' ? warn : bad)(check.message);
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
    const thread = recorded ? `worker thread ${recorded}` : session.resumeThread ? `RESUMES existing worker thread ${session.resumeThread}` : 'new worker thread';
    ok(`session ${index + 1}/${config.sessions.length} ${session.id} (${session.file ?? 'inline'}): ${session.missions.length} mission(s) [${session.missions.map((m) => m.id).join(', ')}], ${thread}${session.handoff === 'previous' ? ', handoff from previous session' : ''}`);
  }
  if (config.finalize) {
    const supervisor = createSupervisor(config.supervisor, providerContext(config, workdir));
    if (!supervisor.finalize) bad(`finalize: the ${config.supervisor.provider} supervisor does not support it`);
    else {
      const extra = config.supervisor.provider === 'claude' && config.supervisor.finalize;
      ok(`finalize: supervisor call after the last mission, inputs [${config.finalize.inputs.join(', ')}]${extra ? `; extra tools [${extra.tools.join(', ')}], ${extra.allowedTools.length} allowed rule(s), dirs [${extra.addDirs.join(', ')}]` : '; no extra supervisor permissions'}`);
    }
  }
  if (config.proposals) ok(`proposals: ${resolveConfigPath(configPath, config.proposals.directory)} -> accepted into ${resolveConfigPath(configPath, config.proposals.acceptInto)}`);
  for (const mission of config.missions.filter((m) => m.execution.output)) ok(`mission ${mission.id} delivers output "${mission.execution.output}" (${store.outputPath(mission.id)})`);
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
    supervisor.finalize = async (request) => {
      log(`[dry-run] supervisor finalize prompt:\n${buildFinalizePrompt(request, config.runtime.maxWorkerOutputChars)}\n`);
      return { ok: true, summary: 'dry-run: finalize not executed', files: [] };
    };
    orchestrator = new Orchestrator({
      config: { ...config, runtime: { ...config.runtime, verifyGitCleanOnCompletion: false, autoApproveMissions: true } },
      store: orchestratorStore, worker, supervisor, workingDirectory: workdir, verifiers: [], log, configPath,
      autoApproveTransitions: true
    });
  } else {
    const homeIssue = await checkHomeLocation(config, workdir);
    if (homeIssue) throw new ColdPromptError('INVALID_CONFIG', `${homeIssue} Add it to .gitignore or set COLDPROMPT_HOME.`);
    const context = providerContext(config, workdir);
    const checks = await checkProviders(config, context);
    for (const check of checks) log(`${check.level === 'ok' ? '' : `${check.level}: `}${check.message}`);
    const failed = checks.filter((c) => c.level === 'fail');
    if (failed.length) throw new ColdPromptError('INVALID_CONFIG', failed.map((c) => c.message).join('; '));
    const supervisor = createSupervisor(config.supervisor, context);
    if (config.finalize && !supervisor.finalize) throw new ColdPromptError('INVALID_CONFIG', `finalize is configured, but the ${config.supervisor.provider} supervisor does not support it`);
    const worker = createWorker(config.worker, context);
    const verifiers = await buildVerifiers(config, configDirectoryOf(configPath));
    orchestrator = new Orchestrator({
      config, store, worker, supervisor, workingDirectory: workdir, verifiers, log, configPath
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

/** "<short id> <subject>" for each commit, as far as the repository still knows them. */
async function describeCommits(config: Config | undefined, commits: string[]): Promise<string[]> {
  if (!config) return commits;
  const cwd = resolveWorkingDirectory(config, configPath);
  return Promise.all(commits.map(async (c) => {
    try { return (await exec('git', ['log', '-1', '--format=%h %s', c], { cwd })).stdout.trim() || c; } catch { return c; }
  }));
}

async function web(): Promise<number> {
  const host = option('--host') ?? process.env.COLDPROMPT_WEB_HOST ?? '127.0.0.1';
  const port = Number(option('--port') ?? process.env.COLDPROMPT_WEB_PORT ?? DEFAULT_WEB_PORT);
  const runUnit = option('--run-unit');
  const initial = await loadConfig(configPath).catch(() => undefined);
  const projectName = initial?.project.name ?? 'coldprompt';
  const proposals = initial?.proposals ? {
    directory: resolveConfigPath(configPath, initial.proposals.directory),
    acceptInto: resolveConfigPath(configPath, initial.proposals.acceptInto),
    planIds: async () => {
      const c = await loadConfig(configPath);
      return { sessions: c.sessions.map((s) => s.id), missions: c.missions.map((m) => m.id) };
    }
  } : undefined;
  const token = await loadOrCreateToken(store);
  const server = new WebServer({
    store, socketPath: store.socketPath, host, port, token, projectName, log, proposals,
    startRun: runUnit ? () => startUnit(runUnit, { exec: (file, args) => exec(file, args), redact }) : undefined,
    restartRun: runUnit ? () => startUnit(runUnit, { exec: (file, args) => exec(file, args), redact, verb: 'restart' }) : undefined,
    planChanges: async () => planChanges(store, configPath, await loadConfig(configPath).catch(() => undefined)),
    reset: {
      check: async () => {
        if (!(await hasRun(store))) return { resettable: false, reason: 'there is no run to reset', commits: [] };
        const config = await loadConfig(configPath).catch(() => undefined);
        // A finished plan is archived instead (Archive plan).
        if (!notFinishedReason(await store.load(), Boolean(config?.finalize))) return { resettable: false, reason: 'the plan is finished: archive it', commits: [] };
        return { resettable: true, commits: await describeCommits(config, await runCommits(store)) };
      },
      run: async () => archivePlan(store, { configPath, config: await loadConfig(configPath).catch(() => undefined), reset: true })
    },
    archive: {
      check: async () => archiveCheck(store, await loadConfig(configPath).catch(() => undefined)),
      run: async () => archivePlan(store, { configPath, config: await loadConfig(configPath).catch(() => undefined) })
    }
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
        console.log(formatPersistedState(await store.load()));
      }
      return 0;
    }
    case 'doctor':
      return doctor();
    case 'web':
      return web();
    case 'systemd':
      return systemdUnits();
    case 'archive': {
      const config = await loadConfig(configPath).catch(() => undefined);
      const result = await archivePlan(store, { configPath, config, force: args.includes('--force') });
      if (!result.ok) { console.error(result.error); return 1; }
      console.log(`archived to ${result.directory}`);
      return 0;
    }
    case 'reset': {
      const config = await loadConfig(configPath).catch(() => undefined);
      const commits = (await hasRun(store)) ? await describeCommits(config, await runCommits(store)) : [];
      const result = await archivePlan(store, { configPath, config, reset: true });
      if (!result.ok) { console.error(result.error); return 1; }
      console.log(`run reset: archived to ${result.directory}`);
      if (commits.length) console.log(`commits made by this run (left as they are):\n${commits.map((c) => `  ${c}`).join('\n')}`);
      console.log('the next "coldprompt run" (or Start run) starts the plan from its first mission');
      return 0;
    }
    case 'mcp':
      // stdout carries the MCP protocol only.
      await runMcpServer(store);
      return 0;
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
