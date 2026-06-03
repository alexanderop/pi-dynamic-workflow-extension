---
created: 2026-06-03
implemented: false
---

# Spec: real usage-backed workflow budgets

## Summary

Replace the current workflow `budget` implementation, which estimates spend from serialized subagent results, with real Pi assistant-message usage aggregated from each subagent session.

The workflow runtime should expose `budget.spent`, `budget.max`, and `budget.remaining` as token-budget values backed by `AssistantMessage.usage.totalTokens`, while also exposing detailed usage and cost fields for reporting and dashboard display.

## Background

Pi assistant messages include provider usage metadata:

```ts
interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}
```

Pi SDK sessions expose completed messages through `session.messages` and events such as `message_end`, `turn_end`, and `agent_end`. That means workflow subagents can report real token/cost usage after `session.prompt(...)` finishes.

## Current behavior

`src/workflow.ts` currently tracks:

```ts
state.spent += estimateTokens(result, 'agent result')
```

This means:

- only the returned subagent result is counted,
- prompts are not counted,
- tool outputs are not counted,
- assistant thinking/output usage is not counted accurately,
- cost is not tracked,
- cached journal results do not have a usage story,
- parallel workflows can overshoot with no visibility,
- `quick workflow` only prompts for smaller budget behavior; it does not set a smaller runtime budget.

## Goals

1. Track real subagent usage from Pi `AssistantMessage.usage`.
2. Preserve the existing `budget.spent`, `budget.max`, and `budget.remaining` API for workflow scripts.
3. Add detailed usage/cost data to workflow runtime results and UI snapshots.
4. Enforce budget before starting new subagents and after subagents complete.
5. Make overshoot behavior explicit, especially for parallel runs.
6. Add tests for budget exposure, usage aggregation, enforcement, cached results, and parallel overshoot semantics.

## Non-goals

- Do not guarantee perfect hard pre-response token limiting. Provider usage is only known after a model response completes.
- Do not implement provider-level request cancellation mid-generation in v1.
- Do not require every custom/fake `WorkflowAgentLike` to provide usage.
- Do not remove `budget.spent/max/remaining`; keep compatibility.
- Do not change Pi core APIs.

## Terminology

- **Usage budget**: A max token count for total subagent assistant-message usage.
- **Usage**: Provider-reported `AssistantMessage.usage` from Pi.
- **Estimated usage**: Fallback token estimate when a custom agent returns no usage.
- **Budget overshoot**: The amount by which actual usage exceeds `budget.max` after an agent or parallel batch completes.

## Public API

### Workflow script `budget`

Keep existing fields:

```ts
declare const budget: {
  /** Total tokens spent so far. Prefer real provider usage; falls back to estimates only when unavailable. */
  spent: number

  /** Maximum workflow token budget. */
  max: number

  /** max - spent, clamped to zero. */
  remaining: number

  /** Detailed cumulative usage. */
  usage: WorkflowUsage
}
```

Add detailed usage:

```ts
interface WorkflowUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  estimatedTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}
```

Compatibility rule:

```ts
budget.spent === budget.usage.totalTokens + budget.usage.estimatedTokens
```

### Workflow result

Extend `WorkflowResult`:

```ts
interface WorkflowResult {
  meta: WorkflowMeta
  result: unknown
  phases: string[]
  logs: string[]
  agentCount: number

  /** Compatibility alias for budget.spent. */
  estimatedTokens: number

  /** Real and fallback usage accumulated across subagents. */
  usage: WorkflowUsage

  /** Configured usage budget. */
  maxTokens: number

  /** True if spent exceeded maxTokens after one or more agents completed. */
  budgetExceeded: boolean
}
```

`estimatedTokens` remains for compatibility but should be documented as a legacy alias for total budget spend, not purely result-size estimation.

### Agent runner options

Extend `WorkflowAgentRunOptions`:

```ts
interface WorkflowAgentRunOptions {
  label?: string
  schema?: unknown
  signal?: AbortSignal
  instructions?: string
  onActivity?: (...args) => void

  /** Called once after the subagent finishes, with real Pi usage when available. */
  onUsage?: (usage: WorkflowUsageDelta) => void
}
```

Define usage delta:

```ts
interface WorkflowUsageDelta {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  estimatedTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  source: 'pi_usage' | 'estimated_result' | 'cached'
}
```

## Implementation plan

### 1. Add usage types and helpers

Create or add to `src/workflow.ts`:

```ts
interface WorkflowUsage { ... }
interface WorkflowUsageDelta extends WorkflowUsage { source: ... }

function emptyWorkflowUsage(): WorkflowUsage
function addWorkflowUsage(target: WorkflowUsage, delta: WorkflowUsageDelta): void
function workflowUsageSpent(usage: WorkflowUsage): number
```

### 2. Capture real subagent usage in `WorkflowAgent`

In `src/agent.ts`, after `await session.prompt(...)`:

1. Walk `session.messages`.
2. Find assistant messages with a valid `usage` object.
3. Sum usage fields.
4. Call `options.onUsage?.({ ...usage, estimatedTokens: 0, source: 'pi_usage' })`.

Pseudo-code:

```ts
const usage = sumAssistantUsage(session.messages)
if (usage.totalTokens > 0) options.onUsage?.({ ...usage, estimatedTokens: 0, source: 'pi_usage' })
```

If no assistant usage is present, do not estimate here. Let `runWorkflow()` apply fallback estimation after receiving the result.

### 3. Update workflow state

Change runtime state:

```ts
interface RuntimeState {
  currentPhase?: string
  logs: string[]
  phases: string[]
  agentCount: number
  nextAgentId: number
  usage: WorkflowUsage
}
```

Replace `state.spent` with `workflowUsageSpent(state.usage)`.

### 4. Expose live budget getters

Update `budget` getters:

```ts
const getBudgetSpent = () => workflowUsageSpent(state.usage)
const getBudgetMax = () => maxEstimatedTokens
const getBudgetRemaining = () => Math.max(0, maxEstimatedTokens - workflowUsageSpent(state.usage))
const getBudgetUsage = () => deepReadonlyUsageSnapshot(state.usage)
```

`budget.usage` should return a frozen snapshot or frozen object with getters. Avoid exposing mutable state directly.

### 5. Enforce before agent start

Before scheduling an agent:

```ts
if (workflowUsageSpent(state.usage) >= maxEstimatedTokens) {
  throw new Error('workflow usage budget exceeded')
}
```

Keep the error text stable for tests.

### 6. Aggregate after agent completion

When `agentRunner.run(...)` completes:

- If `onUsage` supplied real usage, use it.
- If no usage was reported, estimate from the result and add:

```ts
{
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  estimatedTokens: estimateTokens(result, 'agent result'),
  cost: zeroCost,
  source: 'estimated_result',
}
```

After adding usage:

```ts
if (workflowUsageSpent(state.usage) > maxEstimatedTokens) {
  log(`workflow usage budget exceeded after ${label}: ${spent}/${maxEstimatedTokens}`)
}
```

Do not fail the completed agent retroactively in v1. Instead, prevent future agents from starting.

### 7. Cached journal results

Current journal records store only `result`.

Add optional usage to `WorkflowJournalResultRecord`:

```ts
interface WorkflowJournalResultRecord {
  type: 'result'
  key: string
  agentId: number
  result: unknown
  usage?: WorkflowUsageDelta
}
```

On cache hit:

- If `usage` exists, add it with `source: 'cached'` or preserve original source plus cached marker.
- If `usage` is missing, estimate from cached result for backward compatibility.

This ensures resumed workflows still respect budget as they replay cached branches.

### 8. Parallel overshoot semantics

Because `parallel()` schedules multiple thunks at once, usage can exceed budget before updates arrive.

V1 behavior:

- Check budget before each thunk calls `agent()`.
- Add usage as agents finish.
- Once budget is exceeded, subsequent not-yet-started agents should fail at the pre-start check.
- Already running agents are allowed to complete.
- The workflow result marks `budgetExceeded: true`.

Prompt/documentation should say:

> `budget.remaining` is updated after subagents finish. Parallel batches can overshoot; cap fan-out explicitly when budget matters.

### 9. Dashboard/reporting

Add usage fields to workflow snapshots and reports when available:

```ts
interface WorkflowSnapshot {
  usage?: WorkflowUsage
  maxTokens?: number
  budgetExceeded?: boolean
}

interface WorkflowAgentSnapshot {
  usage?: WorkflowUsageDelta
}
```

Display ideas:

- Header: `12.4k/80k tok · $0.04`
- Agent row: `2.1k tok · $0.01`
- Completion report: include total tokens and cost.

This can be a follow-up if core runtime behavior is implemented first.

### 10. Prompt/docs update

Update `src/prompts/workflow-tool.md`:

```ts
/** Usage budget for subagent model calls. Real provider usage when available; result-size estimate only as fallback. */
declare const budget: {
  spent: number
  max: number
  remaining: number
  usage: WorkflowUsage
}
```

Add warning:

> Budget usage is known after subagent responses complete. Parallel branches can overshoot; cap fan-out before calling `parallel()` when strict budget control matters.

Update README wording from “budget” to “usage budget” or “subagent usage budget”.

## Acceptance criteria

1. Workflow scripts can read `budget.spent`, `budget.max`, `budget.remaining`, and `budget.usage`.
2. `WorkflowAgent` aggregates real `AssistantMessage.usage` from subagent sessions.
3. `runWorkflow()` uses real usage when provided and result-size estimates only as fallback.
4. `runWorkflow()` rejects new `agent()` calls once spent is greater than or equal to `maxEstimatedTokens`.
5. `runWorkflow()` returns cumulative usage and `budgetExceeded`.
6. Journaled agent results persist usage and replay usage on resume.
7. Existing journals without usage still work via fallback estimation.
8. Tests cover real usage, fallback estimation, budget exposure, pre-start rejection, post-agent overshoot, cached usage, and old cached-result fallback.
9. Prompt/docs describe budget limitations honestly.

## Test plan

### Unit tests for usage helpers

- `emptyWorkflowUsage()` returns zeros.
- `addWorkflowUsage()` sums tokens and cost fields.
- `workflowUsageSpent()` returns `totalTokens + estimatedTokens`.

### `runWorkflow()` budget exposure

Script:

```js
export const meta = { name: 'budget_read', description: 'demo' }
const before = { spent: budget.spent, max: budget.max, remaining: budget.remaining }
const result = await agent('inspect')
const after = { spent: budget.spent, max: budget.max, remaining: budget.remaining }
return { before, after, result }
```

Assert `before.spent === 0`, `after.spent > 0`, and `after.remaining < before.remaining`.

### Real usage aggregation

Use a fake `WorkflowAgentLike` that calls `options.onUsage?.(...)` and returns a result.

Assert:

- `result.usage.totalTokens` equals supplied usage.
- `result.estimatedTokens` equals usage spend compatibility value.
- no fallback estimate is added when real usage exists.

### Fallback estimation

Use a fake agent that returns text but does not call `onUsage`.

Assert:

- `usage.estimatedTokens > 0`,
- `usage.totalTokens === 0`,
- `estimatedTokens === usage.estimatedTokens`.

### Pre-start rejection

Set `maxEstimatedTokens` lower than current spent after first agent.

Script calls two agents sequentially. First reports usage above max. Second should reject before running.

Assert second fake-agent call does not happen.

### Post-agent overshoot

Set max to `10`; first agent reports `20` tokens.

Assert:

- first agent completes,
- workflow result or subsequent failure marks/logs budget exceeded,
- future `agent()` calls reject.

### Journal usage replay

Run once with usage-producing fake agent and journal.
Run again with fake agent that would fail if called.

Assert:

- cached result is used,
- usage is replayed,
- budget fields reflect cached usage.

### Legacy journal fallback

Create old journal result record without `usage`.

Assert cached result still works and adds fallback estimated usage.

### Parallel overshoot

Run `parallel()` with multiple agents that each report usage.

Assert:

- already-started agents can complete,
- `budgetExceeded` becomes true when aggregate exceeds max,
- a later sequential agent rejects.

## Migration notes

- Existing workflow scripts using `budget.spent/max/remaining` continue to work.
- Existing saved workflows do not need changes.
- Existing journals remain readable; missing usage falls back to result-size estimates.
- Dashboard token counts become more meaningful after agents complete.

## Open questions

1. Should `maxEstimatedTokens` be renamed to `maxUsageTokens` while preserving the old option as an alias?
2. Should background workflow snapshots persist usage for completed jobs?
3. Should `quick workflow` set an actual smaller `maxEstimatedTokens`, or only prompt the model to use fewer agents?
4. Should over-budget after a completed agent fail the workflow immediately, or only block future agents? V1 recommends blocking future agents only.
5. Should cost budgets be supported separately from token budgets?
