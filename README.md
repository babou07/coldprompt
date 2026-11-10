# ColdPrompt

**Cold plans. Hot decisions.**

ColdPrompt is a self-hosted, human-in-the-loop orchestrator for
persistent coding agents.

## Concepts

- `COLD_PROMPT`: a mission prepared before execution.
- Session: a YAML file of missions that run one after another on **one
  worker thread** (same worker context: a Codex thread or a Claude
  conversation). `coldprompt.yaml` (the plan) holds the
  shared settings and lists the session files, run in order. Each session
  starts a new thread unless it sets `resumeThread:`. By default every
  mission end, and so every move to the next session, waits for
  `approve mission` (see [Approvals](#approvals)). One supervisor
  conversation spans the whole plan.
- `HOT_PROMPT`: a question, directive or resolution injected at runtime.
- A supervisor agent reviews every worker turn and decides whether the
  mission continues, needs evidence, is blocked or is complete. Worker and
  supervisor are each **Codex or Claude Code**, in any combination (see
  [Providers](#providers)).
- `BLOCKED` suspends the worker and requires human intervention.
- Worker sessions must be resumed, not silently replaced.

## Status

v0.4 alpha. The runtime loop, persistence, recovery, the Codex and Claude
adapters (both roles each) and the Unix-socket console are implemented and covered by
tests with fake adapters, plus opt-in real-provider integration tests.

It has **not** yet been used for a long unattended mission. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (decisions and open risks)
before doing so.

## Quickstart

From a clone, with Node.js 22+ and the CLIs of your chosen providers
(`codex`, `claude`) installed and logged in:

    npm install
    ln -s $PWD/bin/coldprompt ~/.local/bin/coldprompt   # put "coldprompt" on your PATH
    cp coldprompt.example.yaml /path/to/work/coldprompt.yaml   # your plan: edit it (see "Plan and session files")
    cd /path/to/work
    coldprompt doctor                                  # validate config, CLIs and repository
    coldprompt run --dry-run                           # print the prompts; no provider call

    # Web console as a systemd user service (always on)
    coldprompt systemd --write
    systemctl --user daemon-reload
    systemctl --user enable --now coldprompt-web
    cat .coldprompt/web-token                          # paste it in the page once

    # Optional: reach it from your phone over Tailscale
    tailscale serve --bg 8787       # if refused: sudo tailscale set --operator=$USER

Then open `http://127.0.0.1:8787` (or `https://<host>.<tailnet>.ts.net` on
the phone) and press **Start run** in the Main tab of the web page, or run `systemctl --user start coldprompt-run`.
Nothing runs against your repository until you do.

## Development

Requires Node.js 22+.

    npm install
    npm run typecheck
    npm test                      # fake adapters, no provider calls
    npm run test:integration      # real Claude + Codex in both roles, throwaway dirs
                                  # (COLDPROMPT_CODEX_PATH=$(command -v codex) to use your codex)
    npm run doctor                # doctor on coldprompt.example.yaml

## Usage

    coldprompt doctor                 # always first
    coldprompt run --dry-run          # prints the prompts; no provider call, repo untouched
    coldprompt run                    # owner process (or the systemd unit below)
    coldprompt console                # from any shell, including ssh from Termux
    coldprompt web                    # web console (phone, browser)
    coldprompt systemd [--write]      # user units for run + web
    coldprompt send ask "why are you blocked?"
    coldprompt status
    coldprompt events 50

(`bin/coldprompt` runs `src/cli.ts` with tsx; link it onto your PATH, e.g.
`ln -s $PWD/bin/coldprompt ~/.local/bin/coldprompt`.)

Environment: `COLDPROMPT_CONFIG` (default `coldprompt.yaml`), `COLDPROMPT_HOME`
(default `.coldprompt` next to the config; keep it git-ignored).
`CODEX_THREAD_ID` is ignored: to continue an existing thread, set
`resumeThread:` in the session file.

### Plan and session files

    # coldprompt.yaml
    version: 1
    project: …
    worker: …
    supervisor: …
    runtime: …
    verification: …
    sessions:                       # relative to coldprompt.yaml, run in order
      - sessions/s01-pilot.yaml
      - sessions/s02-audit.yaml

    # sessions/s02-audit.yaml
    id: s02-audit
    title: Independent audit       # optional
    handoff: previous              # optional: first prompt gets the previous session's worker reports
    # resumeThread: <thread id>    # optional: continue an existing worker thread
    missions:
      - id: audit
        title: Audit the batch
        prompt: { type: COLD_PROMPT, content: "…" }
        completionCriteria: ["…"]
        execution: { readOnly: true, maxTurns: 5 }

See `coldprompt.example.yaml` and `examples/` for a complete example. `coldprompt doctor`
lists the sessions, their missions and which thread each will use.

### Chaining plans: outputs, finalize, proposals

    # coldprompt.yaml
    sessions:
      - sessions/s01-pilot.yaml
      - sessions/accepted/*.yaml    # "*" in the file name only; sorted by name
    finalize:                       # one supervisor call once every mission is complete
      prompt: "Write the next session files into sessions/proposed/, then summarize."
      inputs: [audit]               # missions whose output (or last report) is given to it
    proposals:
      directory: sessions/proposed
      acceptInto: sessions/accepted # must be covered by a "dir/*.yaml" sessions entry
    supervisor:
      provider: claude
      finalize:                     # extra permissions for the finalize call only
        tools: [Write]
        allowedTools: ["Edit(//home/me/workspace/sessions/proposed/**)"]  # Edit rules also cover Write
        addDirs: [sessions]         # relative to coldprompt.yaml, or ~/
        timeoutSeconds: 1800

- **Structured output.** A mission with `execution: { output: findings }` must end its
  final answer with one ` ```coldprompt-output findings ` block of strict JSON. It is stored
  in `outputs/<mission>.json` (state directory); the mission cannot complete without a
  valid block. It is data for a later step, not a decision: the supervisor still reviews.
- **Finalize.** Runs once per completed plan (again only if missions were appended
  later). Its answer is `{ ok, summary, files }`, shown in the console. A failure
  (an error, or `ok: false` when the supervisor reports that something failed or
  was refused) is recorded and retried at the next run. File permission rules are
  `Edit(...)` rules, which also cover the Write tool; `Write(...)` rules match nothing. Only the Claude supervisor supports it;
  reviews stay read-only.
- **Proposals.** The web console lists the session files in `proposals.directory`;
  *Accept* moves one into `acceptInto` (refused on a session or mission id clash),
  *Dismiss* moves it to `dismissed/`. Accepted sessions run at the next *Start run*.

### Starting a new plan: archives

A run's state (`state.json`, `events.jsonl`, `turns/`, `outputs/`) belongs to
one plan. To start another plan, edit `coldprompt.yaml` and the session files,
then:

- **Just press Start run.** If the previous plan is finished (COMPLETED,
  finalize done when it has one) and the new configuration keeps none of its
  missions, the run archives it and starts the new plan from its first mission
  (event `plan.archived`).
- Otherwise the run refuses to start: an unfinished plan, or a list that still
  contains missions of the previous run (reordered, partly kept), would
  silently resume at the wrong mission. Restore the list, or archive first.
- **Archive plan** in the web page's Main tab (shown while the run is stopped and the
  plan is finished), or `coldprompt archive`, archives the plan without
  starting anything. `coldprompt archive --force` also archives an unfinished
  run.
- **Reset run** in the web page's Main tab (shown while the run is stopped and the plan
  is not finished), or `coldprompt reset`, archives the run with the reason
  `reset` and lets the plan start again from its first mission, e.g. after a
  block that was fixed outside ColdPrompt. The page can start the run right
  after. The repository is never touched: commits the run made are listed
  before the confirmation and left as they are.

An archive is `<COLDPROMPT_HOME>/archive/<date>-<first>--<last session>/`:
the run files, a copy of `coldprompt.yaml` and of the session files as they
ran (`plan/`, snapshotted at each run start), and `archive.json` (when, why,
status, missions, finalize result). The web token stays. Appending missions to
a finished plan still continues it, without archiving.

### Providers

`worker:` and `supervisor:` each pick a `provider:`. Codex and Claude Code
are supported in both roles, in any combination (the same provider in both
roles uses two separate conversations). Options depend on the provider;
unknown keys are rejected.

    # Default: Codex works, Claude supervises
    worker:     { provider: codex }
    supervisor: { provider: claude }

    # Swapped: Claude Code works, Codex supervises
    worker:
      provider: claude
      permissionMode: acceptEdits            # unattended: allow edits...
      allowedTools: ["Bash(npm test:*)"]     # ...and the commands you trust
    supervisor:
      provider: codex
      codexPath: /home/you/.local/bin/codex

| Role / provider | How it runs | Main options |
|---|---|---|
| worker `codex` | `@openai/codex-sdk` thread | `model`, `sandboxMode`, `approvalPolicy`, `reasoningEffort`, `codexPath` (permissions inherited from your Codex config when unset) |
| worker `claude` | `claude --print --output-format stream-json`, one conversation per session | `model`, `permissionMode`, `tools`, `allowedTools`, `readOnlyTools`, `turnTimeoutSeconds` (permissions inherited from your Claude Code settings when unset) |
| supervisor `claude` | `claude --print --json-schema` | `model`, `tools` (default Read, Grep, Glob), `permissionMode`, `timeoutSeconds` |
| supervisor `codex` | Codex thread, read-only sandbox, `outputSchema` | `model`, `reasoningEffort`, `codexPath`, `timeoutSeconds` |

**Models.** Both roles take `model:`; leave it `null` (or out) for the
provider's default, or force one:

    worker:     { provider: codex,  model: <a model id of your codex CLI> }
    supervisor: { provider: claude, model: opus }   # alias or full id

Each run checks both models before the first worker turn, with one tiny
call per role (no tools, nothing saved for Claude; read-only and ephemeral
for Codex). If a model does not exist, is not available to your account or
needs a newer CLI, the run stops at once in `BLOCKED (PROVIDER_CHECK)` with
the provider's message, before any work on the repository. Fix the
configuration and restart the run (`resume` only retries the check).
Capacity errors (rate limits, overload) do not block. The log and the
event `providers.checked` show the model that answered.

Read-only missions: Codex runs in its `read-only` sandbox (commands allowed,
writes refused). Claude only gets `readOnlyTools` (Read, Grep, Glob by
default), so no shell; adding `Bash` there is at your own risk.

A thread id belongs to the provider that created it: changing the worker
or supervisor provider while a session (or the supervisor conversation) is
in progress is refused; finish the session or start a fresh state. The next
session may use another worker provider.

`coldprompt doctor` checks the CLIs of the configured providers. New
providers plug in through `src/adapters/registry.ts` (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

### Approvals

    runtime:
      autoApproveMissions: false    # default

- `false` (default): when the supervisor declares a mission complete and
  its checks pass, the run waits for `approve mission` (web console:
  **Approve session N, mission M**). This is also when the next session,
  and its new worker thread, would start.
- `true`: such missions move on by themselves, into the next session too.
  The event log records `mission.auto_approved`. Everything else still
  stops the run as usual: a supervisor `BLOCKED` or `STOP`, failed checks,
  limits, provider errors, an ambiguous turn after a crash.
- A mission can override it: `requireHumanApproval: true` always waits for
  a human, `false` never does.

### Console commands

    status                 runtime status
    ask <question>         HOT_PROMPT QUESTION: the supervisor answers, the worker is untouched
    tell <directive>       HOT_PROMPT DIRECTIVE: the supervisor prepares an instruction (needs approve)
    tell --raw <text>      your own directive, delivered verbatim at the next turn boundary
    approve <id>           approve a proposed directive
    approve mission        approve a pending mission transition (or accept a
                           read-only mission whose completion checks failed)
    reject <id>            reject a directive
    extend <n>             add n turns (1-100) to the current mission; leaves a
                           turn-limit block (MISSION_LIMIT) and resumes
    complete               end the current mission now if its completion checks
                           pass (run blocked, failed or paused, no turn waiting)
    skip                   end the current mission without completion checks;
                           it is marked skipped and the next mission starts
    directives             list directives
    pause                  pause at the next safe boundary
    resume <resolution>    RESOLUTION: required to leave BLOCKED/FAILED
    stop                   graceful stop after the current turn
    help

Ctrl-C on `coldprompt run` stops after the current turn; a second Ctrl-C
aborts the active turn (it is then recovered as *ambiguous* and needs a
resolution on restart).

### Remote use (Termux)

    ssh fedora-host
    systemctl --user start coldprompt-run   # if not already running (see systemd below)
    coldprompt console

The console is line-based (no raw terminal mode) and reconnects
automatically when the orchestrator restarts.

### Web console

`coldprompt web` serves a page (default `127.0.0.1:8787`) to follow and
steer the run from a browser or a phone. It is a client of the console
socket, like `coldprompt console`, and uses the same commands; with
`--run-unit` (as the systemd unit does) it can also start, restart, archive
and reset the run.

- **Auth**: a random token in `<COLDPROMPT_HOME>/web-token` (0600). Open the
  URL printed at start-up (`...#token=...`, only shown on a terminal) or
  paste the token in the page. It is sent as a Bearer header, never a
  cookie; the token stays in the browser's local storage until
  **Forget token**.
- **Names**: labels give the role, then the provider from the configuration
  (`supervisor.provider`, `worker.provider`), e.g. *supervisor (Claude)* and
  *worker (Codex)*, so a Claude supervisor and a Claude worker stay distinct.
- **Phone over Tailscale**: keep the default localhost bind and run
  `tailscale serve --bg 8787`, then open `https://<host>.<tailnet>.ts.net`.
  Do not bind to `0.0.0.0`.

#### Main tab

From top to bottom:

1. **Controls**: `Pause | Stop | Restart | Forget token` while the run is up
   (*Stop after this turn* while a turn is running).
   - **Restart** runs `systemctl --user restart <unit>`: the current turn
     finishes, then the run starts again with the YAML files reloaded and
     its progress kept. Use it after editing `coldprompt.yaml` or a session
     file: `resume` only retries with the configuration loaded at the start.
     The page warns when these files changed since the run started.
   - When the run is stopped: **Start run** (`systemctl --user start <unit>`,
     after a confirmation; one start at a time; if the run ends within
     seconds, the page shows the journal lines of that start, secrets
     masked), **Archive plan** when the plan is finished, **Reset run** when
     it is not (see "Starting a new plan").
2. **Plan recap**, folded: its line shows the session, mission, turn and git
   state; open it for every session and mission (skipped ones are marked).
   **Approve session N, mission M** appears when a mission waits for
   approval.
3. **Block card**, while the run is blocked: the reason, and the ways out
   that do not need the worker: **+3 / +10 turns** on a turn-limit block
   (`extend`), **Complete mission** (`complete`: its completion checks run
   first, it ends only if they pass) and **Skip mission** (`skip`). Not for a
   mission waiting for approval (use **Approve**) or a provider check (fix
   the configuration, then **Restart**).
4. **Message box** with two buttons:

   | Button | Goes to | Effect on the worker | Needs approval |
   |---|---|---|---|
   | **Ask supervisor (\<provider\>)** | the supervisor only | none; it may propose an instruction | yes, to deliver its proposal |
   | **Ask worker (\<provider\>)** | the worker | your exact text, at its next turn | no: sending it is the approval |
   | **Resume worker (\<provider\>)**, the same button while the run waits for you | the worker and the orchestrator | leaves `BLOCKED` / `FAILED` / `PAUSED`; your text is the resolution, sent with the next turn | no: it is your decision |

   - **Ask supervisor**: a question or a request, at any time, even during a
     turn. The worker is not interrupted and never sees it. If an
     instruction to the worker would help, the answer carries it with
     **Approve → worker** / **Reject**, plus **Approve and resume** while the
     run is blocked.
   - **Ask / Resume worker**: your own text, after a confirmation. A running
     turn is never cut. A `PROVIDER_CHECK` block only retries the check: fix
     the configuration and **Restart** instead.
   - Ctrl+Enter asks the supervisor.
   - Under the box, a folded line lists the directives **queued for the
     worker's next turn** (approved, not delivered yet), each with
     **Withdraw**, which cancels it before delivery. Proposals that no answer
     on the page carries (e.g. made from the terminal console) appear there
     too, with **Approve** / **Reject**.
5. **Your messages and their answers**, newest first, right under the box.
   While a message is on its way the page shows *Sending…*, then
   *Supervisor (\<provider\>) is thinking…* until the answer arrives; if
   sending fails, the text comes back in the box. Long answers fold
   (**show all**).

#### Logs tab

The live feed, newest first: worker turns (commands, outputs, file changes,
messages), each with the supervisor's decision and a **Full report**.
Finished turns are folded, their decision still visible; a click on the
header opens one. Only the running turn stays open. `#tab=logs` in the URL
opens this tab.

The console client keeps all the underlying commands, including `tell` (the
supervisor drafts a directive) and `tell --raw`, which the page's
**Ask worker** sends.

### systemd (instead of tmux)

    coldprompt systemd --write        # writes ~/.config/systemd/user/coldprompt-{run,web}.service
    systemctl --user daemon-reload
    systemctl --user enable --now coldprompt-web     # always on
    systemctl --user start coldprompt-run            # or "Start run" in the web page
    journalctl --user -u coldprompt-run -f
    loginctl enable-linger $USER                  # optional: keep running after logout

The run unit is never started at login and never restarted
automatically. Stopping while blocked or paused (exit 3) counts as a normal
end, not a failed unit. `systemctl --user stop coldprompt-run` is graceful (it waits
for the current worker turn). Run `coldprompt systemd --write` again after
moving coldprompt.yaml or changing your node/codex/claude installation (PATH).

Read AGENTS.md before changing the runtime.
