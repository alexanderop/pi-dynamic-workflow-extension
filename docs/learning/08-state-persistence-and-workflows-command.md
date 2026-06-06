# 08: State, Persistence, and `/workflows`

This file explains how persisted workflow state works today, and is careful to
mark what only exists on paper. Terms in this doc (run, manifest, transcript,
journal) are defined in [`glossary.md`](./glossary.md).

## Current storage root

Runs are stored under the current project:

```text
.pi/workflows/
```

The default root is derived from Pi command context. The `/workflows` handler
builds it from `ctx.cwd` (`src/extension/index.ts:14`):

```ts
join(ctx.cwd, ".pi", "workflows")
```

The launcher uses the same root when it writes runs.

ADR: [`0005-use-project-local-pi-workflow-run-storage.md`](../adr/0005-use-project-local-pi-workflow-run-storage.md).

## Current run directory shape

Each run gets one directory:

```text
.pi/workflows/<runId>/
  manifest.json
  script.js
  transcripts/
```

Current meanings:

| Path | Meaning |
|---|---|
| `manifest.json` | Durable run read model used by `/workflows` (written by `WorkflowRunStore`). |
| `script.js` | Exact workflow script copy for this run (written by the launcher). |
| `transcripts/` | Created empty by the launcher (`src/workflows/launch/launcher.ts:210`) but nothing writes into it yet — real subagent transcripts are future work. |

Additional paths from the storage layout in [`spec.md` §18](../../spec.md):

```text
.pi/workflows/<runId>/journal.jsonl    # resume/cache journal
.pi/workflows/<runId>/output.json      # full terminal result
<project>/.pi/workflows/*.js           # project saved workflows
~/.pi/workflows/*.js                   # personal saved workflows
```

## Manifest as read model

The manifest is the cheap overview state. `/workflows` must be able to render from manifest files alone.

This is important because future transcript directories can become large:

```text
transcripts/
  agent-<agentId>.jsonl
  agent-<agentId>.meta.json
  ...many more...
```

The overview should not parse those files.

## Current manifest fields

The current `WorkflowRunState` is defined in `src/workflows/run/model.ts:55` and
includes:

```ts
runId
taskId
workflowName
status
script
scriptPath
phases
logs
workflowProgress
agentCount
totalTokens
totalToolCalls
startTime
timestamp
durationMs
outputPath
result
failures
```

Everything from `runId` through `startTime` is required; `timestamp`,
`durationMs`, `outputPath`, `result`, and `failures` are optional and absent on
many runs. Note this is the real code shape: it does **not** carry the `summary`
or `defaultModel` fields that the reverse-engineered `spec.md` §12 lists — those
came from observed Claude Code artifacts and are not part of this project's type
yet.

## Writing state today

The launcher (`src/workflows/launch/launcher.ts`) writes state twice in the happy path:

1. Initial manifest with `status: "running"` before background execution starts
   (via `prepareRunFiles`, which also writes `script.js` and creates the empty
   `transcripts/` dir).
2. Final manifest after the runtime returns, with `status` transitioned to
   `completed` or `failed` plus `durationMs`, `timestamp`, and `result`.

There is no live progress yet: the implementation does **not** persist
intermediate phase/agent transitions while the workflow is running, so a
manifest read mid-run still shows `status: "running"` with empty
`workflowProgress`. Incremental persistence is future hardening.

## `WorkflowRunStore`

Implementation:

```text
src/workflows/run/store.ts
```

Main methods:

```ts
listRuns(): Promise<Result<WorkflowRunState[], WorkflowRunStoreError>>
readRun(runId): Promise<Result<WorkflowRunState, WorkflowRunStoreError>>
writeRun(state): Promise<Result<void, WorkflowRunWriteError>>
```

Each run lives at `<rootDir>/<runId>/manifest.json`, and `writeRun` saves it with
2-space indentation and a trailing newline (`src/workflows/run/store.ts:94`).

Behavior to know:

- A missing root directory (`ENOENT`) returns an empty `ok([])`, not an error.
- Invalid manifests are silently skipped during `listRuns()` — only successfully
  parsed runs come back.
- Reading a missing specific run via `readRun()` returns
  `WorkflowRunNotFoundError` (a tagged member of `WorkflowRunStoreError`).
- Runs are sorted newest first by `startTime`, then `runId`.
- The store can normalize an older exploratory "observed manifest" shape
  (`name`/`snapshot`/`startedAt`) into the canonical `WorkflowRunState`.

## `/workflows` command today

The command is registered in `src/extension/index.ts:11` and its handler just
lists runs (`store.listRuns()`) and formats them as text. It does **not** parse
arguments, filter, paginate, or open a TUI — that is all future work.

`formatWorkflowRun` (`src/extension/index.ts:68`) prints `runId`, `Status`,
`Workflow`, and `Agents` for every run, and adds a `Duration:` line only when
`durationMs` is set and an `Output:` line only when `outputPath` is set. Because
nothing populates `outputPath` today, the `Output:` line never appears for a real
run yet — it is shown below only to illustrate the format:

```text
Workflow runs

wf_new
  Status: completed
  Workflow: repo-audit
  Agents: 3
  Duration: 1m 12s

wf_old
  Status: running
  Workflow: old-review
  Agents: 1
```

Empty state (returned by `formatWorkflowRuns` when there are no runs):

```text
No workflow runs found in .pi/workflows.
```

## Mode-specific output

`emitWorkflowCommandOutput` (`src/extension/index.ts:31`) branches on the output
mode. The mode comes from `ctx.mode` when set, otherwise it falls back to `"tui"`
if `ctx.hasUI` is true and `"print"` if not.

| Pi mode | Current output behavior |
|---|---|
| `tui` | `ctx.ui.notify(message, type)` |
| `rpc` | `ctx.ui.notify(message, type)` (shares the `tui` branch) |
| `print` | plain text to stdout (`stderr` for errors) |
| `json` | one JSON line to stdout (`stderr` for errors) with `type: "workflow_command_output"` |

JSON example (the `severity` reflects the `info`/`error` output type):

```json
{"type":"workflow_command_output","command":"workflows","severity":"info","message":"..."}
```

## Future `/workflows` monitor (not built yet)

None of this exists in code today. The intended rich TUI has multiple states:

- workflow chooser
- phase overview
- structured agent detail
- full prompt reader

The normative UI reference is in [`spec.md` §24 (Workflow UI Reference
Screens)](../../spec.md). Until that TUI is built, the plain-text summary above
is the only thing `/workflows` renders, and it works in every mode.
