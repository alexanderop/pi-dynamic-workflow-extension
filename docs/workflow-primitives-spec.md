---
created: 2026-06-04
implemented: false
---

# Workflow Primitives Spec

## Status

Draft

## Summary

The current workflow runtime already has a strong minimal primitive set:

- `agent()`
- `parallel()`
- `pipeline()`
- `phase()`
- `log()`
- `args`
- `cwd`
- `budget`

This spec proposes adding a small number of new primitives only where they improve developer experience, saved workflow usability, reliability, and output quality.

The goal is not to turn workflow scripts into a large framework. The goal is to add the few primitives developers repeatedly need when writing real reusable workflows.

## Product motivation

Developers use workflows to coordinate larger AI tasks: audits, reviews, investigations, release checks, issue triage, documentation updates, and implementation plans.

The existing primitives are enough to orchestrate subagents, but three product gaps appear when workflows become reusable:

1. **Workflows need durable outputs.**  
   Developers need named artifacts they can export, share, attach to issues, or inspect later.

2. **Saved workflows need predictable inputs.**  
   Developers need a standard way to validate `args` and show useful errors before a workflow runs.

3. **Long-running workflows need basic resilience.**  
   Developers need common retry and timeout behavior without reimplementing it in every script.

## Non-goals

This spec does not propose:

- adding filesystem access to workflow scripts,
- adding network access to workflow scripts,
- replacing subagents with direct repository inspection,
- turning the VM into a general application runtime,
- adding many convenience helpers before real workflow examples prove the need.

Workflow scripts should remain deterministic orchestration scripts. Repository, file, shell, and network work should still be delegated to subagents.

## Proposed primitives

## 1. `artifact()`

### Purpose

Register a named workflow output that can be displayed, persisted, exported, and reused after the workflow completes.

### Motivation

Today, a workflow returns one final JSON-serializable result. That is useful, but real developer workflows often produce multiple outputs:

- a Markdown review report,
- JSON findings,
- a release checklist,
- an implementation plan,
- a test summary,
- a handoff document,
- agent transcript excerpts.

A first-class artifact primitive would make these outputs visible in the dashboard and exportable through future commands.

### Proposed API

```ts
declare function artifact(
  name: string,
  value: unknown,
  options?: ArtifactOptions,
): void

interface ArtifactOptions {
  type?: 'markdown' | 'json' | 'text'
  description?: string
}
```

### Example

```js
export const meta = {
  name: 'review_project',
  description: 'Review the project and produce shareable outputs',
  phases: [{ title: 'Review' }, { title: 'Report' }],
}

phase('Review')
const findings = await agent('Review the project and return findings as JSON.', {
  label: 'reviewer',
  schema: FINDINGS_SCHEMA,
})

phase('Report')
const report = await agent(
  'Turn these findings into a concise Markdown report:\n' +
    JSON.stringify(findings, null, 2),
  { label: 'reporter' },
)

artifact('findings.json', findings, {
  type: 'json',
  description: 'Structured review findings',
})

artifact('review.md', report, {
  type: 'markdown',
  description: 'Human-readable project review',
})

return {
  findingCount: findings.items.length,
  report: 'review.md',
}
```

### Runtime behavior

- `artifact()` may be called any time during a workflow run.
- Artifact names must be unique within a workflow run.
- Artifact values must be JSON-serializable.
- Artifact names should be safe relative names, not absolute paths.
- Artifacts should be included in the workflow snapshot.
- Artifacts should be persisted with the job where persistence is enabled.
- Artifacts should be available to future export commands.

### Validation rules

Invalid:

```js
artifact('../secret.txt', value)
artifact('/tmp/output.md', value)
artifact('review.md', cyclicObject)
artifact('review.md', first)
artifact('review.md', second)
```

Valid:

```js
artifact('review.md', markdown, { type: 'markdown' })
artifact('findings.json', findings, { type: 'json' })
artifact('summary.txt', summary, { type: 'text' })
```

### Dashboard impact

The `/workflows` dashboard should eventually show an Artifacts section:

```text
Artifacts
  review.md       markdown   Human-readable project review
  findings.json   json       Structured review findings
```

### Export impact

Future export commands can build on this primitive:

```text
/workflow-export <job-id> review.md
/workflow-export <job-id> findings.json
/workflow-export <job-id> --all
```

## 2. `validateArgs()`

### Purpose

Validate and normalize workflow input before the workflow starts meaningful work.

### Motivation

Saved workflows are registered as slash commands and receive trailing command text as `args`. Tool calls may also pass any JSON value as `args`.

Without a standard validation primitive, every workflow has to manually parse and validate input. That creates inconsistent errors and makes reusable workflows harder to trust.

### Proposed API

```ts
declare function validateArgs<T = unknown>(schema: JsonSchemaLike): T
```

The primitive validates the global `args` value against a JSON-schema-like object and returns the typed/validated value.

### Example: object args

```js
export const meta = {
  name: 'audit_target',
  description: 'Audit a target path with configurable depth',
}

const input = validateArgs({
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: {
    target: { type: 'string' },
    depth: { type: 'string', enum: ['quick', 'standard', 'deep'] },
  },
})

const depth = input.depth ?? 'standard'

phase('Audit')
const result = await agent(
  'Audit target ' + input.target + ' with depth ' + depth,
  { label: 'audit:' + input.target },
)

return { target: input.target, depth, result }
```

### Example: raw string args

```js
const input = validateArgs({ type: 'string', minLength: 1 })

phase('Review')
const review = await agent('Review this target: ' + input, {
  label: 'review:' + input,
})

return { target: input, review }
```

### Runtime behavior

- `validateArgs()` reads the workflow's global `args` value.
- If validation succeeds, it returns the validated value.
- If validation fails, the workflow fails before launching expensive agent work.
- Validation errors should be concise and user-facing.
- Validation should not mutate `args`.

### Error example

```text
Invalid workflow args for audit_target:
- target is required
- depth must be one of: quick, standard, deep
```

### Open question: defaults

Optional default handling could be included later:

```js
const input = validateArgs({
  type: 'object',
  properties: {
    depth: { type: 'string', enum: ['quick', 'deep'], default: 'quick' },
  },
})
```

For the first version, workflows can apply defaults manually after validation.

## 3. `retry()`

### Purpose

Run an async operation multiple times before failing.

### Motivation

Long workflows depend on multiple subagents. A single transient model/tool/runtime failure can fail the whole workflow. Developers often need basic retry behavior around individual `agent()` calls.

### Proposed API

```ts
declare function retry<T>(
  operation: () => Promise<T>,
  options?: RetryOptions,
): Promise<T>

interface RetryOptions {
  attempts?: number
  label?: string
}
```

### Example

```js
const findings = await retry(
  () => agent('Inspect the flaky test failure and return likely causes.', {
    label: 'inspect:flaky-test',
  }),
  { attempts: 2, label: 'retry flaky-test inspection' },
)
```

### Runtime behavior

- Default `attempts` should be `2`.
- `attempts` means total attempts, not retries after the first attempt.
- Failed attempts should be logged in the workflow dashboard.
- If all attempts fail, the final error should include attempt count and the last error.
- `retry()` must respect workflow cancellation.

### Important constraint

`retry()` should not hide deterministic programming errors. It is mainly for transient operations such as agent calls.

## 4. `withTimeout()`

### Purpose

Apply a per-operation timeout to async workflow work.

### Motivation

The workflow runtime may have a global timeout, but developers also need finer control over individual slow steps.

For example, a workflow may allow five minutes overall but only one minute for an optional summarization step.

### Proposed API

```ts
declare function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  options?: TimeoutOptions,
): Promise<T>

interface TimeoutOptions {
  label?: string
}
```

### Example

```js
const summary = await withTimeout(
  () => agent('Summarize the findings in one paragraph.', {
    label: 'summarize',
  }),
  60_000,
  { label: 'summary timeout' },
)
```

### Runtime behavior

- If the timeout expires, the operation fails with a clear timeout error.
- `withTimeout()` must respect workflow cancellation.
- For `agent()` calls, the timeout should abort the subagent call if possible.
- Like existing cancellation, this does not need to preempt CPU-bound JavaScript loops unless workflow execution later moves to a worker or child process.

## Recommended implementation order

## Phase 1: `artifact()`

Start with `artifact()` because it directly supports a major product gap: workflows need durable, shareable outputs.

Implementation should include:

- runtime primitive,
- JSON-serializability validation,
- snapshot support,
- persistence support,
- tests,
- TypeScript declaration in `types/workflow.d.ts`,
- basic README/docs update.

## Phase 2: `validateArgs()`

Add `validateArgs()` after artifact support so saved workflows become easier to use and safer to share.

Implementation should include:

- JSON-schema-like validation,
- clear user-facing errors,
- tests for string and object args,
- examples in workflow templates,
- TypeScript declaration.

## Phase 3: `retry()` and `withTimeout()`

Add resilience helpers after examples/templates reveal common failure patterns.

Implementation should include:

- cancellation-aware retry,
- per-operation timeout,
- dashboard log entries for failed attempts/timeouts,
- tests for cancellation and failure propagation.

## Compatibility

Adding these primitives should be backward-compatible. Existing workflows should continue to run unchanged.

The prompt guidelines should be updated carefully so agents do not overuse the new primitives. In particular:

- use `artifact()` when the workflow produces a meaningful durable output,
- use `validateArgs()` for saved/reusable workflows,
- use `retry()` only for transient operations,
- use `withTimeout()` for optional or bounded operations.

## Risks

### Primitive bloat

Adding too many helpers could make the runtime feel like a framework. This spec intentionally limits new primitives to product-backed needs.

### Artifact storage size

Artifacts could become large. The implementation should eventually support size limits and cleanup policies.

### Validation complexity

Full JSON Schema support may be too large for the initial version. A JSON-schema-like subset is sufficient if documented clearly.

### Retry misuse

Retries can increase cost and hide real failures. The dashboard should make retry attempts visible.

## Success criteria

The new primitives are successful if:

- workflow examples produce named Markdown/JSON artifacts,
- saved workflows fail early with clear argument errors,
- common transient agent failures can be retried without boilerplate,
- per-step timeout behavior is easy to express,
- existing workflows remain compatible,
- and the dashboard/export story becomes more useful to developers.

## Final recommendation

Add only one primitive immediately: `artifact()`.

Then add `validateArgs()` once saved workflow templates are being created.

Add `retry()` and `withTimeout()` later, after real workflows demonstrate repeated need for resilience helpers.
