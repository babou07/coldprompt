# ColdPrompt — Agent development instructions

## 1. Product vision

ColdPrompt is a generic, self-hosted orchestration runtime for
long-running AI coding agents.

It must not contain hardcoded knowledge of Moscata, KiCad,
PCB design or any particular user project.

Primary stack:
- TypeScript, Node.js 22+
- Codex SDK as worker adapter
- Claude Code CLI as supervisor adapter
- YAML configuration
- Persistent local state
- JSONL event logs
- Unix socket for interactive console
- Git-aware verification

Initial platform: Linux, especially Fedora.
Remote control through SSH and Termux must work.

## 2. Prompt taxonomy

Exactly two public prompt types:

### COLD_PROMPT

A planned mission instruction declared before execution.
One COLD_PROMPT is one mission.

Properties:
- Stored in a session file, in order
- Ordered and persistent
- Contains objective and completion criteria
- May require read-only permissions
- Can run over multiple worker turns

### Sessions and plan

A session is one YAML file holding an ordered list of missions.
One session is exactly one Codex thread: all its missions run
consecutively in the same worker context.

The plan (coldprompt.yaml) holds the shared configuration and
references the session files, executed one after another.
Missions are never declared directly in coldprompt.yaml.

- A new session always starts a new Codex thread, unless the
  session file sets `resumeThread:` to an existing thread id.
- Moving from one mission (or session) to the next requires
  explicit human approval, unless the plan sets
  runtime.autoApproveMissions: true (default false). Auto-approval
  never skips any other block.
- Context passes between sessions only through an explicit
  handoff (worker reports of the previous session).
- One single Claude supervisor conversation spans the whole plan.

Vocabulary: "session" alone means an ColdPrompt session (a file,
a Codex thread). Say "Claude conversation" for the supervisor.

### HOT_PROMPT

A human instruction injected at runtime.

Intents:
- QUESTION: ask the supervisor for analysis
- DIRECTIVE: prepare an instruction for the worker
- RESOLUTION: resolve a BLOCKED state

Properties:
- Higher priority than pending cold missions
- Persisted and auditable
- Never silently overwrites the original mission
- Never interrupts an active worker turn unsafely
- Worker directives are delivered at the next safe boundary
- A question must not automatically modify worker state

Internal runtime instructions are NOT user prompt types.

## 3. Agents and adapters

Use generic interfaces:

WorkerAdapter:
- startSession()
- resumeSession()
- executeTurn()
- cancel()
- getSessionId()

SupervisorAdapter:
- evaluateTurn()
- interact()
- resumeSession()
- getSessionId()

Implementations (each role picks a provider in the config):
- Worker: CodexWorkerAdapter, ClaudeWorkerAdapter
- Supervisor: ClaudeSupervisorAdapter, CodexSupervisorAdapter

Do not hardcode any provider into the orchestration engine.
Providers are registered in src/adapters/registry.ts.

## 4. Codex requirements

Use @openai/codex-sdk.

Resume an existing thread only when a session file sets
`resumeThread:`. Do not read thread ids from the environment.

Do not run two writers on the same Codex thread.

The normal execution path must inherit the user's Codex
permissions configuration. Do not force workspace-write
when this would override a custom writable .git profile.

Dry-run must never modify the target repository.

Handle the thread-store active-writer conflict with bounded
retry and clear diagnostics. Never kill a process automatically.

## 5. Claude requirements

Use the Claude Code CLI initially.

Prefer structured JSON output with a strict JSON schema.
Do not parse arbitrary prose as authoritative control commands.

Maintain conversation continuity using supported session IDs
and resume mechanisms.

The orchestrator is the sole owner of Claude conversation state.
The interactive console must communicate with the orchestrator,
not launch a competing independent Claude session.

Validate CLI options against the installed Claude version.

## 6. Supervisor decisions

Allowed decisions:

CONTINUE:
  Continue the current mission.

CLARIFY:
  Ask the worker for additional evidence.

BLOCKED:
  Suspend all worker execution and enter human interaction.

MISSION_COMPLETE:
  Finish the current mission only after evidence checks.

STOP:
  Halt because of a failure or unacceptable risk.

Never treat a worker's self-reported DONE as sufficient
proof of mission completion.

## 7. BLOCKED interaction

On BLOCKED:
1. Complete processing of the current worker turn.
2. Persist the worker result, supervisor review and reason.
3. Set state to BLOCKED.
4. Do not start another worker turn.
5. Make Claude available through the interactive console.
6. Accept questions and proposed directives.
7. Require explicit human RESOLUTION and RESUME.
8. Continue the same worker session unless deliberately changed.

No automatic skipping to another mission while BLOCKED.

If the user is unavailable, remain blocked indefinitely
until explicit intervention.

## 8. Interactive console

Target commands:

status
ask <question>
tell <directive>
pause
resume <resolution>
stop
help

Use a local Unix domain socket with restrictive permissions.

The console must be usable over SSH from Android Termux.

Multiple clients may connect, but all state-changing commands
must be serialized by the orchestrator.

Questions may be accepted during normal execution, but must not
corrupt Claude's conversation or interrupt an active turn.

A directive must not be considered approved merely because
Claude proposed it.

## 9. Persistence

Store:
- Active session and mission IDs and indexes
- Codex thread ID per session, Claude conversation ID
- Runtime status
- Worker turn counters
- Pending HOT_PROMPT queue
- Pending worker directives
- BLOCKED reason
- Last review and result references
- Git snapshots
- Retry and error state
- Relevant timestamps

Use atomic state writes and append-only event logging.

Restart must not duplicate a completed worker turn or
silently discard a pending HOT_PROMPT.

Design explicit recovery for ambiguous interrupted turns.

## 10. Git and verification

Capture repository state before and after each worker turn.

Record:
- HEAD
- Clean/dirty state
- Ahead/behind information when available
- Commits created
- Verification outcomes

Do not require commits on arbitrary fixed intervals.
Some missions legitimately involve analysis rather than changes.

Verification must be extensible through project-specific plugins
or commands, without embedding KiCad logic in the core.

Mission completion may require:
- Tests
- Lint/typecheck
- Git cleanliness
- Domain-specific verification
- Human approval

A supervisor's opinion is not a substitute for deterministic checks.

## 11. Execution safety

Use a single orchestrator owner process.

Enforce exclusive ownership of state and worker sessions.

Use bounded retries for transient capacity errors:
30, 60, 120, 240 seconds by default.

Differentiate:
- Transient provider capacity errors
- Session lock conflicts
- Invalid configuration
- Authentication errors
- Unsafe repository state
- Permanent worker failures

Implement graceful SIGINT/SIGTERM handling.

Do not silently restart a failed worker with a new session.

Respect max turns and max hours, checking limits between turns.

Never log credentials or environment secrets.

## 12. Architecture targets

Suggested modules:

src/types.ts
src/config.ts
src/store.ts
src/orchestrator.ts
src/worker.ts
src/supervisor.ts
src/adapters/codex.ts
src/adapters/claude.ts
src/console/server.ts
src/console/client.ts
src/git.ts
src/verification.ts
src/cli.ts

Separate domain logic from CLI, provider adapters and storage.

## 13. Testing priorities

P0:
- Config parsing and validation
- Durable state transitions
- BLOCKED prohibits worker execution
- RESUME requires explicit user approval
- Worker thread resumes correctly
- Active-writer conflicts are handled safely
- HOT_PROMPT is never lost
- No concurrent supervisor conversation writers
- Restart recovery is deterministic

P1:
- Multi-mission transitions
- Git verification
- Capacity retries
- Remote console reconnect
- Structured event logging

P2:
- Pluggable verification
- Alternative agent providers
- Metrics and dashboard
- More sophisticated scheduling

Use fake worker and supervisor adapters for unit tests.
Keep real-provider integration tests opt-in.

## 14. Acceptance scenario

Given one session with two COLD_PROMPT missions:

1. ColdPrompt starts mission A.
2. Codex executes multiple turns.
3. Claude returns CONTINUE.
4. A worker result requires human judgment.
5. Claude returns BLOCKED.
6. ColdPrompt stops worker execution.
7. The user connects from Termux.
8. The user asks Claude a question via HOT_PROMPT.
9. Claude answers without changing the worker.
10. The user submits a directive.
11. The user explicitly resolves the block.
12. ColdPrompt resumes the existing Codex session.
13. Claude eventually validates MISSION_COMPLETE.
14. ColdPrompt starts mission B.
15. A restart preserves state and avoids duplicate work.

All steps must be covered by tests before declaring
the orchestrator ready for unattended execution.

## 15. Development instructions for Claude Code

First inspect the entire repository.

Do not assume this alpha scaffold is production-ready.

Implement the missing runtime incrementally.
Preserve the documented behavior and public vocabulary.

Start with fake adapters, persistence and state-machine tests.
Then implement Codex and Claude adapters.
Finally add the interactive Unix-socket console.

Run typecheck and tests after each substantial change.

Do not execute a real unattended mission against Moscata
until the integration tests and recovery behavior are verified.

Document architectural decisions and unresolved risks.
