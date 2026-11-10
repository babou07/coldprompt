# ColdPrompt roadmap

Agreed with the user on 2026-11-10, after the GP-FIRST-24 campaign and the
move of the Moscata project to branch routing campaigns. Steps are in
priority order; each one is usable on its own.

| Step | State |
|---|---|
| 1. Restart and reset buttons | Done (2026-11-10) |
| 2. Per-session settings | To do |
| 3. Milestones and merge button | To do |
| 4. Triggers | To do |
| 5. Milestone planner | To do |
| 6. Dedicated `coldprompt` Linux user | To do |
| 7. Operator tab | To do, after step 6 |

ColdPrompt stays project-agnostic: no knowledge of KiCad, PCBs or any other
tool of a target project. Project-specific actions are missions written in
the project's own plan files.

## Step 1 — Restart and reset buttons

### Restart

Stop the run process, reload `coldprompt.yaml` and the session files, and
resume at the current mission with its progress kept.

Why: "resume" only retries with the configuration already loaded in memory.
On 2026-11-10 a corrected worker model (`gpt-6-Astra` → `gpt-6-astra`) was
ignored until the systemd unit was restarted by hand.

- Web console button (`systemctl --user restart <unit>`; needs `--run-unit`).
  No console command: the orchestrator cannot restart itself.
- The console shows "configuration changed since the run started" when
  `coldprompt.yaml` or a session file differs from the plan snapshot, and
  offers the restart.

### Reset

Archive the current run as aborted (never delete it) and start the plan
again from its first mission, optionally starting right away.

Why: on 2026-11-10 the first GP-FIRST-24 run blocked in its first mission
(KiCad not responding, then an authorization wording). After the fix the user
wanted a clean start; it took `coldprompt archive --force` by hand.

- Web console button (while stopped, for a plan that is not finished; a
  finished plan is archived instead) and CLI `coldprompt reset`.
- The repository is never touched. If the run already made commits, the
  console lists them before confirming ("2 commits made by this run") and
  leaves them as they are.

### Small fixes found on the way

- `coldprompt run --dry-run` hung without output on the C01 plan
  (2026-11-10); to investigate.
- `doctor` has no `--config` option; it must run from the config directory.

## Step 2 — Per-session settings

A session file may override:

- `worker` (provider, model, reasoning effort): e.g. a careful model for
  studies and a faster one for routing, without editing the main config;
- `verification.commands` (per-turn and completion checks), e.g. a branch
  limits check that only applies to a routing session.

Prerequisite for milestones, and useful on its own.

## Step 3 — Milestones (sequential, no scheduling)

A milestone is a unit of work that ends with a human decision. In the Moscata
branch strategy, one milestone = one routing branch (e.g. J1 =
`routing/dio-core`: routing, independent review, global checks, then merge).

A milestone file declares:

- `id`, `title`;
- `branch` (optional): created from the base branch at the start, checked out
  for the whole milestone;
- `worker` and `verification` overrides (step 2), applied to all its sessions;
- `init` missions (optional): run before the first session. Project-defined,
  e.g. "open KiCad and the PCB" for Moscata;
- `sessions`: one or more session files, run in order (a milestone may also
  have a single session);
- `finalize` missions (optional): run after the last session, e.g. "close
  KiCad" for Moscata, then the existing finalize call (summary e-mail);
- `exit`: what makes the milestone ready for decision, e.g. the review
  mission's structured output says MERGE and the completion checks pass;
- `decision`: what the user is asked at the end ("merge `routing/dio-core`
  into main?").

The plan becomes an ordered list of milestones. A milestone ends in
`AWAITING_DECISION`; the next one starts only after the decision, since its
branch must start from the merged base.

### Merge button

When a milestone with a branch is awaiting decision, the web console shows:

- the review verdict, the diff summary (`main..branch`) and the checks;
- **Merge**: a plain merge into the base branch (no force, no rebase); on a
  conflict or any failure it stops and reports, it never resolves anything;
  then pushes if the milestone says so, and starts the next milestone;
- **Reject**: keeps or deletes the branch (user's choice), base untouched.

Merging stays a user action: ColdPrompt never merges on its own.

Archives become per milestone (one archive entry per J1, J2…), so the
history reads as the list of branches merged or rejected.

## Step 4 — Triggers

Each milestone has a `start` trigger:

- `after-previous` (default): as soon as the previous milestone is merged;
- `at`: a date and time ("tomorrow 08:00"), through the systemd unit;
- `manual`: waits for a Start click.

The console shows the timeline: done, awaiting decision, scheduled, waiting.

## Step 5 — Milestone planner

At the end of a milestone, a supervisor call proposes the next one from the
review report and the project's own ordering document (for Moscata:
`docs/routing-branches.md`, R03 → R05 → R04…). The proposal reuses the
existing proposals mechanism: the user edits or accepts it, nothing starts
without that.

## Step 6 — Dedicated `coldprompt` Linux user

Run the whole ColdPrompt stack (orchestrator, web console, worker,
supervisor, later the operator) as a dedicated user, so the kernel enforces
its limits, not only the tools' own sandboxes. Discussed on 2026-11-10.

Why the whole stack: if only an agent runs as `coldprompt`, files it writes
(coldprompt.yaml, verification scripts, git hooks) are still executed by
processes of the main user. Under one user, everything ColdPrompt executes
stays within that user's rights.

- User and group `coldprompt`; the main user is also a member. The workspace
  is owned by `<user>:coldprompt`, setgid, with default ACLs `g:rwX`, so
  files created by either side stay writable by both.
- ColdPrompt itself and its state directory (`COLDPROMPT_HOME`, web token
  included) move out of the workspace: an agent with write access to the
  workspace must not be able to change ColdPrompt or its own limits.
- `coldprompt` is not in the `docker` group (root-equivalent) and cannot read
  the main user's home (`~/.ssh`, credentials).
- Its own credentials: Codex and Claude logins, a GitHub deploy key limited
  to the project repositories, its own copy of the mail skill if needed.
- Git hooks: a global `core.hooksPath` for the main user, so hooks written in
  the workspace never run under the main user.
- Tools installed for `coldprompt` (node, codex, claude); systemd user units
  with `loginctl enable-linger coldprompt`.
- KiCad / Konnect: KiCad runs in the main user's desktop and its IPC socket
  (`/tmp/kicad/api.sock`, mode 755) refuses other users. A launcher makes it
  group-accessible after each KiCad start. This is the most fragile point.
- Migration in one go: user and permissions, move, tools and logins, KiCad
  socket, units, a test run.

## Step 7 — Operator tab

A third tab in the web console: a Claude agent with write rights inside the
workspace, to drive the work from a phone (fix a configuration, edit
documents, commit), while the run is stopped, paused or blocked.

- Runs as the `coldprompt` user (step 6); network cut except the model API.
- Its mission and rights live in `~/.config/coldprompt/` (an AGENTS.md /
  CLAUDE.md and a rights file), outside the workspace, so it cannot rewrite
  them.
- Changes to the "executable" keys of the plan (verification commands,
  plugins, codexPath, sandbox and approval modes, supervisor permissions),
  to `.git/hooks` and `.git/config` are proposals only.
- Run actions (restart, reset, extend, complete, skip, worker directive,
  resolution) and `git push` are proposals the user approves in the tab;
  ColdPrompt executes them.
- A backup before each operator session (a btrfs snapshot if available),
  every file change shown as a diff with Revert, every action logged in the
  run events and reported to the supervisor.
- No writes to the target repository while a worker turn runs.
- Lighter alternative kept in mind: read-only git tools for the supervisor's
  answers and a YAML editor in the page.

