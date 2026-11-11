# ColdPrompt commands — dictionary

One line per action, with its three forms: the web console button, the
console command (`coldprompt console`, or `coldprompt send <command>` from a
script), and the `coldprompt` command line. "When" says when the action takes
effect: **now**, or **at the end of the current worker turn** (a worker turn
is never interrupted, however long it is).

Checked against the code on 2026-11-11 (`src/cli.ts`, `src/orchestrator.ts`,
`src/web/server.ts`, `src/web/page.ts`). Keep this file in step when a
command changes.

## Run lifecycle

| Action | Web button | Console | Command line | When | Keeps / changes |
|---|---|---|---|---|---|
| Start the run | **Start run** (needs `coldprompt web --run-unit`) | — | `coldprompt run`, or `systemctl --user start coldprompt-run` | now | reloads the YAML files; resumes from the saved state |
| Try the plan without running | — | — | `coldprompt run --dry-run` | now | changes nothing in the repository |
| Pause | **Pause** | `pause` | — | end of turn | progress kept; leave with `resume <resolution>` |
| Stop | **Stop after this turn** (just **Stop** when no turn runs) | `stop` | Ctrl-C on `coldprompt run` | end of turn | state kept; start again later |
| Abort a turn | — | — | a **second** Ctrl-C on `coldprompt run` (or killing its service) | now | the turn is recovered as *ambiguous* at restart and needs a resolution; avoid |
| Restart | **Restart** (needs `--run-unit`) | — | `systemctl --user restart coldprompt-run` | end of turn, then restart | progress kept; YAML files reloaded |
| Reset | **Reset run** (run stopped) | — | `coldprompt reset` | now | run archived with reason "reset"; the plan starts again from its first mission; repository and commits untouched |
| Archive a finished plan | **Archive plan** (run stopped and finished) | — | `coldprompt archive` (`--force`: also an unfinished run) | now | state, events, turns, outputs and plan snapshot move to `.coldprompt/archive/`; the next plan starts fresh |

A plan change (YAML) is read only when the run starts: use Restart, or Reset
for a new plan. The web console lists the YAML files changed since the start.

## Talking to the run

| Action | Web | Console | When | Effect |
|---|---|---|---|---|
| Ask the supervisor | message box, **Ask supervisor** | `ask <question>` | now, even during a worker turn (waits only while the supervisor reviews a turn) | the supervisor answers from the last finished turn (it does not see the turn in progress); the worker is untouched; it may propose a directive |
| Send your own instruction to the worker | message box, **Ask worker** | `tell --raw <text>` | delivered at the end of the current turn | sent verbatim, no supervisor rewriting |
| Have the supervisor write a directive | — | `tell <directive>` | after approval, at the end of a turn | the supervisor prepares it; it waits for `approve <id>` |
| Approve a proposed directive | **Approve** (under the message box) | `approve <id>` | next turn boundary | delivered to the worker |
| Reject a proposed directive, or withdraw an approved one not yet delivered | **Reject** / **Withdraw** | `reject <id>` | now | never delivered |
| List directives | (shown under the message box) | `directives` | now | — |

## Unblocking

| Situation | Web | Console | Effect |
|---|---|---|---|
| Run blocked by the supervisor (BLOCKED) or failed | message box, **Resume worker** | `resume <resolution>` | required to leave BLOCKED / FAILED; the text goes to the worker |
| Mission waiting for approval (no auto-approval) | **Approve** (mission panel) | `approve mission` | the next mission starts (a new thread if the session ends) |
| Read-only mission whose completion checks failed | **Approve** | `approve mission` | accepted as complete despite the checks |
| Turn limit reached (MISSION_LIMIT) | **+3 turns** / **+10 turns** | `extend <n>` (1–100) | limit raised; the run resumes |
| End the mission now | **Complete mission** | `complete` | ends only if its completion checks pass (run blocked, failed or paused, no turn waiting) |
| Give up the mission | **Skip mission** | `skip` | ends without checks, marked skipped; the next mission starts |

## Information

| Action | Web | Console | Command line |
|---|---|---|---|
| Status | top panel (live) | `status` | `coldprompt status` (live, or the saved state) |
| Recent events | **Logs** tab | — | `coldprompt events [n]` |
| Check the configuration and tools | — | — | `coldprompt doctor` |
| Help | — | `help` | `coldprompt` (usage) |

## Setup

| Action | Command line |
|---|---|
| Web console | `coldprompt web [--host H] [--port P] [--run-unit U]` (default `127.0.0.1:8787`; phone: `tailscale serve --bg 8787`) |
| systemd services for the run and the web console | `coldprompt systemd` (print) / `coldprompt systemd --write` |
| Forget the web token on a device | **Forget token** (web) |

Environment: `COLDPROMPT_CONFIG` (the plan, default `coldprompt.yaml`),
`COLDPROMPT_HOME` (the state directory, default `.coldprompt` next to the
plan). Plan variables (`${VAR}` in the YAML) come from the environment or the
`.env` next to the plan; see the README.
