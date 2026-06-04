# ADR 0003: Use Explicit Workflow State Machines

Status: accepted

## Context

`spec.md` describes long-running workflow runs, queued subagents, pause/resume,
stop/restart controls, terminal notifications, journal replay, and a
`/workflows` progress UI. These behaviors are related, but they change state at
different lifetimes and for different reasons.

If run execution, agent execution, journal events, and UI navigation are modeled
as one implicit set of booleans, later slices will have ambiguous edge cases:
late agent results after stop, restarting failed agents, pausing while startup is
in flight, and whether completed runs can be mutated.

## Decision

Use explicit state machines for the durable workflow entities.

The run state machine is responsible for the lifecycle of one workflow run:

```text
                         +-----------+
                         |           v
created --> starting --> running --> pausing --> paused
                         ^                         |
                         |                         v
                         +------ resuming <--------+

running --> completing --> completed
running --> failing -----> failed

starting ----+
running -----+
pausing -----+--> stopping --> stopped
paused ------+
resuming ----+
completing --+
```

`completed`, `failed`, and `stopped` are terminal states. A terminal run must not
accept execution-state transitions. A failure request may move any
non-terminal run into `failing`; the diagram shows the main runtime failure path
from `running` rather than every possible recovery edge.

Each subagent progress row has its own smaller state machine:

```text
queued --> running --> done
   |         |
   |         +------> failed
   |                    |
   v                    v
stopped ------------> queued

failed -------------> queued
```

Restarting an agent creates a new attempt and a new `agentId`; the stable
journal key remains a separate concern for the journal slice.

Model `/workflows` UI navigation as a separate UI state machine when the custom
viewer is implemented. It should read `WorkflowRunState` and dispatch controller
actions, not execute workflow transitions directly.

Implement transition rules first as pure functions returning the local
`Result<T, E>` type. Persistence, scheduler, journal, and controller modules can
call these functions later instead of duplicating lifecycle checks.

Keep the lifecycle graph in declarative transition tables, then apply
event-specific field updates after an edge is validated. This follows the useful
part of XState's model without adding XState as a dependency: the graph is
auditable, the transition function remains pure, and callers can ask whether an
event is allowed before sending it.

Expose small helper APIs around the tables:

- `canTransitionRun` and `canTransitionAgent` for controllers and UI affordances.
- `replayRunEvents` and `replayAgentEvents` for journal validation, resume
  experiments, and path-style tests.

Unlike XState's common default of ignoring unhandled events, invalid workflow
events remain typed `WorkflowTransitionError` values. Dynamic workflow
controllers should fail visibly when lifecycle events arrive in the wrong state.

## Consequences

- Invalid lifecycle changes become typed errors instead of quiet state drift.
- Tests can lock down edge cases before filesystem persistence and live Pi
  subagents exist.
- The run JSON remains the cheap `/workflows` read model because agent progress
  rows carry their own state.
- Journal replay can later apply or validate events against the same transition
  rules.
- Some transitions are intentionally two-step, such as `running -> completing ->
  completed`, so future controllers have a place to persist intent before final
  output is written.
- The transition tables are now the source of truth for allowed edges; reducers
  are responsible only for timestamps, result payloads, failure lists, and agent
  attempt metadata.
