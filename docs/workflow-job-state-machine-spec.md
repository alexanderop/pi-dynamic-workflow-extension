---
created: 2026-06-04
implemented: false
---

# Spec: Workflow Job State Machine

## Problem

Workflow jobs already behave like a finite state machine, but the state machine
is implicit. The public status type is a union:

```ts
export type WorkflowJobStatus = "running" | "done" | "error" | "cancelled" | "interrupted";
```

The transition rules are spread across `WorkflowManager.start()`,
`WorkflowManager.resume()`, `WorkflowManager.cancel()`,
`WorkflowManager.interrupt()`, `WorkflowManager.restoreJobs()`, and
`WorkflowManager.runJob()`.

That makes the lifecycle harder to understand and easier to regress:

- `start()` creates a new `running` job and persists it immediately.
- `resume()` mutates an existing non-running job back to `running`, clears
  terminal fields, resets the snapshot, and reuses the run id and journal.
- `cancel()` only acts on `running` jobs, sets `cancelled`, aborts the
  controller, persists, and relies on `runJob()` to finish settlement.
- `interrupt()` mirrors `cancel()`, but uses `interrupted` to distinguish
  session shutdown from user cancellation.
- `restoreJobs()` converts persisted `running` jobs to `interrupted`, because
  an old process cannot still be running.
- `runJob()` independently decides whether completion means `done`, `error`,
  `cancelled`, or `interrupted`, then stamps `finishedAt` in `finally`.

The behavior is currently tested, but the tests assert end results through the
manager. They do not directly test the transition contract. A future change can
still make an invalid transition accidentally, especially around cancellation,
interruption, restore, and resume.

## Current Behavior To Preserve

### Background start

The workflow tool starts background jobs through `manager.start()` when a shared
manager is provided. The tool returns immediately with a dashboard snapshot and
does not await `runWorkflow()`.

Observable contract:

- a new job receives a fresh numeric `id` and `wf_<uuid>` run id;
- the initial status is `running`;
- the script is saved when a store is attached;
- a journal is created under the run directory when a store is attached;
- listeners are notified through `touch()`.

### Normal completion

When `runWorkflow()` resolves and the script used at least one agent,
`runJob()` sets:

- `status = "done"`;
- `result = result.result`;
- success snapshot fields via `applyWorkflowSnapshotSuccess()`;
- `finishedAt = Date.now()`;
- persisted manifest and listeners via `touch()`.

If the workflow resolves without any `agent()` call, it is treated as an error.

### Failure

When `runWorkflow()` throws and the job has not already been cancelled or
interrupted, `runJob()` sets:

- `status = "error"`;
- `error` to the thrown message;
- failed running agents to `error`;
- `finishedAt`.

### User cancellation

`cancel(id)` is valid only while the job is `running`.

It currently performs an immediate visible transition to `cancelled`, aborts the
controller, persists the job, and returns `true`. When the aborted workflow
settles, `runJob()` keeps the status as `cancelled`, writes
`"Workflow was cancelled"` to `job.error`, marks running/queued agents as
`skipped`, and stamps `finishedAt`.

Calling `cancel(id)` for `done`, `error`, `cancelled`, or `interrupted` jobs
returns `false`.

### Session interruption

`interrupt(id)` is valid only while the job is `running`.

It immediately moves the job to `interrupted`, aborts the controller, persists
the job, and returns `true`. When the aborted workflow settles, `runJob()` keeps
or restores the status as `interrupted`, writes `"Workflow was interrupted"` to
`job.error`, marks running/queued agents as `skipped`, and stamps `finishedAt`.

`session_shutdown` calls `manager.interruptAll()`. Main-agent aborts must not
interrupt background workflows.

### Store restore

When a store is attached, `WorkflowManager` loads persisted manifests. Already
known run ids are skipped.

Persisted jobs keep their stored terminal status except for `running`, which is
converted to `interrupted` and saved back to disk. This is important because a
persisted `running` job represents a previous process that disappeared.

### Resume

`resume(id)` returns `undefined` for missing jobs.

For an already `running` job, it returns that job and does not start another
run.

For any other status, it:

- reparses the stored script;
- updates `name` and `description` from the script metadata;
- keeps existing args unless new args are provided;
- sets `status = "running"`;
- clears `error`, `result`, and `finishedAt`;
- resets `startedAt`, `snapshot`, and the abort controller;
- saves the script again when a store exists;
- runs with the existing run id and journal.

The dashboard blocks resume for `running` and `done` jobs, but
`/workflow-resume` currently delegates directly to `manager.resume()`, which
means the manager is the real contract boundary.

### Notifications and footer status

The extension listens to manager changes after `session_start`.

On each change it:

- records run ids that were observed in `running` state during the current
  session;
- updates the footer from the count of `running` jobs;
- sends one `workflow-completion` message for current-session jobs that settle
  to `done`, `error`, or `cancelled`.

It intentionally does not announce `running`, `interrupted`, restored old runs,
or runs already recorded as notified in session history.

## Why A State Machine Helps

The job lifecycle is small and finite, but the rules are important product
semantics:

- `interrupted` means "the session/process stopped it", not "the user cancelled
  it".
- restored `running` jobs must become `interrupted`.
- terminal jobs should not be cancellable or interruptible.
- a cancelled job must not later become `interrupted` just because its abort
  signal is set.
- a successful run must not overwrite a prior user cancellation.
- completion notifications depend on terminal status and must remain once-only.

An explicit transition table makes these rules reviewable in one place and
directly testable without launching workflows, Pi extension harnesses, or the
TUI.

## Proposed Solution

Add a small internal state module. Do not add a production dependency for the
first pass.

Recommended file:

```text
src/workflow-job-state.ts
```

Use XState as API inspiration, but not as an implementation dependency. The
useful design ideas are:

- describe the machine with a plain object instead of scattered `if` branches;
- keep events as objects with a `type` field;
- keep transition resolution pure and separate from effects;
- expose `can...` helpers so callers can ask whether an event is valid before
  mutating anything;
- keep side effects at the actor/manager layer, not in the transition table.

Recommended exports:

```ts
import type { WorkflowJobStatus } from "./workflow-manager.js";

export type WorkflowJobEvent =
  | { type: "start" }
  | { type: "resume" }
  | { type: "complete" }
  | { type: "fail" }
  | { type: "cancel" }
  | { type: "interrupt" }
  | { type: "restore" };

export function transitionWorkflowJobStatus(
  status: WorkflowJobStatus | undefined,
  event: WorkflowJobEvent,
): WorkflowJobStatus;
```

Recommended internal config shape:

```ts
const workflowJobMachine = {
  id: "workflowJob",
  initial: "running",
  states: {
    running: {
      on: {
        complete: "done",
        fail: "error",
        cancel: "cancelled",
        interrupt: "interrupted",
        restore: "interrupted",
      },
    },
    done: {
      on: {
        resume: "running",
        restore: "done",
      },
    },
    error: {
      on: {
        resume: "running",
        restore: "error",
      },
    },
    cancelled: {
      on: {
        resume: "running",
        restore: "cancelled",
      },
    },
    interrupted: {
      on: {
        resume: "running",
        restore: "interrupted",
      },
    },
  },
} as const;
```

The function should be pure. It should not mutate jobs, abort controllers, write
snapshots, persist manifests, notify listeners, or know about Pi. It should only
decide whether a status transition is valid and what the next status is.

Use explicit errors for programmer mistakes. The manager can still expose the
same user-facing behavior by checking whether an operation is allowed before
calling the transition helper.

### API Inspiration From XState

XState's public API centers on machine logic created from declarative
configuration. A small machine usually reads as:

```ts
const machine = createMachine({
  id: "light",
  initial: "green",
  states: {
    green: { on: { timer: "yellow" } },
    yellow: { on: { timer: "red" } },
    red: { on: { timer: "green" } },
  },
});
```

The API value is not the library machinery. The value is that the lifecycle is
visible as data:

- `id` names the lifecycle being modeled;
- `initial` documents where new instances begin;
- `states` names every possible state;
- each state's `on` block shows which events are allowed from that state;
- event names are verbs, status names are nouns/adjectives;
- pure transition functions can be tested independently from side effects.

For this package, copy that shape conceptually:

```ts
export const workflowJobStateConfig = {
  id: "workflowJob",
  initial: "running",
  states: {
    running: {
      on: {
        complete: "done",
        fail: "error",
        cancel: "cancelled",
        interrupt: "interrupted",
        restore: "interrupted",
      },
    },
    interrupted: {
      on: {
        resume: "running",
        restore: "interrupted",
      },
    },
    // ...
  },
} as const;
```

Then expose a smaller, domain-specific API instead of a generic state-machine
engine:

```ts
export function getInitialWorkflowJobStatus(): WorkflowJobStatus {
  return workflowJobStateConfig.initial;
}

export function transitionWorkflowJobStatus(
  status: WorkflowJobStatus,
  event: WorkflowJobEvent,
): WorkflowJobStatus {
  // Look up status + event.type in workflowJobStateConfig.states.
}

export function canTransitionWorkflowJobStatus(
  status: WorkflowJobStatus,
  event: WorkflowJobEvent,
): boolean {
  // Same lookup, no throw.
}
```

This keeps the code easy to read in the same way an XState config is easy to
read, while avoiding generic actors, snapshots, actions, guards, nested states,
and invoked services that this lifecycle does not need.

The `@xstate/store` package reinforces another useful idea: for simpler
event-based state, callers should be able to check whether an event is allowed
without applying it. Mirror that with helpers such as:

```ts
export function canCancelWorkflowJob(status: WorkflowJobStatus): boolean;
export function canInterruptWorkflowJob(status: WorkflowJobStatus): boolean;
export function canResumeWorkflowJob(status: WorkflowJobStatus): boolean;
```

Those helpers let `WorkflowManager` preserve its current boolean-returning
operations:

```ts
cancel(id): boolean {
  const job = this.jobs.find((item) => item.id === id);
  if (!job || !canCancelWorkflowJob(job.status)) return false;
  job.status = transitionWorkflowJobStatus(job.status, { type: "cancel" });
  job.controller.abort();
  this.touch(job);
  return true;
}
```

## Transition Table

Initial creation:

| From | Event | To | Notes |
| --- | --- | --- | --- |
| `undefined` | `start` | `running` | New jobs only. |

Running transitions:

| From | Event | To | Notes |
| --- | --- | --- | --- |
| `running` | `complete` | `done` | Only after `agentCount > 0`. |
| `running` | `fail` | `error` | Non-abort runtime failure. |
| `running` | `cancel` | `cancelled` | User intent. |
| `running` | `interrupt` | `interrupted` | Session/process shutdown. |
| `running` | `restore` | `interrupted` | Persisted process is gone. |

Resume transitions:

| From | Event | To | Notes |
| --- | --- | --- | --- |
| `error` | `resume` | `running` | Reuse script, args, run id, journal. |
| `cancelled` | `resume` | `running` | Current manager allows this. |
| `interrupted` | `resume` | `running` | Primary resume path. |
| `done` | `resume` | `running` | Current manager allows this through `/workflow-resume`; dashboard prefers rerun. |

No-op or rejected transitions:

| From | Event | Behavior |
| --- | --- | --- |
| `running` + `resume` | no-op, return existing job at manager level |
| terminal + `cancel` | invalid for `cancel()`, return `false` |
| terminal + `interrupt` | invalid for `interrupt()`, return `false` |
| terminal + `complete` | programmer error |
| terminal + `fail` | programmer error |
| terminal + `restore` | keep stored terminal status |

The first implementation should preserve the current permissive manager resume
contract. A later product decision can narrow resume to only `error`,
`cancelled`, and `interrupted`, but that would be a behavior change and should
update `/workflow-resume`, dashboard copy, README, and tests together.

## Refactor Plan

1. Add `src/workflow-job-state.ts` with the pure transition function and
   predicate helpers such as `canCancelWorkflowJob(status)` and
   `canResumeWorkflowJob(status)`.
2. Add focused table-driven tests in `tests/workflow-job-state.test.ts`.
3. Update `WorkflowManager.start()` to use the initial `start` transition.
4. Update `cancel()` and `interrupt()` to use `canCancelWorkflowJob()` /
   `canInterruptWorkflowJob()` before mutating, preserving current boolean
   return values.
5. Update `resume()` to use `canResumeWorkflowJob()` and the `resume`
   transition while preserving the current running-job no-op.
6. Update `restoreJobs()` to use the `restore` transition instead of inline
   `job.status === "running" ? "interrupted" : job.status`.
7. Update `runJob()` to choose terminal status through events:
   `complete`, `fail`, `cancel`, or `interrupt`.
8. Keep all side effects in `WorkflowManager`: timestamps, snapshot changes,
   aborting, persistence, and listener notifications stay out of the state
   module.

## Testing Plan

Add pure state tests first:

- `undefined + start -> running`
- `running + complete -> done`
- `running + fail -> error`
- `running + cancel -> cancelled`
- `running + interrupt -> interrupted`
- `running + restore -> interrupted`
- `done/error/cancelled/interrupted + restore` keeps the same status
- `error/cancelled/interrupted/done + resume -> running`
- terminal jobs cannot be cancelled or interrupted
- invalid terminal completion/failure throws

Keep and expand manager tests:

- cancellation still settles with `status = "cancelled"`,
  `"Workflow was cancelled"`, `finishedAt`, and no running/queued agents;
- interruption still settles with `status = "interrupted"`,
  `"Workflow was interrupted"`, `finishedAt`, and no running/queued agents;
- restored persisted `running` manifests are rewritten to `interrupted`;
- resuming a restored job reuses the journal and does not call the agent again
  for cached work;
- `/workflow-resume` behavior remains consistent with the manager contract;
- completion messages are still sent exactly once for `done`, `error`, and
  `cancelled`, and not for `interrupted`.

## Library Decision

Do not add `xstate`, `robot3`, or another state-machine dependency for this
refactor.

Reasoning:

- The current lifecycle has five states and a small event set.
- There are no nested states, parallel machine regions, invoked actors, or
  visual modeling needs at the job-status boundary.
- This package intentionally avoids production dependencies unless they earn
  their runtime and installation cost.
- A pure transition table gives the main benefits: readability, exhaustive
  tests, and a single lifecycle contract.

Reconsider `xstate` only if workflow jobs grow nested lifecycle state, such as
separate persisted process state, scheduler state, retry/backoff state,
human-input waits, or child job actors. Reconsider `robot3` if the project wants
a tiny dependency for declarative transitions but still does not need XState's
actor/statechart model.

## Non-goals

- Do not model the entire workflow script runtime as a finite state machine.
  `agent()`, `parallel()`, `pipeline()`, artifacts, budget tracking, and journal
  replay are execution events and data flow, not one clean job status lifecycle.
- Do not change persistence paths or manifest schema beyond preserving valid
  statuses.
- Do not change cancellation, interruption, resume, or notification behavior in
  the first implementation.
- Do not add visual statechart tooling.

## Acceptance Criteria

- The workflow job status transition rules live in one pure module.
- The transition table is covered by focused unit tests.
- Existing manager, extension lifecycle, browser, and persistence tests pass.
- `interrupted` and `cancelled` remain distinct in persisted jobs, dashboard
  rendering, completion behavior, and final errors.
- Completion notifications are still sent once and only for current-session
  terminal jobs that should be announced.
- No new production dependency is added.
