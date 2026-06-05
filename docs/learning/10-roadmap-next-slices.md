# 10: Roadmap and Next Slices

This file is the plain-English version of [`../backlog.md`](../backlog.md). The backlog remains the source of truth for slice status.

## Current foundation

Already implemented in some form (file references point at the real code):

- Installable Pi package shell (`package.json` declares the extension; entrypoint `src/extension/index.ts`).
- `/workflows` command registered via `pi.registerCommand("workflows", ...)` that lists manifests (`src/extension/index.ts:11`).
- Project-local `.pi/workflows/<runId>/manifest.json` read model (`src/workflows/run-store.ts`).
- Workflow script parser: validates `export const meta = { ... }` as a pure literal, extracts the runnable body, and rejects `Date.now()`/`Math.random()`/argument-less `new Date()` for determinism (`src/workflows/parser.ts`).
- Node `vm` runtime kernel exposing limited globals — `args`, `budget`, `phase()`, `log()`, `agent()`, `parallel()`, `pipeline()` — with a 1000ms timeout (`src/workflows/runtime.ts`).
- Fake `agent()` calls drained through a concurrency-capped scheduler (`src/workflows/scheduler.ts`).
- `parallel()` and `pipeline()` semantics (`src/workflows/runtime.ts`).
- Explicit run/agent state machines with typed transitions (`src/workflows/state-machine.ts`).
- Inline launch with fake agents and final manifest persistence (`src/workflows/launcher.ts`), today only from an inline `script` source.

## Near-term gaps

### Terminal output and notification payload

Need:

```text
.pi/workflows/<runId>/output.json
```

and a final notification payload that points to the full output file.

Why:

- The main conversation should learn when a workflow completed or failed.
- Large results should be stored in a file, not dumped inline.

### Journal writer

Need:

```text
.pi/workflows/<runId>/journal.jsonl
```

Initial events:

- `started`
- `result`
- `failed`
- `stopped`
- `invalidated`

Why:

- Resume depends on an append-only record of completed agent calls.

### Stable agent keys

Need a deterministic key function for effective `agent()` calls.

The key should include at least:

- prompt
- schema
- label
- phase
- agent type
- model
- project cwd
- runtime/key version

Open question: exact serialization and hash preimage. This needs an ADR before implementation.

### Resume cache replay

Need to re-run scripts from the top and return cached agent results for completed keys.

Important behavior:

- `started` without `result` is incomplete and must rerun.
- Changing prompt/options should produce a new key.
- Resume is not a VM snapshot.

### Saved workflow discovery

Need project-local saved workflow loading from:

```text
.pi/workflows/scripts/<workflowName>.workflow.js
```

Future personal/global saved workflow resolution still needs a decision.

### Launch by script path (and by name)

Today `launchWorkflow()` accepts only an inline `script` source. The `scriptPath` and `name` fields are already part of `WorkflowLaunchRequest` and are validated, but both currently return a `WorkflowLaunchUnsupportedSourceError` (`src/workflows/launcher.ts:84`, `:185-198`).

Need to actually support:

```ts
launchWorkflow({ scriptPath });
```

The launcher should read, parse, copy, and execute that file. Launch-by-`name` (saved-workflow lookup) is the related gap covered under "Saved workflow discovery".

### Real Pi subagents

Need an adapter that replaces the fake `agentRunner` (the runner injected through `WorkflowRuntimeOptions`/`WorkflowLaunchOptions`) with real Pi agent sessions.

It must produce:

- transcript files
- metadata files
- progress updates
- token/tool counts
- structured output results

This is one of the largest future slices.

### Structured output validation

Need `agent({ schema })` to require and validate structured output.

Spec evidence says missing structured output should fail after bounded nudges. The observed count is two in-conversation nudges before failure (`spec.md:344`, `:653-654`).

This likely needs an ADR for retry/nudge policy.

### Rich `/workflows` TUI

Need custom TUI states from `spec.md` §23:

- State A: overview
- State B: structured agent detail
- State C: full prompt reader
- State D: workflow chooser

Implementation should split:

```text
read model
controller
view component
```

### Controls

Need controller operations:

- pause run
- resume run
- stop run
- stop agent
- restart agent
- save run script

What exists today vs. not:

- The state machine *defines* valid transitions for pausing/resuming/stopping a run and for restarting an agent (`src/workflows/state-machine.ts`), so the typed edges are ready.
- The scheduler can already stop a single agent via `stopAgent(agentId)` (`src/workflows/scheduler.ts:100`), but has **no** pause/resume method and **never** fires `agent_restarted` itself.
- Nothing wires any of these to a controller or to the `/workflows` UI yet. The pause/resume run states and the restart-agent path are currently dead code reachable only by calling the transition functions directly.

## Good next issue candidates

If a new developer wants a small task, start here:

1. Add output file persistence after inline fake workflow completion.
2. Add a `journal.jsonl` writer for fake agents.
3. Add a pure stable-key function with tests and ADR.
4. Add `scriptPath` launch support.
5. Add a richer `/workflows` text summary from existing manifest fields.
6. Add a pure view-model builder for the future TUI, without rendering yet.

## What not to jump into first

Avoid starting with:

- live model calls
- real Pi subagents
- fully interactive TUI
- pause/resume across real processes

Those are important, but the project is deliberately proving semantics through fake, deterministic, testable slices first.
