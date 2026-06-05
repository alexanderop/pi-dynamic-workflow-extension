# Exercises

Use these exercises to learn the project by making small, reversible changes. Prefer adding tests first.

A reminder before you start: today every `agent()` call is served by a **fake agent runner**, not a real Pi subagent (see [glossary.md](./glossary.md)). The default runner just echoes the prompt back (`runtime.ts:175`), and tests inject their own fake runners. Journaling, resume, launch-by-name, launch-by-path, output files, terminal notifications, and the rich TUI are all still future work — these exercises only touch what exists today.

## Exercise 1: Trace one fake launch

Read:

- `src/workflows/launch/launcher.ts`
- `test/workflows/launch/launcher.test.ts`

Task:

Explain, in your own words, what happens from:

```ts
launchWorkflow({ script }, options)
```

to the final `manifest.json`.

Check yourself:

- Where is the script parsed? (`tryParseWorkflowScript`, before any files are written.)
- When is storage created, and what files land under `rootDir/<runId>/`? (`script.js` plus an initial `manifest.json`.)
- When does `launchWorkflow` return relative to when the workflow body actually runs? (Background execution is deferred via `defer()`, default `setImmediate`, so launch returns first.)
- When is the *final* manifest written, and what flips `status` from `running` to `completed` or `failed`? (`executeWorkflowInBackground` in `launcher.ts:250`.)

Note: `script`, `name`, and `scriptPath` sources are implemented for fake-agent launches. `name` resolves Pi-namespaced `.pi/workflows/*.js` saved workflows with Claude-like lookup behavior.

## Exercise 2: Add a parser rejection test

Read:

- `src/workflows/script/parser.ts`
- `test/workflows/script/parser.test.ts`

Task:

Add a test for one invalid `meta` shape that is not already covered.

Examples:

- accessor property
- method property
- non-string `meta.description`
- phase without string `title`

Expected result:

```bash
pnpm test test/workflows/script/parser.test.ts
```

passes.

## Exercise 3: Add one fake runtime script

Read:

- `src/workflows/script/runtime.ts`
- `test/workflows/script/runtime.test.ts`

Task:

Add a test workflow script that:

1. uses `args`
2. calls `phase()`
3. calls two fake agents through `parallel()`
4. returns a combined object

Check:

- result order is stable
- progress has two done agent rows

## Exercise 4: Break and fix `parallel()` usage

Read:

- `spec.md` §7 (Runtime API) and §11 (Pipeline Semantics) for the `parallel()`/`pipeline()` contract
- `spec.md` §10 (Scheduling) for the concurrency cap that explains *why* thunks are required
- `src/workflows/script/runtime.ts` (`parallel()` is at `runtime.ts:133`)

Task:

Write down why this is wrong:

```js
await parallel([agent("one"), agent("two")])
```

The array elements are already-invoked promises: `agent()` ran (and scheduled work) before `parallel()` could see it, bypassing the scheduler's concurrency cap. `parallel()` enforces this by rejecting any non-function element (`runtime.ts:135-138`).

Then write the correct form:

```js
await parallel([() => agent("one"), () => agent("two")])
```

Also note the swallowed-error behavior: a thunk that throws resolves to `null`, and `parallel()` itself never rejects (`runtime.ts:140-148`). The same is true per item/stage in `pipeline()` (`runtime.ts:160-172`).

## Exercise 5: Inspect `/workflows` output modes

Read:

- `src/extension/index.ts`
- `test/extension/index.test.ts`

Task:

The mode is resolved in `emitWorkflowCommandOutput` (`src/extension/index.ts:36`): `ctx.mode ?? (ctx.hasUI ? "tui" : "print")`. Both `tui` and `rpc` route to `ctx.ui.notify`; `json` and `print` write to stdout/stderr instead.

Add or modify a test that proves one mode-specific output behavior.

Examples:

- JSON mode writes parseable JSON to `process.stdout` (existing test at `test/extension/index.test.ts:131`).
- Print mode writes plain text to `process.stdout` and does not call `ctx.ui.notify`.
- TUI mode calls `ctx.ui.notify`.

## Exercise 6: Add a manifest field to the summary

Read:

- `src/workflows/run/model.ts`
- `src/extension/index.ts`
- `test/extension/index.test.ts`

Task:

The summary is built by `formatWorkflowRun` (`src/extension/index.ts:68`), which today shows `runId`, `Status`, `Workflow`, `Agents`, and optionally `Duration` and `Output`. Add one more safe field from `WorkflowRunState`, such as `totalToolCalls` or `totalTokens`.

Rules:

- Do not read transcript or journal files — the `/workflows` overview reads only `manifest.json` (locked by the test at `test/extension/index.test.ts:93`).
- Keep empty/zero values readable (`totalToolCalls` is always present and may be `0`).
- Add or update tests.

## Exercise 7: Add a failing fake agent path

Read:

- `src/workflows/agent/scheduler.ts`
- `test/workflows/agent/scheduler.test.ts`
- `test/workflows/launch/launcher.test.ts`

Task:

Add a test where a fake agent runner rejects and observe how the scheduler and launcher surface failure.

Check:

- The scheduler's `#run` catches the rejection, fires `agent_failed`, and rejects the `schedule()` promise, so the progress row becomes `failed` (`scheduler.ts:154-162`; existing example at `test/workflows/agent/scheduler.test.ts:82`).
- The launcher's final manifest becomes `failed` only when the rejection actually escapes the script body. `agent()` awaits `scheduler.schedule()` directly (`runtime.ts:50`), so a bare `await agent("x")` propagates the rejection, the runtime returns a `WorkflowRuntimeError`, and `executeWorkflowInBackground` transitions the run to `failed` (`launcher.ts:266-275`).
- Watch the gotcha: if the failing `agent()` call is wrapped in `parallel()` or `pipeline()`, the error is swallowed to `null` and the run still completes. The run only fails when the workflow lets the rejection bubble up.

## Exercise 8: Propose an ADR

Read:

- `docs/adr/README.md` (and an existing ADR such as `docs/adr/0005-use-project-local-pi-workflow-run-storage.md` for tone)
- `spec.md` §13 (Journal Model) and §14 (Resume Semantics)

Neither the journal nor resume exists in code yet — this is a design exercise. The spec describes keys of the form `v2:<sha256-hex>` derived from prompt, schema, label, phase, agentType, model, cwd, and a runtime-key version (spec.md §13). The random `agentId` is separate and is never used for resume.

Task:

Draft an ADR for stable journal key inputs.

Do not implement the key function yet. Focus on:

- what fields to include
- how to version the key
- what should invalidate cached results
- what remains an open question
