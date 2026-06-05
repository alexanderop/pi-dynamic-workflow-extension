# 05: Spec-to-Code Map

Use this file to connect [`../../spec.md`](../../spec.md) to the current implementation.

## High-level map

| Spec area | Current implementation | Status |
|---|---|---|
| Workflow script format | [`../../src/workflows/script/parser.ts`](../../src/workflows/script/parser.ts) | Partially implemented. Literal `meta` and deterministic guards exist. |
| Runtime API | [`../../src/workflows/script/runtime.ts`](../../src/workflows/script/runtime.ts) | Partially implemented with fake agents. |
| `parallel()` | [`../../src/workflows/script/runtime.ts`](../../src/workflows/script/runtime.ts) | Implemented for pure runtime semantics. |
| `pipeline()` | [`../../src/workflows/script/runtime.ts`](../../src/workflows/script/runtime.ts) | Implemented for pure runtime semantics. |
| Scheduling | [`../../src/workflows/agent/scheduler.ts`](../../src/workflows/agent/scheduler.ts) | Implemented for fake agents. |
| Run state model | [`../../src/workflows/run/model.ts`](../../src/workflows/run/model.ts) | Partial/current read model. |
| State transitions | [`../../src/workflows/run/state-machine.ts`](../../src/workflows/run/state-machine.ts) | Implemented as pure functions. |
| Persistence/read model | [`../../src/workflows/run/store.ts`](../../src/workflows/run/store.ts) | Manifest read/write implemented. |
| Launcher | [`../../src/workflows/launch/launcher.ts`](../../src/workflows/launch/launcher.ts) | `launchWorkflow()` runs inline scripts, saved workflow names, and explicit script paths with fake agents. Not wired to any Pi command yet. |
| `/workflows` command | [`../../src/extension/index.ts`](../../src/extension/index.ts) | Non-interactive summary that lists existing manifests. Cannot launch runs. |
| Journal | [`../../src/workflows/journal/store.ts`](../../src/workflows/journal/store.ts) | JSONL audit/cache events implemented for fake agents. |
| Resume | [`../../src/workflows/launch/launcher.ts`](../../src/workflows/launch/launcher.ts) | Resume cache replay implemented for inline fake launches via `resumeFromRunId`. |
| Saved workflow launch | [`../../src/workflows/saved/resolver.ts`](../../src/workflows/saved/resolver.ts) | Name and path launch implemented for fake agents. |
| Output file | [`../../src/workflows/launch/launcher.ts`](../../src/workflows/launch/launcher.ts) | Terminal `output.json` written for completed/failed fake launches. |
| Completion notification | [`../../src/workflows/launch/launcher.ts`](../../src/workflows/launch/launcher.ts) | Testable notification hook implemented; Pi message wiring is future. |
| Real Pi subagents | Not built | Future. |
| Rich TUI monitor | Not built | Future. |

## Spec sections and current status

### §5 System Architecture

The spec names six components:

1. Launcher
2. Sandbox Runtime
3. Agent Scheduler
4. Persistence Layer
5. Workflow Controller
6. Notification Dispatcher

Current status:

| Component | Status |
|---|---|
| Launcher | `launchWorkflow()` ([`launcher.ts:78`](../../src/workflows/launch/launcher.ts)) exists for inline scripts only. It is not yet called by any extension command. |
| Sandbox Runtime | Node VM runtime exists ([`runtime.ts`](../../src/workflows/script/runtime.ts)), fake agents only. |
| Agent Scheduler | Fake-agent scheduler exists ([`scheduler.ts`](../../src/workflows/agent/scheduler.ts)). |
| Persistence Layer | Manifest store exists ([`run-store.ts`](../../src/workflows/run/store.ts)). Journals, output files, and transcript contents are future. The launcher creates an empty `transcripts/` directory, but nothing writes into it yet. |
| Workflow Controller | State machines exist as pure functions ([`state-machine.ts`](../../src/workflows/run/state-machine.ts)), but no controller calls them in response to user actions. |
| Notification Dispatcher | Not built. |

### §6 Workflow Script Format

Implemented in:

```text
src/workflows/script/parser.ts
```

The parser uses Acorn to walk the AST ([ADR 0002](../adr/0002-use-acorn-and-node-vm-for-first-workflow-runtime.md)).

Current support:

- `export const meta = { ... }` must be the first statement.
- `meta.name` is required and must be a non-empty string.
- `description`, `whenToUse`, and `phases` are supported optional fields.
- `meta` must be literal data: spreads, computed keys, getters/setters/methods, and dynamic expressions are rejected.
- Nondeterministic primitives in the body are rejected at parse time: `Date.now()`, `Math.random()`, and argument-less `new Date()` ([`parser.ts:153-178`](../../src/workflows/script/parser.ts)). These are also blocked again at runtime via deterministic `Date`/`Math` shims ([`runtime.ts:184-219`](../../src/workflows/script/runtime.ts)), so aliases like `const m = Math; m.random()` are caught even though they pass the parser.

Known gaps:

- Saved workflow loading by name is not implemented.
- Some static validation may become stricter as resume/journal work begins.

### §7 Runtime API

Implemented in:

```text
src/workflows/script/runtime.ts
```

Current globals:

```text
args
budget
phase
log
agent
parallel
pipeline
```

The `budget` global is real ([`runtime.ts:40-45`](../../src/workflows/script/runtime.ts)): `budget.total`, `budget.spent()`, and `budget.remaining()` all return values, where `spent()` accumulates an estimate of `(prompt.length + result.length) / 4` tokens after each fake `agent()` call ([`runtime.ts:51`, `:179-182`](../../src/workflows/script/runtime.ts)).

Known gaps:

- `workflow()` nested call is not implemented (it is not even exposed as a global).
- Budget tracking exists but there is no hard-ceiling enforcement: nothing rejects an `agent()` call when `spent()` reaches `total`.
- `agent({ schema })` does not validate real structured output yet.
- `agent({ isolation: "worktree" })` is accepted on `AgentOptions` but ignored by the scheduler and runtime.

### §8 Launch Contract

Implemented in:

```text
src/workflows/launch/launcher.ts
```

Current support:

- validates exactly one source
- supports inline `script`
- rejects `name` and `scriptPath` with typed unsupported errors
- allocates IDs
- writes initial manifest before execution
- starts background execution on deferred tick
- returns human-readable confirmation immediately

The confirmation string ([`launcher.ts:340-358`](../../src/workflows/launch/launcher.ts)) mentions notifications and live progress, but those features do not exist yet — it is placeholder copy.

Known gaps:

- `launchWorkflow()` is not yet wired to a Pi command or tool, so nothing in the extension currently launches a run. The `/workflows` command only lists existing manifests.
- Real Pi subagent execution is not implemented; launches use fake-agent runners.
- Pi message wiring for notifications is not implemented; the launcher exposes a testable notification hook.

### §9 Subagent Contract

Current support is fake only:

```text
src/workflows/agent/scheduler.ts
src/workflows/script/runtime.ts
```

The scheduler runs whatever `runner` callback it is given. The runtime supplies an `agentRunner` from `WorkflowRuntimeOptions`, defaulting to `defaultAgentRunner`, which simply returns the prompt string unchanged ([`runtime.ts:175-177`](../../src/workflows/script/runtime.ts)). Tests inject their own fake runners. Real Pi subagents are future work.

### §10 Scheduling

Implemented for fake agents in:

```text
src/workflows/agent/scheduler.ts
```

Current support:

- default concurrency calculation: `min(16, max(1, cpuCores - 2))` ([`scheduler.ts:185-187`](../../src/workflows/agent/scheduler.ts))
- concurrency override (`maxConcurrent`) and total-agent cap (`maxTotalAgents`), both validated as positive integers
- FIFO queue drained up to the concurrency cap
- `queued` / `running` / `done` / `failed` / `stopped` progress rows, exposed via `progress()`
- `stopAgent(agentId)` removes a queued agent or aborts a running one via `AbortController`

### §11 Pipeline Semantics

Implemented in:

```text
src/workflows/script/runtime.ts
```

Tests prove:

- later stages can start per item without global barriers
- more than two stages work
- stage callbacks receive previous result, original item, and index
- a throwing stage returns `null` for that item

### §12 Run State Model

Types live in:

```text
src/workflows/run/model.ts
```

Persistence lives in:

```text
src/workflows/run/store.ts
```

`WorkflowRunStatus` ([`types.ts:1-13`](../../src/workflows/run/model.ts)) is a 12-value union: `created`, `starting`, `running`, `pausing`, `paused`, `resuming`, `completing`, `completed`, `failing`, `failed`, `stopping`, `stopped`. This is a richer internal status set than the simple terminal statuses in the early spec section. [ADR 0003](../adr/0003-use-explicit-workflow-state-machines.md) explains why explicit state machines include intermediate states such as `starting`, `completing`, and `stopping`.

`run-store.ts` reads and writes one `manifest.json` per run at `<rootDir>/<runId>/manifest.json` ([`run-store.ts:143-149`](../../src/workflows/run/store.ts)). `listRuns()` returns runs newest-first, returns an empty list (not an error) when the root directory is missing, and silently skips manifests it cannot parse. It also normalizes a legacy "observed" manifest format for backward compatibility.

### §13-14 Journal and Resume

Not built yet.

Future files may include:

```text
src/workflows/journal.ts
src/workflows/resume.ts
```

### §15 Save Semantics

Partially built for launch/discovery. Save-run-script itself is still future
work.

Saved workflow lookup uses Pi-namespaced paths with Claude-like plain `.js` files:

```text
<project>/.pi/workflows/*.js
~/.pi/workflows/*.js
```

### §16 Control Operations

Pure state transitions exist in:

```text
src/workflows/run/state-machine.ts
```

`transitionRun()`, `transitionAgent()`, and their `canTransition*` / `replay*` helpers validate moves and return a `Result`. But these are pure functions only: no controller wires pause, resume, stop, or restart to a user action, and the scheduler never fires `agent_restarted`. The `pausing` / `paused` / `resuming` run states are reachable in the state machine but unused in practice.

### §17 Notification Contract

Not built yet.

Future implementation needs to notify the main conversation with status, result preview, output file path, failures, and usage.

### §18 Storage Layout

Accepted Pi mapping is documented in [ADR 0005](../adr/0005-use-project-local-pi-workflow-run-storage.md).

What `launchWorkflow()` actually creates today ([`launcher.ts:201-222`](../../src/workflows/launch/launcher.ts)):

```text
.pi/workflows/<runId>/
  manifest.json   # written by WorkflowRunStore (initial + final)
  script.js       # exact script source
  transcripts/    # directory is created but stays empty for now
```

Additional artifact paths:

```text
.pi/workflows/<runId>/journal.jsonl
.pi/workflows/<runId>/output.json
```

Saved workflows live outside per-run directories under `.pi/workflows/*.js`.

### §19 Security Requirements

Partially implemented:

- Workflow scripts run in `node:vm` with only the workflow globals exposed.
- `process` and `require` are not in the sandbox (a script that probes them sees `undefined`, confirmed by [`runtime.test.ts:41-52`](../../test/workflows/script/runtime.test.ts)).
- Deterministic primitives are blocked at parse time and again at runtime.
- The script runs with a 1000 ms VM timeout ([`runtime.ts:85`](../../src/workflows/script/runtime.ts)); long loops or heavy computation hit a generic timeout error.
- The fake scheduler enforces concurrency and total-agent caps.

Known limitation: Node VM is not treated as a complete security boundary. See [ADR 0002](../adr/0002-use-acorn-and-node-vm-for-first-workflow-runtime.md).

### §20 Acceptance Criteria

Many criteria are partially satisfied in fake-agent form. Use [`../backlog.md`](../backlog.md) for the slice-by-slice status.
