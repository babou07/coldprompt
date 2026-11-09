# ColdPrompt architecture: decisions and open risks

## Modules

| Module | Role |
|---|---|
| `src/types.ts` | Config schema (zod), decisions, review schema, persisted state |
| `src/config.ts` | YAML loading with path-precise validation errors |
| `src/store.ts` | Atomic state (`write tmp + fsync + rename`), JSONL events, turn artifacts, owner lock, socket path |
| `src/orchestrator.ts` | State machine, recovery, retries, HOT_PROMPT queue, console commands |
| `src/worker.ts` / `src/supervisor.ts` | Provider-agnostic interfaces, supervisor prompts |
| `src/adapters/codex.ts` | `@openai/codex-sdk`, streamed turns |
| `src/adapters/claude.ts` | Claude Code CLI, `--print --output-format json --json-schema` |
| `src/adapters/fake.ts` | Scripted adapters for tests and `--dry-run` |
| `src/git.ts` | Read-only snapshots (`GIT_OPTIONAL_LOCKS=0`), commits between turns |
| `src/verification.ts` | Command verifiers, git-clean, plugin loader |
| `src/console/*` | Unix-socket server, NDJSON protocol, REPL and one-shot client |
| `src/web/*` | Web console (HTTP + SSE client of the console socket), page assets, systemd units |
| `src/cli.ts` | `run`, `console`, `send`, `status`, `doctor`, `events`, `web`, `systemd` |

The orchestrator only sees `WorkerAdapter` / `SupervisorAdapter`; no
provider name appears in it.

## Turn lifecycle (crash-safe)

```
nextWorkerInput ─► pendingTurn{WORKER_RUNNING} ─► worker.executeTurn
                    (persisted before the call)
                ─► artifact turns/<id>.worker.json
                ─► pendingTurn{WORKER_DONE}, counters++, directives DELIVERED (one atomic write)
                ─► supervisor.evaluateTurn ─► turns/<id>.review.json
                ─► pendingTurn{REVIEWED}
                ─► apply decision (+ completion verification) and clear pendingTurn (one atomic write)
```

Recovery at start-up is deterministic:

| Persisted phase | Action |
|---|---|
| `WORKER_RUNNING` | Outcome unknown. Never re-run. Snapshot saved as `<id>.abandoned.json`, state `BLOCKED/AMBIGUOUS_TURN`; directives return to APPROVED; the human resolves. |
| `WORKER_DONE` | Review only; the worker is not called again. |
| `REVIEWED` | Apply the persisted review only. |
| HOT_PROMPT `PROCESSING` | Back to `QUEUED`, re-asked. |

The Codex thread id is persisted as soon as `thread.started` arrives, so
even an interrupted first turn keeps its thread.

## Decisions

- **Sole owner.** `owner.lock` (O_EXCL, pid + hostname). A dead owner on the
  same host is taken over; a live owner is reported and never killed.
- **Single Claude writer.** All supervisor calls go through one serial queue
  in the orchestrator; the adapter refuses re-entrant calls as well. The
  console never runs Claude itself.
- **Claude sessions.** The first call uses `--session-id <uuid>`, later calls
  `--resume <uuid>`. "Already in use" after a lost result switches to resume.
  Supported options are checked against `claude --help` at start-up.
- **Structured control only.** Decisions come from `structured_output`
  (or a `result` that is itself strict JSON), validated by zod. Prose is
  rejected, never parsed.
- **Directives.** A human `tell --raw` is approved by construction. Anything
  Claude proposes (from `ask` or `tell`) is `PROPOSED` until `approve <id>`.
  Approved directives are delivered only at the next turn boundary.
- **BLOCKED / FAILED** leave only through `resume <resolution>` (non-empty) or,
  for mission approval, `approve mission`. Questions are answered while
  blocked without touching worker state. `pause` cannot unblock.
- **MISSION_COMPLETE** runs completion verifiers (commands, plugins,
  git-clean for non-read-only missions). Any failure sends the failures back
  to the worker and tells the supervisor at the next review.
- **Read-only missions** force the Codex `read-only` sandbox, skip git-clean,
  and a repository change blocks with `READ_ONLY_VIOLATION`. Without an
  explicit `verification` list they run no completion checks (the worker
  could never make a failing one pass; found in the first real run). If a
  listed completion check fails, the mission blocks with `VERIFICATION_FAILED`
  instead of asking the worker to fix it; `approve mission` accepts it
  anyway. `doctor` warns about read-only missions that list completion checks.
- **Sessions.** `coldprompt.yaml` lists session files; the loader inlines them
  and gives the engine one ordered mission list, each mission tagged with its
  session. One session = one Codex thread, recorded in
  `state.sessions[<id>].workerThreadId`. A session starts a new thread unless
  its file sets `resumeThread`; environment variables are never used (a stale
  `CODEX_THREAD_ID` once resumed an unrelated 1 400-turn thread). A transition
  that leaves a session always blocks with `MISSION_APPROVAL`, whatever
  `requireHumanApproval` says. One Claude conversation spans all sessions.
  A mission moved to another session after it started is refused at start-up.
- **Handoff.** Sessions share context only through an explicit handoff:
  `handoff: previous` in a session file adds the previous session's worker
  reports (from `turns/*.worker.json`, newest kept within 40 000 characters)
  to the session's first prompt, labelled as claims to verify. Inside a
  session the thread already carries the context. Nothing is written to the
  target repository.
- **State v3.** v1/v2 states had one shared thread (`workerThreadId`) and
  per-mission threads; on upgrade the shared thread goes to the current
  session and per-mission threads are dropped.
- **Codex permissions** are inherited: `sandboxMode`/`approvalPolicy` are only
  passed when configured.
- **Retries.** Capacity errors: `retryDelaysSeconds` (30/60/120/240), then
  `BLOCKED/RETRIES_EXHAUSTED`. Active-writer conflicts:
  `sessionLockRetryDelaysSeconds`, then `BLOCKED/SESSION_LOCK` with a
  diagnostic. Authentication and permanent errors: `FAILED`, no retry.
  A failed session is never replaced with a new one.
- **Limits** (`maxTurns`, `maxHours`) are per `run` invocation and checked
  between turns only; time spent waiting for a human does not count.
  Per-mission `execution.maxTurns` blocks the mission.
- **Config drift.** If the mission list (across session files) no longer
  matches persisted progress, start-up is refused.
- **Socket.** `<COLDPROMPT_HOME>/console.sock` (0600, directory 0700). Paths over
  the `sun_path` limit use `/tmp/coldprompt-<uid>/coldprompt-<hash>.sock`; that
  directory's owner and mode are checked. The path does not depend on
  environment variables, so tmux and SSH sessions agree.
- **Dry-run** uses the fake adapters and a temporary state directory. No
  provider call, no verification command; the target repository is only read.
- **Secrets.** Event logs and artifacts go through `redactValue`; the values
  of secret-looking environment variables are masked.

- **Web console.** A separate process that connects to the console socket;
  it cannot do more than `coldprompt console` (command allowlist, same
  orchestrator validation). Bearer token from a 0600 file, compared in
  constant time; no cookies and JSON-only POSTs, so no CSRF; strict CSP
  (`'self'` only) and all data rendered as text. Live Codex activity comes
  from `worker.progress` events (SDK `item.*` stream, outputs clipped);
  they are persisted, so a reconnecting page replays the last 400 events.
  Default bind is localhost; remote access through `tailscale serve`.

## Open risks / not done

1. **Codex binary version.** The SDK (0.77) launches its *bundled* codex
   0.77 by default. With a newer user setup this failed in practice
   ("model requires a newer version of Codex"). Setting `worker.codexPath`
   to the system codex (0.167) passed the integration test, but the SDK's
   JSONL protocol is not guaranteed to stay compatible with newer CLIs.
   `coldprompt doctor` warns about the mismatch. Consider upgrading the SDK.
2. **Exact Codex "active writer" error text** is unknown; detection uses a
   broad regex (`src/errors.ts`). Capture the real message and add it to a test.
3. **Ambiguous supervisor calls.** If ColdPrompt dies during a Claude call,
   that prompt may already be in the Claude conversation; on restart the
   review or question is sent again (a harmless duplicate in the
   conversation, not a duplicated worker turn).
4. **Partial work in failed worker turns.** A turn that fails with a
   capacity error is retried with the same prompt on the same thread;
   Codex may have done part of the work. The git evidence shows it.
5. **Real unattended runs.** One supervised real run was done on a
   disposable repository (2026-11-08): a read-only audit and a fix mission,
   with BLOCKED, stop, restart, resume and mission approval. No long
   unattended mission has been executed against a user project yet.
6. Returning to an earlier session's thread after another session (e.g.
   main work, audit, back to main) is not supported, except by pasting that
   thread id into a later session's `resumeThread`.
7. No build step yet (`tsx` at runtime). The Unix console has no
   authentication beyond file permissions (single-user by design); the web
   console relies on a single shared token (no per-user accounts, no
   rotation command: delete `web-token` and restart `coldprompt web`).
8. Verification commands run through `sh -c` with the user's privileges;
   they come from the trusted config file only.
