# ColdPrompt

**Cold plans. Hot decisions.**

ColdPrompt is a self-hosted, human-in-the-loop orchestrator for
persistent coding agents.

## Concepts

- `COLD_PROMPT`: a mission prepared before execution.
- Session: a YAML file of missions that run one after another on **one
  Codex thread** (same worker context). `coldprompt.yaml` (the plan) holds the
  shared settings and lists the session files, run in order. Each session
  starts a new thread unless it sets `resumeThread:`; moving to the next
  session always waits for `approve mission`. One Claude conversation
  supervises the whole plan.
- `HOT_PROMPT`: a question, directive or resolution injected at runtime.
- Claude supervises Codex and evaluates mission progress.
- `BLOCKED` suspends the worker and requires human intervention.
- Worker sessions must be resumed, not silently replaced.

## Status

v0.4 alpha. The runtime loop, persistence, recovery, Codex and Claude
adapters and the Unix-socket console are implemented and covered by
tests with fake adapters, plus opt-in real-provider integration tests.

It has **not** yet been used for a long unattended mission. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (decisions and open risks)
before doing so.

## Quickstart

From a clone, with Node.js 22+, `codex` and `claude` installed and logged in:

    npm install
    ln -s $PWD/bin/coldprompt ~/.local/bin/coldprompt   # put "coldprompt" on your PATH
    cd /path/to/dir/with/coldprompt.yaml               # your plan (see "Plan and session files")
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
the phone) and press **Start run**, or run `systemctl --user start coldprompt-run`.
Nothing runs against your repository until you do.

## Development

Requires Node.js 22+.

    npm install
    npm run typecheck
    npm test                      # fake adapters, no provider calls
    npm run test:integration      # real Claude + Codex, throwaway dirs
                                  # (COLDPROMPT_CODEX_PATH=$(command -v codex) to use your codex)
    npm run doctor                # validate config, CLIs and repository

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
    # resumeThread: <thread id>    # optional: continue an existing Codex thread
    missions:
      - id: audit
        title: Audit the batch
        prompt: { type: COLD_PROMPT, content: "…" }
        completionCriteria: ["…"]
        execution: { readOnly: true, maxTurns: 5 }

See `coldprompt.yaml` and `examples/` for a complete example. `coldprompt doctor`
lists the sessions, their missions and which thread each will use.

### Console commands

    status                 runtime status
    ask <question>         HOT_PROMPT QUESTION: Claude answers, the worker is untouched
    tell <directive>       HOT_PROMPT DIRECTIVE: Claude prepares an instruction (needs approve)
    tell --raw <text>      your own directive, delivered verbatim at the next turn boundary
    approve <id>           approve a proposed directive
    approve mission        approve a pending mission transition (or accept a
                           read-only mission whose completion checks failed)
    reject <id>            reject a directive
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

`coldprompt web` serves a page (default `127.0.0.1:8787`) that shows status,
blocks, directives, live Codex activity (commands, outputs, file changes,
messages) and Claude's decisions, and sends HOT_PROMPTs (`ask`, `tell`,
`tell --raw`, `approve`, `resume`, `pause`, `stop`). It is a client of
the console socket, like `coldprompt console`.

- Auth: a random token in `<COLDPROMPT_HOME>/web-token` (0600). Open the
  URL printed at start-up (`...#token=...`, only shown on a terminal) or
  paste the token in the page. It is sent as a Bearer header, never a
  cookie; the token stays in the browser's local storage until
  "Forget token".
- Phone over Tailscale: keep the default localhost bind and run
  `tailscale serve --bg 8787`, then open `https://<host>.<tailnet>.ts.net`.
  Do not bind to `0.0.0.0`.

### systemd (instead of tmux)

    coldprompt systemd --write        # writes ~/.config/systemd/user/coldprompt-{run,web}.service
    systemctl --user daemon-reload
    systemctl --user enable --now coldprompt-web     # always on
    systemctl --user start coldprompt-run            # or "Start run" in the web page
    journalctl --user -u coldprompt-run -f
    loginctl enable-linger $USER                  # optional: keep running after logout

The run unit is never started at login and never restarted
automatically. `systemctl --user stop coldprompt-run` is graceful (it waits
for the current worker turn). Run `coldprompt systemd --write` again after
moving coldprompt.yaml or changing your node/codex installation (PATH).

Read AGENTS.md before changing the runtime.
