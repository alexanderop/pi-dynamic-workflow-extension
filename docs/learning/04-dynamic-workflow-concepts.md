# 04: Dynamic Workflow Concepts

This is the friendly version of the workflow model from [`../../spec.md`](../../spec.md).

## Workflow

A workflow is a JavaScript orchestration script.

Example shape:

```js
export const meta = {
  name: "repo-review",
  description: "Review the repo with fake agents",
  phases: [{ title: "Review" }, { title: "Verify" }],
}

phase("Review")
const review = await agent("Review src", { label: "review:src", phase: "Review" })

phase("Verify")
const verdict = await agent(`Verify ${review}`, { label: "verify:src", phase: "Verify" })

return { review, verdict }
```

The workflow script coordinates work. It should not directly read files, run shell commands, or call the network. Side effects should happen inside subagents.

## Run

A run is one execution of one workflow.

Each run has:

- `runId`
- `taskId`
- script copy
- manifest/read model
- future journal
- future output file
- future subagent transcripts

Current Pi storage shape (created by `launchWorkflow()` in `src/workflows/launch/launcher.ts`):

```text
.pi/workflows/<runId>/
  manifest.json    # WorkflowRunState read model, read by /workflows
  script.js        # exact script source
  transcripts/     # directory is created but stays empty today (no real subagents yet)
```

`manifest.json` is written twice: once at launch with empty progress (`status: "running"`), then again with the final state when the background run settles. Note that `launchWorkflow()` returns immediately; the run executes in the background via a deferred callback (`setImmediate` by default).

## Subagent

A subagent is a separate agent session started by one `agent()` call.

Future real subagents should have:

- their own prompt
- their own transcript
- their own metadata
- normal Pi tool permissions
- optional structured output validation

Today, subagents are fake. Tests inject a fake `agentRunner` that returns strings, objects, delays, or failures.

## Scheduler

The scheduler controls agent execution.

It should enforce:

- one global concurrency cap
- a total-agent cap
- FIFO queueing
- progress states

Current implementation:

```text
src/workflows/agent/scheduler.ts
```

The concurrency cap defaults to `min(16, max(1, cpuCores - 2))` (`scheduler.ts:185`), and there is a hard `maxTotalAgents` ceiling that makes `schedule()` reject once exceeded.

Agent progress states come from the agent state machine in `src/workflows/run/state-machine.ts:93`:

```text
queued  -> running   (agent_started)
queued  -> stopped   (agent_stopped)
running -> done      (agent_succeeded)
running -> failed    (agent_failed)
running -> stopped   (agent_stopped)
failed  -> queued    (agent_restarted)
stopped -> queued    (agent_restarted)
```

`done`, `failed`, and `stopped` are terminal, except that `failed`/`stopped` can be restarted back to `queued`. Note: the scheduler itself never fires `agent_restarted` today — restart is defined in the state machine but not wired into the scheduler.

## `parallel()`

`parallel()` accepts thunks, not already-started promises:

```js
await parallel([
  () => agent("one"),
  () => agent("two"),
])
```

This lets the scheduler see every `agent()` call and enforce the cap.

Important behavior:

- results are returned in input order
- a throwing thunk becomes `null`
- the `parallel()` call itself does not reject for a throwing thunk

## `pipeline()`

`pipeline()` moves each item through stages independently.

Correct mental model:

```text
item A: stage 1 -> stage 2 -> stage 3
item B: stage 1 -> stage 2 -> stage 3
item C: stage 1 -> stage 2 -> stage 3
```

There is no global barrier between stages. If item A finishes stage 1 before item B, item A can enter stage 2 immediately.

## Journal

The journal is the future append-only resume/cache log.

Expected future shape:

```text
.pi/workflows/<runId>/journal.jsonl
```

It will record events like:

- `started`
- `result`
- `failed`
- `stopped`
- `invalidated`

The stable journal key is based on the effective agent call, not the random agent id.

## Resume

Resume is not a VM snapshot.

The intended model is:

1. Re-run the workflow script from the top.
2. Compute the same stable key for every `agent()` call.
3. Return cached results when matching journal results exist.
4. Spawn only new or incomplete agents.

This is why workflow scripts must be deterministic.

## Saved workflow

A saved workflow is reusable orchestration JavaScript. It behaves like a
project-local prompt/command template that can be retriggered by name with new
arguments.

It should contain:

- `meta`
- workflow code

It should not contain:

- run manifests
- journals
- transcripts
- final results

Saved workflow paths use the Pi namespace with Claude-like plain `.js` files,
and are project/workspace-local only:

```text
<project>/.pi/workflows/*.js
```

## `/workflows`

`/workflows` is the user-facing monitor. It is a read-only Pi command registered in `src/extension/index.ts:11` via `pi.registerCommand("workflows", ...)`.

Current behavior:

- list runs by reading `manifest.json` files under `.pi/workflows` (`WorkflowRunStore.listRuns()`)
- show a plain-text summary (runId, status, workflow name, agent count, optional duration/output path)
- branch on output mode: `tui`/`rpc` notify through `ctx.ui.notify()`, while `json`/`print` write to stdout/stderr

It does not yet parse arguments, filter, paginate, or write/delete anything.

Future behavior:

- rich TUI monitor
- phases pane
- agents pane
- detail views
- pause/resume/stop/save controls
