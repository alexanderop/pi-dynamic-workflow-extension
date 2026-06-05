# Glossary

## Agent runner

The callback behind `agent()`. The runtime accepts an optional `agentRunner` option (`src/workflows/script/runtime.ts:12`); when none is supplied it falls back to `defaultAgentRunner`, which simply echoes the prompt string back unchanged. In tests a fake runner is injected. Wiring a real Pi subagent session is future work (spec Epic 7).

## ADR

Architecture Decision Record. ADRs live in [`../adr/`](../adr/) and document Pi-specific implementation choices.

## Dynamic workflow

A JavaScript orchestration script that coordinates phases, logs, and subagents through a restricted host API.

## Fake agent

A test/development stand-in for a real subagent. Fake agents let us test scheduler/runtime/launcher behavior without model credentials.

## Journal

Append-only JSONL file **planned** at:

```text
.pi/workflows/<runId>/journal.jsonl
```

It would record `started`/`result`/`failed`/`stopped`/`invalidated` events to enable resume/cache replay of `agent()` calls (spec.md). Not implemented today: no journal is written or read.

## Manifest

The run read model stored at:

```text
.pi/workflows/<runId>/manifest.json
```

A `WorkflowRunState` serialized as JSON (`src/workflows/run/store.ts`). The `/workflows` command reads only manifests via `WorkflowRunStore.listRuns()`, without parsing transcripts or journals.

Note: This is distinct from the package manifest (the `pi` field in `package.json`), which declares extension entrypoints.

## Pi extension

Trusted TypeScript code loaded by Pi. This project's extension entrypoint is:

```text
src/extension/index.ts
```

## Pi package

A shareable package with a `pi` manifest in `package.json`. This project is a Pi package.

## Pipeline

A runtime global that moves each item through multiple async stages independently:

```js
await pipeline(items, stage1, stage2, stage3)
```

Stages receive `(previous, item, index)`. There is no global barrier between stages: item A can enter stage 2 before item B finishes stage 1. A failed item resolves to `null` rather than rejecting (`src/workflows/script/runtime.ts`).

## Run

One execution of one workflow script. `launchWorkflow()` (`src/workflows/launch/launcher.ts`) gives each run a `runId` and `taskId`, writes the exact `script.js`, creates an (empty) `transcripts/` directory, and persists a `manifest.json`. Journal, output file, and the contents of `transcripts/` are future work.

## Saved workflow

Reusable workflow JavaScript, separate from run results. It contains orchestration code, not manifests, journals, transcripts, or output.

## Scheduler

`WorkflowAgentScheduler` (`src/workflows/agent/scheduler.ts`). Queues `agent()` calls and enforces a single concurrency cap (default `min(16, max(1, cpuCores - 2))`) plus a `maxTotalAgents` hard ceiling. It drives each agent through the agent state machine (`queued → running → done | failed | stopped`) and exposes `progress()`.

## Spec

[`../../spec.md`](../../spec.md), the reverse-engineered specification for Claude-Code-like dynamic workflows.

## Subagent

An isolated agent session created by one `agent()` call. Real subagents are future work in this project.

## Transcript

Per-agent audit log. The launcher already creates the directory for every run, but nothing writes transcript files into it yet (fake agents produce no transcripts):

```text
.pi/workflows/<runId>/transcripts/
```

## Workflow controller

Future component responsible for pause, resume, stop, restart, and save operations. The run/agent state machines (`src/workflows/run/state-machine.ts`) already define the relevant transitions (e.g. `pausing`/`paused`/`resuming`), but nothing requests them yet — no API or UI action is wired to drive a run through them.

## Workflow read model

The data shape loaded by `/workflows`: `WorkflowRunState` (`src/workflows/run/model.ts`), read from each run's `manifest.json`. The current `/workflows` command formats this as plain text; a rich TUI viewer is future work.

## Workflow runtime

The restricted JavaScript execution kernel in:

```text
src/workflows/script/runtime.ts
```

It runs the script body inside a `node:vm` context (with a 1000 ms timeout) and exposes the globals `args`, `budget`, `phase`, `log`, `agent`, `parallel`, and `pipeline`. It also overrides `Date` and `Math` with deterministic shims that throw on `Date.now()`, argument-less `new Date()`, and `Math.random()`. `runWorkflowScript()` throws on failure; `tryRunWorkflowScript()` returns a `Result`.
