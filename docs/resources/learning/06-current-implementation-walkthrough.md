# 06: Current Implementation Walkthrough

This is the recommended code reading path. It maps the modules that exist
**today** under `src/workflows/` and `src/extension/`, in dependency order.

Throughout, "fake" means the agent runner is a test/development stand-in (see
[`glossary.md`](./glossary.md)). No module here calls a real model or spawns a
real Pi subagent yet; that is future work tracked in
[`10-roadmap-next-slices.md`](./10-roadmap-next-slices.md).

## 1. Domain model files

Start here to learn the data model. The workflow package follows ADR 0007 and keeps models next to the module that owns the concept:

- `src/workflows/run/model.ts` — `WorkflowRunState`, `WorkflowRunStatus`, `WorkflowProgressEntry`, `WorkflowPhaseProgress`, `WorkflowFailure`.
- `src/workflows/agent/model.ts` — `AgentOptions`, `WorkflowAgentProgress`.
- `src/workflows/script/model.ts` — `WorkflowMeta`, `WorkflowPhase`, `WorkflowBudget`, `WorkflowRuntimeState`.
- `src/workflows/launch/model.ts` — launch requests/results/errors and terminal notification payloads.

The key idea: `WorkflowRunState` is the durable read model for `/workflows`. It should be cheap to load without reading journals or transcripts.

## 2. `src/workflows/result.ts`

This is the local Rust-style `Result<T, E>` helper.

Shape:

```ts
type Result<T, E> =
  | { status: "ok"; value: T }
  | { status: "error"; error: E };
```

Use it at module boundaries where failure is expected and recoverable.

The only constructors are `ok(value)` and `err(error)`; the only consumers are
`isOk`, `isErr`, `match`, `tryResult`, and `tryPromise`. There are no
`map`/`flatMap`/`getOrElse` helpers (`src/workflows/result.ts:1-53`).

Read also:

```text
../error-handling.md
```

## 3. `src/workflows/script/parser.ts`

This parses workflow scripts.

Responsibilities:

1. Parse JavaScript with Acorn.
2. Require `export const meta = { ... }` as the first statement.
3. Convert literal meta into `WorkflowMeta`.
4. Reject dynamic/non-literal meta.
5. Reject nondeterministic primitives in the body.
6. Return executable body with the meta export removed.

Example accepted shape:

```js
export const meta = { name: "inspect" }
return "done"
```

Example rejected shapes:

```js
const name = "inspect"
export const meta = { name }
```

```js
export const meta = { name: `inspect` }
```

```js
export const meta = { name: "clock" }
return Date.now()
```

Tests:

```text
test/workflows/script/parser.test.ts
```

## 4. `src/workflows/run/state-machine.ts`

This defines allowed run and agent lifecycle transitions.

Run lifecycle includes intermediate states:

```text
created -> starting -> running -> completing -> completed
running -> pausing -> paused -> resuming -> running
running -> failing -> failed
running -> stopping -> stopped
```

Agent lifecycle:

```text
queued -> running -> done
queued -> stopped
running -> failed
running -> stopped
failed/stopped -> queued
```

Important functions:

- `transitionRun`
- `transitionAgent`
- `canTransitionRun`
- `canTransitionAgent`
- `replayRunEvents`
- `replayAgentEvents`

Tests:

```text
test/workflows/run/state-machine.test.ts
```

ADR: [`0003-use-explicit-workflow-state-machines.md`](../../areas/adr/0003-use-explicit-workflow-state-machines.md).

Note: the state machine only validates and applies transitions
(`transitionRun`/`transitionAgent` return a `Result`). Nothing in this module
*drives* the lifecycle. The scheduler fires agent events, and the launcher fires
the `run_*` events; the pause/resume/stop edges exist but are not yet wired to
any caller or UI control (`src/workflows/run/state-machine.ts:44-110`).

## 5. `src/workflows/agent/scheduler.ts`

This queues and runs `agent()` calls. The scheduler is runner-agnostic: it is
given a `runner` callback and does not know whether that runner is fake or real.

Current responsibilities:

- enforce the concurrency cap (`maxConcurrent`, defaulting to
  `min(16, max(1, cpuCores - 2))`)
- enforce the total-agent cap (`maxTotalAgents`)
- queue agents FIFO and drain up to `maxConcurrent` at a time
- create progress rows (`WorkflowAgentProgress`) starting in state `queued`
- invoke the injected `runner` and record success/failure via the agent state
  machine
- stop queued or running agents through an `AbortController` (`stopAgent`)
- expose defensive-copy progress snapshots (`progress()`)

Important class:

```ts
WorkflowAgentScheduler
```

Important method:

```ts
scheduler.schedule(prompt, options)
```

The scheduler receives a runner:

```ts
type WorkflowAgentRunner = (request) => Promise<unknown>
```

Today every caller injects a **fake** runner (the runtime defaults to an
identity runner that echoes the prompt; tests inject their own). Later, this
should become an adapter around real Pi agent sessions
(`src/workflows/agent/scheduler.ts:65-122`, `185-187`).

Tests:

```text
test/workflows/agent/scheduler.test.ts
```

## 6. `src/workflows/script/runtime.ts`

This executes workflow JavaScript.

Responsibilities:

1. Parse script with `parseWorkflowScript`.
2. Create fake scheduler.
3. Build workflow globals.
4. Execute script body inside `node:vm`.
5. Capture phases, logs, agent calls, progress, and result.
6. Convert runtime failures to typed errors in `tryRunWorkflowScript`.

Current exposed globals:

```text
args
budget
phase
log
agent
parallel
pipeline
Date
Math
```

Determinism is enforced in **two** layers. The parser rejects literal
`Date.now()`, `Math.random()`, and argument-less `new Date()` at parse time
(`src/workflows/script/parser.ts`). The runtime then swaps `Date` and `Math` for wrapped
versions so the same calls still throw at execution time even when reached
through an alias:

```js
const Clock = Date
Clock.now() // throws at runtime
```

The script body runs inside `node:vm` with a 1000 ms timeout, wrapped in an
async IIFE so top-level `await` works (`src/workflows/script/runtime.ts:82-93`).

Tests:

```text
test/workflows/script/runtime.test.ts
```

## 7. `src/workflows/run/store.ts`

This reads and writes run manifests.

Responsibilities:

- list run directories
- read `.pi/workflows/<runId>/manifest.json`
- write manifests
- normalize current and older exploratory manifest shapes
- ignore invalid manifests during list operations
- return typed errors for read/write/not-found/invalid cases

Important class:

```ts
WorkflowRunStore
```

Important methods:

```ts
listRuns()
readRun(runId)
writeRun(state)
```

Tests:

```text
test/workflows/run/store.test.ts
```

## 8. `src/workflows/launch/launcher.ts`

This is the current vertical slice.

`launchWorkflow()` does this:

1. Validate exactly one source was provided.
2. Support inline `script` only.
3. Parse and validate script before creating storage.
4. Allocate `taskId` and `runId`.
5. Create run directory.
6. Write `script.js`.
7. Create `transcripts/`.
8. Write initial `manifest.json` with status `running`.
9. Start background runtime execution on a deferred tick.
10. Return launch confirmation immediately.
11. Persist final completed/failed manifest later.

Additional launch sources are implemented for fake-agent runs:

- `name` resolves Pi-namespaced saved workflows from `.pi/workflows/*.js` with Claude-like lookup behavior.
- `scriptPath` reads an explicit workflow file.
- `resumeFromRunId` builds a journal replay cache for inline fake launches.

The confirmation string points the user at `/workflows` to watch progress; it
does not yet send a terminal notification or write an output file.

Tests:

```text
test/workflows/launch/launcher.test.ts
```

## 9. `src/extension/index.ts`

This is the Pi integration layer.

Current `/workflows` behavior:

1. Root store at `ctx.cwd/.pi/workflows`.
2. List runs through `WorkflowRunStore` (read-only; the command takes no args).
3. Format a plain-text summary (run id, status, workflow name, agent count, and
   duration/output path when present).
4. Pick a mode via `ctx.mode ?? (ctx.hasUI ? "tui" : "print")`, then emit via
   `ctx.ui.notify` for `tui`/`rpc`, a JSON line on stdout/stderr for `json`, or
   plain text on stdout/stderr for `print` (`src/extension/index.ts:31-53`).

This is the only screen that exists today: a flat text list. The rich,
interactive `ctx.ui.custom()` TUI viewer described in the spec is future work.

Tests:

```text
test/extension/index.test.ts
```

## End-to-end fake flow

Current fake launch flow:

```text
launchWorkflow({ script })
  -> parseWorkflowScript(script)
  -> prepare .pi/workflows/<runId>/
  -> write initial manifest
  -> return confirmation
  -> runWorkflowScript(script)
    -> scheduler.schedule() for every agent()
    -> fake runner resolves
  -> merge runtime state into run state
  -> transition to completed/failed
  -> write final manifest
```

The background execution is deferred (via `setImmediate` by default), so
`launchWorkflow()` returns its confirmation before any agent runs; the returned
`completion` promise settles when the background work finishes.

That is enough to prove the architecture shape without real model calls. What is
deliberately absent: real Pi subagents, the journal and resume/replay, launch by
name or path, output files, terminal notifications, and any wired
pause/resume/stop controller or interactive TUI.
