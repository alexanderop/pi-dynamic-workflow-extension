# Dynamic Workflows Backlog

This backlog treats the dynamic workflow feature as one epic that should be built through small, testable vertical slices. Each slice should leave the package useful or more observable, even when the full Claude-Code-like workflow system is not finished.

## Backlog Principles

- Prefer one behavior plus its tests over broad infrastructure.
- Keep the Pi extension shell thin; put workflow behavior in ordinary modules.
- Use fake subagents before live Pi agent sessions.
- Make run JSON the `/workflows` read model from the beginning.
- Preserve every new workflow-model finding in `spec.md`.
- Do not add live model tests until fake-runner and filesystem integration tests pass.

## Epic 0: Package And Developer Baseline

Goal: make the repository installable, testable, and easy for future agents to navigate.

### Slice 0.0: Test Harness And Fixtures

User value: we can implement the epic safely without real model calls or manual Pi sessions.

Scope:

- Add reusable temp directory helpers for workflow run storage.
- Add a fake subagent runner fixture.
- Add fixture builders for run JSON, journal JSONL, and extension command contexts.
- Keep helpers independent of Pi live credentials.

Tests:

- Smoke test creates an isolated temp run fixture.
- Fake runner can resolve string, object, failure, and delayed results.
- Helpers clean up temp files.

Dependencies:

- Existing scaffold.

Spec coverage:

- Enables every acceptance criterion without satisfying a user-facing workflow behavior by itself.

Status: pending.

### Slice 0.1: Installable Pi Package Shell

User value: users can install or try the package even before the workflow runtime exists.

Scope:

- Keep `package.json` with `pi.extensions`.
- Keep a minimal extension entrypoint.
- Register placeholder `/workflows`.
- Document git tag installation and local `pi -e .` usage.

Tests:

- Unit test that the extension registers `/workflows`.

Dependencies:

- None.

Spec coverage:

- Enables later work on §5 Launcher and §16 Controller, but does not satisfy workflow behavior yet.

Status: done as scaffold.

### Slice 0.2: Reference Docs And Backlog

User value: future work starts from local docs instead of rediscovering Pi behavior each time.

Scope:

- Maintain `docs/pi-extension-reference.md`.
- Maintain `docs/testing-reference.md`.
- Maintain this backlog.
- Keep `AGENTS.md` docs index current.

Tests:

- None required beyond docs review.

Dependencies:

- Slice 0.1.

Spec coverage:

- Supports all future spec work by making the implementation plan explicit.

Status: in progress.

### Slice 0.3: Decisions Log

User value: ambiguous reverse-engineered behavior is recorded instead of rediscovered or guessed.

Scope:

- Add `docs/decisions.md` or ADR-style files.
- Record choices for Pi-native storage layout, saved workflow locations, notification mechanism, key hashing inputs, structured-output retry count, and `agentType` mapping.
- Link decisions from `AGENTS.md`.

Tests:

- Docs review only.

Dependencies:

- Slice 0.2.

Spec coverage:

- Supports §12, §13, §17, and §18 by making implementation-specific mappings explicit.

Status: partially done. ADRs exist for using ADRs, the parser/runtime strategy,
explicit workflow state machines, Pi extension context usage, project-local Pi
workflow run storage, the terminal notification hook before Pi message wiring,
domain-module organization, stable journal key inputs, and saved workflow
locations. Remaining decisions still need ADRs for structured-output retry count
and `agentType` mapping.

## Epic 0.5: First Thin Vertical Workflow

Goal: prove the whole shape end-to-end with fake execution before building complete runtime semantics.

### Slice 0.5.1: Fake One-Agent Workflow Smoke

User value: a developer can launch a tiny workflow, see it in `/workflows`, and receive a terminal notification, even though the agent is fake.

Scope:

- Launch one inline workflow script fixture.
- Persist initial run state.
- Execute one fake `agent()` call.
- Write journal `started` and `result`.
- Write terminal run JSON and output file.
- Make `/workflows` show the run.

Tests:

- End-to-end temp-dir integration with fake runner.
- Asserts launch returns before fake runner completes.
- Asserts `/workflows` reads run JSON, not transcript files.
- Asserts final notification payload points to output file.

Dependencies:

- Slices 0.0, 1.1, 1.2, 2.1, 2.4, 3.2, 3.4, and 4.1 in minimal form.

Spec coverage:

- Threads through §5, §8, §9, §12, §13, and §17.
- Advances acceptance criteria 1, 3, 5, 11, 12, and 16 in fake-runner form.

Status: implemented with `test/workflows/launch/one-agent-smoke.test.ts`. The smoke
story launches an inline workflow with a pending fake agent, proves the launch
returns before agent completion, reads the initial and final manifests through
`WorkflowRunStore`, verifies journal `started`/`result` events, checks the full
`output.json`, and asserts the terminal notification points to that output file.

## Epic 1: Workflow Read Model And `/workflows` UI

Goal: build the progress viewer before the runtime so the UI contract shapes persistence.

### Slice 1.1: Run-State File Discovery

User value: `/workflows` can list known runs from disk using fake fixture data.

Scope:

- Define Pi-native workflow storage paths.
- Add a `WorkflowRunStore` that lists and reads `WorkflowRunState`.
- Add fixture run JSON based on `spec.md` observed run shape.
- Keep storage layout documented as Pi mapping of the Claude artifact layout.

Tests:

- Reads multiple run JSON files from a temp directory.
- Ignores invalid or partial files predictably.
- Sorts runs by start or timestamp.

Dependencies:

- Slice 0.2.

Spec coverage:

- §12 Run State Model.
- §18 Storage Layout.
- §20 acceptance criterion 11.

Status: implemented for project-local `.pi/workflows/<runId>/manifest.json`
discovery. The store reads typed run-state manifests, normalizes the current
exploratory manifest shape, skips invalid manifests during list operations, and
does not require journals or transcripts for the overview read model.

### Slice 1.2: `/workflows` List Command

User value: users can run `/workflows` and see existing workflow runs.

Scope:

- Replace placeholder notification with a simple non-interactive text summary first.
- Show run id, status, workflow name, agent count, duration, and output path if present.
- Keep command usable in non-TUI mode.

Tests:

- Command handler renders an empty-state message.
- Command handler renders fake runs from a temp store.
- Does not read subagent transcript files.

Dependencies:

- Slice 1.1.

Spec coverage:

- §12 Run State Model.
- §20 acceptance criterion 11.

Status: implemented as a non-interactive command that reads project-local
`.pi/workflows/<runId>/manifest.json` files through `WorkflowRunStore`, renders
an empty state, and summarizes run id, status, workflow name, agent count,
duration, and manifest-provided output path without reading journals or
transcripts.

### Slice 1.3: Custom TUI Viewer

User value: users can inspect workflow progress while a run is active.

Scope:

- Add `ctx.ui.custom()` view for TUI mode.
- Render Runs, Progress, Agents, and Details panels.
- Keyboard support: up/down, tab, enter, escape.
- Poll run JSON periodically while open.

Tests:

- Pure rendering tests for view model to rows.
- Component state tests for focus movement and selection.
- Command falls back to text summary outside TUI mode.

Dependencies:

- Slice 1.2.

Spec coverage:

- §12 Run State Model.
- §20 acceptance criterion 11.

Status: implemented as a first custom Pi TUI viewer. The command now opens
`ctx.ui.custom()` in interactive TUI mode, keeps text/json fallbacks for
headless modes, renders Runs, Progress, Agents, and Details from manifest-backed
`WorkflowRunState`, polls manifests while open, and keeps projection/navigation
logic independent of Pi TUI imports per ADR 0010.

### Slice 1.4: `/workflows` UI States

User value: the UI can grow predictably instead of becoming one large custom component.

Scope:

- State A: overview monitor for one active or selected workflow.
- State B: selected agent detail without dumping full prompts by default.
- State C: full prompt/result reader for selected agent.
- State D: workflow chooser for multiple runs.
- Document state transitions and keyboard controls before implementing.

Tests:

- Render fixtures for each state at narrow and wide widths.
- Navigation tests for overview to detail, detail to reader, chooser to overview.
- Assert no state requires transcript reads for the overview.

Dependencies:

- Slice 1.3.

Spec coverage:

- §12 Run State Model.
- §20 acceptance criterion 11.

Status: implemented as a first stateful `/workflows` monitor. One run opens an
overview monitor, multiple runs open a chooser, left-arrow opens structured
agent detail, enter opens the selected agent prompt reader, escape steps back
through states, and render tests protect the TUI width contract.

## Epic 2: Pure Workflow Runtime Semantics

Goal: implement the host API against fake agents before involving Pi sessions.

### Slice 2.0: Workflow And Agent State Machines

User value: workflow lifecycle edge cases are explicit before launcher,
scheduler, persistence, and UI code start depending on them.

Scope:

- Add a run state machine for created, starting, running, pausing, paused,
  resuming, completing, completed, failing, failed, stopping, and stopped.
- Add an agent progress state machine for queued, running, done, failed, and
  stopped.
- Keep `/workflows` UI navigation as a separate future state machine.
- Return typed transition errors through the local `Result<T, E>` pattern.
- Document the decision in an ADR.

Tests:

- Run start, pause, resume, and completion transitions.
- Invalid run transitions return typed errors.
- Completed, failed, and stopped runs are terminal.
- Run failure path records failures and terminal duration.
- Agent queued/running/done transition.
- Late agent results after stop are rejected.
- Failed or stopped agents can restart with a new attempt and new agent id.

Dependencies:

- Slice 0.3 in partial form.

Spec coverage:

- §12 Run State Model.
- §16 Controller Operations.
- §20 acceptance criteria 10, 11, 13, 14, and 15 in pure state-machine form.

Status: implemented with pure transition functions and ADR 0003. Not wired into
launcher, scheduler, persistence, journal replay, or `/workflows` UI yet.

### Slice 2.1: Runtime Types And Host API Skeleton

User value: workflow scripts have a typed internal contract to build against.

Scope:

- Add runtime types for launch request, agent options, budget, journal events, and failures.
- Add a runtime factory that exposes `phase`, `log`, `parallel`, and `pipeline`.
- Do not execute arbitrary workflow JavaScript yet.

Tests:

- `phase()` appends phase progress rows.
- `log()` appends run logs.
- Runtime state updates are persisted through a fake store.

Dependencies:

- Slice 1.1.

Spec coverage:

- §7 Runtime API.
- §12 Run State Model.
- §20 acceptance criteria 4 and 11.

### Slice 2.2: `parallel()` Semantics

User value: workflow authors can coordinate concurrent work with deterministic ordering.

Scope:

- Implement `parallel(thunks)`.
- Reject or fail already-started promises/non-functions.
- Resolve throwing thunks to `null`.
- Preserve input result order.

Tests:

- Starts all thunks.
- Output order matches input order even when completion order differs.
- Throwing thunk returns `null`.
- Non-thunk input is rejected.

Dependencies:

- Slice 2.1.

Spec coverage:

- §7 Runtime API.
- §10 Scheduling.
- §20 acceptance criteria 8 and 19.

Status: implemented for pure runtime semantics. Scheduler-cap integration still
belongs to Slice 2.4.

### Slice 2.3: `pipeline()` Semantics

User value: multi-stage workflows can start downstream work for each completed item without global barriers.

Scope:

- Implement `pipeline(items, ...stages)`.
- Thread `(previousStageResult, originalItem, index)`.
- Drop failed item to `null` and skip remaining stages for that item.

Tests:

- Stage 2 for item A starts before slow item B finishes stage 1.
- More than two stages work.
- Callback receives previous result, original item, and index.
- Throwing stage yields `null` for that item.

Dependencies:

- Slice 2.1.

Spec coverage:

- §11 Pipeline Semantics.
- §20 acceptance criteria 9 and 18.

Status: implemented for pure runtime semantics.

### Slice 2.4: Scheduler With Fake Agents

User value: workflow runtime can safely run many fake agents under a global cap.

Scope:

- Add FIFO scheduler.
- Enforce `maxConcurrent`.
- Enforce `maxTotalAgents`.
- Add fake agent runner adapter for tests.
- Update progress rows on queue, start, done, failed, stopped.

Tests:

- Never exceeds configured concurrency.
- Queue order is FIFO.
- Total-agent cap throws predictably.
- Progress rows transition through expected states.

Dependencies:

- Slices 2.1 and 2.2.

Spec coverage:

- §9 Subagent Contract, fake only.
- §10 Scheduling.
- §20 acceptance criteria 8, 10, and 20 partially.

Status: implemented for fake agents. `WorkflowAgentScheduler` enforces the
recommended default concurrency cap (`min(16, max(1, cpuCores - 2))`), supports
overrides for concurrency and total-agent caps, starts queued agents in FIFO
order, updates agent progress rows through queued/running/done/failed/stopped
states, and the pure runtime now routes `agent()` calls through the scheduler.
Queued and running fake agents can be stopped through `stopAgent()`, with running
agents receiving an abort signal. Controller/UI stop wiring remains for Slice
6.2, and live Pi subagent execution remains for Epic 7.

## Epic 3: Launcher, Script Evaluation, And Persistence

Goal: launch a workflow in the background and persist enough state to observe it.

### Slice 3.1: Meta Parsing

User value: saved workflows can be identified and listed without executing them.

Scope:

- Parse `export const meta = { ... }` from JavaScript source.
- Require pure object literal for saved workflows.
- Validate `meta.name` and phase titles.

Tests:

- Accepts a valid object-literal `meta`.
- Rejects variables, function calls, spreads, and template interpolation.
- Rejects missing name for saved workflows.

Dependencies:

- Slice 2.1.

Spec coverage:

- §6 Workflow Script Format.

Status: implemented in first core-runtime slice.

### Slice 3.2: Launch Inline Script With Fake Agents

User value: users can launch a simple workflow and get run identifiers immediately.

Scope:

- Add launch request validation.
- Allocate `taskId` and `runId`.
- Persist script copy and initial run JSON before execution starts.
- Start execution without awaiting completion.
- Return human-readable launch confirmation.

Tests:

- Exactly one of `script`, `name`, or `scriptPath` is required.
- Initial run JSON exists before background execution advances.
- Launch returns before fake agent completion.
- Confirmation includes task id, run id, script path, and transcript dir.

Dependencies:

- Slices 2.4 and 3.1.

Spec coverage:

- §5 Launcher.
- §8 Launch Contract.
- §20 acceptance criteria 1 and 3.

Status: implemented for inline scripts with fake agents. `launchWorkflow()`
validates the launch source, rejects unsupported saved/path launches with typed
errors, parses metadata and deterministic-script errors before creating storage,
allocates task/run ids, persists `.pi/workflows/<runId>/script.js`,
`transcripts/`, and the initial `manifest.json`, then starts VM execution on a
deferred background tick. The returned confirmation includes the task id, run
id, script path, and transcript directory. Terminal output files and
notifications remain Slice 3.4.

### Slice 3.3: Sandboxed Script Evaluation

User value: workflow JavaScript can orchestrate host calls without direct privileged access.

Scope:

- Evaluate plain JavaScript workflow modules with top-level await.
- Expose only approved globals.
- Capture returned value as run result.
- Block `Date.now()`, `Math.random()`, and argument-less `new Date()`.

Tests:

- Script can call `phase`, `log`, `agent`, `parallel`, and `pipeline`.
- Script cannot access Node filesystem by default.
- Deterministic primitive calls throw the specified error.
- Return value is stored as run result.

Dependencies:

- Slice 3.2.

Spec coverage:

- §6 Workflow Script Format.
- §7 Runtime API.
- §19 Security Requirements.
- §20 acceptance criteria 17 and 23.

Status: partially implemented with fake agents and no launcher/persistence. The
current runtime executes parsed workflow bodies in `node:vm`, exposes
`args`, `budget`, `phase`, `log`, `agent`, `parallel`, and `pipeline`, captures
the return value, and blocks the specified nondeterministic primitives.

### Slice 3.4: Terminal Status And Notification Payload

User value: the main conversation can be notified when a background workflow finishes.

Scope:

- Write final status, timestamp, duration, result, and failures.
- Write full output file.
- Generate task-notification XML or Pi custom message equivalent.
- Truncate inline result when needed.

Tests:

- Completed run writes final run JSON before notification.
- Failed run includes failures.
- Notification includes output file and usage fields.
- Inline result truncates without losing full output.

Dependencies:

- Slice 3.3.

Spec coverage:

- §17 Notification Contract.
- §20 acceptance criterion 16.

Status: implemented for fake-agent inline launches. Terminal runs now write
`.pi/workflows/<runId>/output.json`, persist `outputPath` on the terminal
manifest before notifying, build a task-notification payload with XML content and
structured details, include usage and failure summaries, and truncate the inline
result while preserving the full output file. The notification dispatcher is
exposed as a testable launch hook; wiring it to Pi `sendMessage()` remains future
extension integration work.

## Epic 4: Journal And Resume

Goal: make workflow runs replayable without VM snapshots.

### Slice 4.1: Journal Writer And Stable Keys

User value: each agent call has an audit trail and a stable resume key.

Scope:

- Compute `v2:<sha256>` key from prompt, schema, label, phase, agent type, model, cwd, and runtime key version.
- Append `started`, `result`, `failed`, and `stopped` events.
- Keep random `agentId` separate from stable key.

Tests:

- Same effective call gets same key.
- Changed prompt/schema/model/label/phase/agent type changes key.
- Journal writes `started` before fake execution.
- Journal writes `result` only after success.

Dependencies:

- Slice 2.4.

Spec coverage:

- §13 Journal Model.
- §20 acceptance criterion 12.

Status: implemented for fake-agent launches with ADR 0008. The journal module
writes `.pi/workflows/<runId>/journal.jsonl`, computes `v2:<sha256>` keys from
canonical effective-call inputs, appends `started` before fake execution,
appends `result` only after successful execution, and preserves random agent ids
separately from stable keys. A replay-cache helper already handles observed
Claude behavior where started-only attempts do not cache and duplicate keys use
the latest non-invalidated result. Stop-controller journal wiring remains for
Slice 6.2.

### Slice 4.2: Resume Cache Replay

User value: completed subagent work is reused when a run is resumed.

Scope:

- Scan journal from top to bottom.
- Build cache from non-invalidated result events.
- Treat `started` without `result` as incomplete.
- Re-execute workflow and skip cached agent calls.

Tests:

- Cached result returns without fake runner call.
- Incomplete started-only event does not return from cache.
- Changed prompt creates a new fake runner call.

Dependencies:

- Slice 4.1.

Spec coverage:

- §14 Resume Semantics.
- §20 acceptance criterion 13.

Status: implemented for inline fake workflow launches through
`resumeFromRunId`. The launcher reads the source run's `journal.jsonl`, builds a
latest-non-invalidated result cache, and passes it into the runtime scheduler.
Cached agent calls update the resumed run's progress but do not call the fake
runner or append new journal events. Incomplete failed attempts, invalidated
results, and changed stable-key inputs rerun through the fake runner.

### Slice 4.3: Restart Agent Invalidates Cache

User value: users can rerun one bad agent result without deleting audit history.

Scope:

- Implement journal `invalidated` event.
- Controller invalidates selected agent key.
- New attempt keeps old transcript metadata.

Tests:

- Invalidated result is ignored during replay.
- Restart creates a new attempt.
- Old transcript path remains referenced or preserved.

Dependencies:

- Slices 4.2 and 6.2.

Spec coverage:

- §13 Journal Model.
- §16 Control Operations.
- §20 acceptance criterion 14.

## Epic 5: Saved Workflows And Nested Workflows

Goal: support reusable workflow scripts after inline launch is reliable.

### Slice 5.1: Saved Workflow Discovery

User value: users can run named reusable workflows.

Scope:

- Decide Pi-native saved workflow locations and document mapping from `.claude/workflows`.
- Resolve project before personal on name conflict.
- Load saved workflow source by name.

Tests:

- Project workflow wins conflict.
- Personal workflow is used when no project workflow exists.
- Missing workflow gives clear error.

Dependencies:

- Slice 3.1.

Spec coverage:

- §6 Workflow Script Format.
- §8 Launch Contract.
- §20 acceptance criterion 2.

Status: implemented for fake-agent launches. Saved workflow name lookup resolves
Pi-namespaced project workflows under `<project>/.pi/workflows/*.js` before
personal workflows under `~/.pi/workflows/*.js`, rejects path-traversal names,
checks the conventional `<name>.js` path first, then scans other `.js` files by
`meta.name` for observed Claude filename/meta-name mismatches, and copies the
resolved script into the new run directory before executing it. Explicit
`scriptPath` launches now read, copy, and execute the referenced script. Saved
workflow listing reads project and personal script metadata, prefers project
workflows on conflicts, ignores unrelated invalid `.js` files during scans, and
surfaces saved workflows in `/workflows` with `description` and `whenToUse` as
user-facing guidance. ADR 0009 documents the locations and precedence.

### Slice 5.2: Save Run Script

User value: users can turn a successful run script into a reusable workflow.

Scope:

- Copy only the run script to selected saved workflow location.
- Do not copy run JSON, journal, transcripts, or result.

Tests:

- Saved file matches run script.
- No run-state files are copied.
- Invalid scope fails clearly.

Dependencies:

- Slices 3.2 and 5.1.

Spec coverage:

- §15 Save Semantics.
- §20 acceptance criterion 15.

Status: implemented as a core saved-workflow helper. `saveRunScript()` reads a
completed run manifest, copies only that run's `script.js` to the selected
project or personal saved-workflow path, validates that the requested saved name
matches `meta.name`, and leaves manifest, journal, transcripts, and output files
behind. UI/controller wiring for the `/workflows` save action remains future
work.

### Slice 5.3: Child `workflow()`

User value: workflow authors can compose workflows.

Scope:

- Implement `workflow(nameOrRef, args)`.
- Share parent scheduler, total-agent counter, abort signal, and budget.
- Forbid nesting deeper than one child level.

Tests:

- Child workflow shares concurrency cap.
- Child workflow shares total-agent cap.
- Nested child call throws.
- Child result returns to parent script.

Dependencies:

- Slices 3.3, 5.1, and 5.2.

Spec coverage:

- §7 Runtime API.
- §20 acceptance criterion 22.

## Epic 6: Controls And `/workflows` Actions

Goal: make long-running workflows controllable from the UI.

### Slice 6.1: Pause And Resume Run

User value: users can temporarily stop new agents from starting.

Scope:

- Pause stops dequeuing new agents.
- Resume moves status back to running and continues.
- Reflect status in `/workflows`.

Tests:

- Paused scheduler does not start queued work.
- Running agents may finish while paused.
- Resume starts queued work.

Dependencies:

- Slices 2.4 and 1.3.

Spec coverage:

- §16 Control Operations.

### Slice 6.2: Stop Run And Stop Agent

User value: users can cancel runaway or unwanted work.

Scope:

- Stop run cancels queued work and requests cancellation for running agents.
- Stop agent cancels one queued/running agent.
- Record stopped journal event.
- Confirm destructive stop actions in UI.

Tests:

- Queued agents become stopped.
- Running fake agent receives abort signal.
- Run reaches `stopped`.
- UI asks for confirmation.

Dependencies:

- Slices 4.1 and 6.1.

Spec coverage:

- §16 Control Operations.
- §13 Journal Model.

## Epic 7: Real Pi Subagents

Goal: replace fake agent runner with isolated Pi sidechain sessions.

### Slice 7.1: Pi AgentSession Adapter

User value: `agent()` can produce real model-backed subagent results.

Scope:

- Create a fresh sidechain Pi session per `agent()` call.
- Use same project cwd.
- Select model and agent type where Pi supports it.
- Write transcript and metadata files.

Tests:

- Adapter unit tests with mocked session.
- Filesystem integration test asserts transcript and metadata paths.
- Live model smoke test skipped unless credentials exist.

Dependencies:

- Slice 2.4.

Spec coverage:

- §9 Subagent Contract.
- §20 acceptance criteria 5 and 20 partially.

### Slice 7.2: Structured Output Validation

User value: `agent({ schema })` resolves only validated objects.

Scope:

- Add structured output tool/protocol for subagents.
- Validate result against JSON schema.
- Add bounded nudge/retry behavior for missing or invalid structured output.
- Surface final schema failure as run failure.

Tests:

- Valid structured output resolves object.
- Invalid output retries or nudges within bound.
- Missing structured output fails predictably.
- Journal result is written only after validation.

Dependencies:

- Slices 7.1 and 4.1.

Spec coverage:

- §9 Subagent Contract.
- §17 Notification Contract failures.
- §20 acceptance criteria 6, 7, 12, and 20.

### Slice 7.3: Worktree Isolation

User value: concurrent mutating agents can avoid working tree conflicts.

Scope:

- Implement `options.isolation: "worktree"`.
- Create per-agent git worktree.
- Remove unchanged worktree automatically.
- Document cost and limits.

Tests:

- Worktree path differs from main cwd.
- Cleanup occurs for unchanged worktree.
- Changed worktree is preserved or handled according to documented policy.

Dependencies:

- Slice 7.1.

Spec coverage:

- §7 Runtime API.
- §9 Subagent Contract.

## Epic 8: Budget And Hardening

Goal: add production guardrails after the core behavior works.

### Slice 8.1: Budget Accounting

User value: workflows respect turn-level output-token budgets.

Scope:

- Add budget object with `total`, `spent()`, and `remaining()`.
- Share budget with child workflows.
- Throw on `agent()` once spent reaches total.

Tests:

- `remaining()` is `Infinity` when total is null.
- Throws after spent reaches total.
- Child workflow shares budget.

Dependencies:

- Slices 5.3 and 7.1.

Spec coverage:

- §7 Runtime API.
- §20 acceptance criterion 21.

### Slice 8.2: Failure Recovery And Atomic Persistence

User value: interrupted writes and process failures do not corrupt the read model.

Scope:

- Use atomic writes for run JSON.
- Tolerate partial journal trailing lines.
- Mark run failed on runtime exceptions.
- Add diagnostics for invalid run files.

Tests:

- Partial JSON file is ignored or reported.
- Partial journal line does not crash replay.
- Runtime exception marks run failed and writes failure.

Dependencies:

- Slices 3.4 and 4.2.

Spec coverage:

- §12 Persistence requirements.
- §13 Journal Model.

## Suggested Milestone Order

1. Milestone A: package/docs baseline.
   - Slices 0.0, 0.1, 0.2, 0.3.
2. Milestone B: read model and UI from fixtures.
   - Slices 1.1, 1.2, 1.3, 1.4.
3. Milestone C: fake runtime semantics.
   - Slices 2.1, 2.2, 2.3, 2.4.
4. Milestone D: first thin vertical workflow.
   - Slice 0.5.1, using minimal versions of its dependencies.
5. Milestone E: launch and persist richer fake workflows.
   - Slices 3.1, 3.2, 3.3, 3.4.
6. Milestone F: journal and resume.
   - Slices 4.1, 4.2, 4.3.
7. Milestone G: saved workflows and controls.
   - Slices 5.1, 5.2, 6.1, 6.2.
8. Milestone H: real Pi subagents and structured output.
   - Slices 7.1, 7.2, 7.3.
9. Milestone I: nested workflows, budget, and hardening.
   - Slices 5.3, 8.1, 8.2.

## Open Decisions

- How should saved-workflow listing/search be exposed in `/workflows` once the TUI exists?
- Should workflow run storage stay fully project-local under `.pi/workflows`, or should a later Pi-session integration add session-scoped storage on top of ADR 0005?
- Should terminal notifications use `pi.sendMessage()` custom messages, `pi.sendUserMessage()`, or both?
- How should `agentType` map to Pi concepts if Pi does not have Claude-style subagent types?
- What is the minimum structured-output protocol that works cleanly with Pi agents?
