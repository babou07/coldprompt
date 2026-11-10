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
