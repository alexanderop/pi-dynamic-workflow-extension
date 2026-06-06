# Workflow Tool Contract Parity Spec

## Goal

Make Pi dynamic workflows match the pasted Claude Code `Workflow` tool contract closely enough that a model can use our `Workflow` tool with the same mental model, schema, DSL rules, runtime behavior, persistence flow, and resume semantics.

## 1. Model-facing tool contract

Register one model-facing tool:

```ts
name: "Workflow"
```

### Parameters

The tool schema MUST match the pasted contract:

- Object schema
- `additionalProperties: false`
- No required fields
- Fields:
  - `script?: string`
    - `maxLength: 524288`
    - self-contained workflow script
  - `scriptPath?: string`
    - path to existing workflow script
    - takes precedence over `script` and `name`
  - `name?: string`
    - saved/predefined workflow name
  - `resumeFromRunId?: string`
    - pattern: `^wf_[a-z0-9-]{6,}$`
  - `args?: unknown`
    - no JSON schema `type`; pass verbatim
  - `title?: string`
    - accepted but ignored
  - `description?: string`
    - accepted but ignored

### Source precedence

Runtime MUST choose source in this order:

```text
scriptPath > script > name
```

If none are supplied, reject with a clear tool error.

`title` and `description` MUST NOT affect workflow metadata. Real display metadata comes from `meta`.

## 2. Tool description parity

The `Workflow` tool description MUST include the same behavioral contract:

- Workflow orchestration is deterministic JavaScript.
- It runs in the background.
- It returns launch info immediately.
- `/workflows` shows live progress.
- Terminal completion arrives as a task notification.
- It is opt-in gated:
  - allowed for `ultracode`
  - “use a workflow”
  - active ultracode session
  - skill/policy explicitly instructing workflow use
- Default to `pipeline()`.
- Use `parallel()` only for true barriers.
- Scripts are JavaScript, not TypeScript.
- No filesystem/Node APIs.
- No nondeterministic time/random helpers.
- `args` passes through verbatim.

## 3. Script format

A workflow script MUST begin with:

```js
export const meta = {
  name: "workflow-name",
  description: "One-line description",
  phases: [{ title: "Phase" }],
}
```

### `meta` requirements

- `meta` MUST be the first statement.
- `meta` MUST be a pure object literal:
  - no variables
  - no function calls
  - no spreads
  - no computed keys
  - no template literals/interpolation
- Required:
  - `name`
  - `description`
- Optional:
  - `whenToUse`
  - `phases`
  - `model`
- `meta.phases[].title` MUST exactly match `phase(title)` strings.

## 4. Runtime DSL parity

The sandbox MUST expose exactly:

```ts
args
budget
agent()
parallel()
pipeline()
phase()
log()
workflow()
```

No `process`, `require`, filesystem, shell, network, or Node APIs.

### `agent(prompt, opts?)`

Options:

```ts
{
  label?: string
  phase?: string
  schema?: JsonSchema
  model?: string
  isolation?: "worktree"
  agentType?: string
}
```

Behavior:

- Without `schema`, resolves to final text.
- With `schema`, forces structured output and returns validated object.
- If skipped/stopped/dies after retries, resolves to `null`.
- All calls pass through one global scheduler.
- Lifetime cap: 1000 agents per run.
- Concurrency cap:

```ts
min(16, cpuCores - 2)
```

### `parallel(thunks)`

- Accepts only thunks: `() => Promise<T>`
- Runs concurrently.
- Is a barrier.
- Preserves input order.
- A throwing thunk resolves to `null`.
- `parallel()` itself does not reject because of child failures.
- Max items: 4096.

### `pipeline(items, ...stages)`

- No global barrier between stages.
- Each item flows independently through all stages.
- Stage signature:

```ts
(previousResult, originalItem, index)
```

- For the first stage, `previousResult === originalItem`.
- A throwing stage drops that item to `null`.
- Max items: 4096.
- This is the default multi-stage primitive.

### `phase(title)`

- Starts/groups progress under a phase.
- Phase title must match `meta.phases`.

### `log(message)`

- Adds a narrator/progress log line.

### `workflow(nameOrRef, args?)`

- Runs another workflow inline.
- One nesting level only.
- Shares:
  - scheduler/concurrency cap
  - agent counter
  - abort signal
  - token budget
  - journal/cache scope

## 5. Determinism parity

Scripts MUST reject or throw on:

```js
Date.now()
Math.random()
new Date()
```

argless `new Date()` only.

For closer Claude parity, also add a text-level validator that rejects literal substrings even inside prompts:

```text
Date.now
Math.random
new Date()
```

This should be documented as intentional compatibility behavior.

## 6. Budget contract

Expose:

```ts
budget = {
  total: number | null,
  spent(): number,
  remaining(): number,
}
```

Rules:

- `total` is `null` when unset.
- `remaining()` is `Infinity` when unset.
- If `spent() >= total`, new `agent()` calls MUST throw.
- Budget is shared across main turn + workflows where Pi can observe that.

## 7. Launch behavior

On launch:

1. Resolve source by precedence.
2. Parse and validate `meta`.
3. Reject invalid scripts before creating run storage.
4. Allocate:
   - `taskId`
   - `runId`
5. Persist script copy under run/session directory.
6. Create transcript directory.
7. Write initial `manifest.json`.
8. Start execution in background.
9. Return immediately with human-readable confirmation:

```text
Workflow launched in background. Task ID: ...
Run ID: wf_...
Script file: ...
Transcript dir: ...
You will be notified when it completes. Use /workflows to watch live progress.
```

## 8. Persistence contract

Every run MUST persist:

```text
.pi/workflows/<runId>/
  manifest.json
  script.js
  journal.jsonl
  output.json
  transcripts/
```

`manifest.json` MUST update during live runtime transitions, not just terminal state.

`output.json` MUST include:

- `runId`
- `taskId`
- `workflowName`
- `status`
- `result`
- `failures`
- `usage`
- `outputPath`

## 9. Resume contract

Resume via:

```ts
Workflow({
  scriptPath,
  resumeFromRunId,
})
```

Rules:

- Same-session only.
- Prior run should be stopped first.
- Replay journal from previous run.
- Completed unchanged `agent(prompt, opts)` calls return cached result instantly.
- Edited/new calls run live.
- Cache key is based on stable canonical `(prompt, opts)`.

## 10. Structured output parity

For `agent({ schema })`:

- Register/force a terminating structured-output tool in the subagent.
- Subagent must call it as final action.
- Validate result against JSON Schema.
- Return validated object.
- If no valid structured output is produced, fail or retry according to documented retry policy.
- Do not journal result until validation succeeds.

## 11. Ultracode integration

`ultracode` is NOT the tool name.

Behavior:

- User types:

```text
ultracode <goal>
```

- Extension turns on session policy.
- Input transforms to `<goal>`.
- `before_agent_start` injects workflow-authoring policy.
- Main model calls `Workflow`.
- Runs launched while policy is active use trigger source:

```ts
triggerSource: "ultracode"
```

## 12. Acceptance criteria

Parity is complete when:

1. Tool schema matches pasted schema structurally.
2. `Workflow` accepts `script`, `scriptPath`, `name`, `resumeFromRunId`, `args`, `title`, `description`.
3. Source precedence is `scriptPath > script > name`.
4. `title` and `description` are ignored.
5. `meta.name` and `meta.description` are required.
6. Pure literal `meta` validation rejects computed/dynamic metadata.
7. `pipeline()` is no-barrier.
8. `parallel()` is barrier and thunk-only.
9. Both enforce 4096 item cap.
10. Runtime enforces 1000-agent lifetime cap.
11. Runtime concurrency defaults to `min(16, cpuCores - 2)`.
12. Nondeterministic helpers are rejected.
13. `workflow()` nested call exists with one-level limit.
14. `agent({ schema })` returns validated structured output.
15. Every invocation persists script path and returns it.
16. Resume reuses unchanged agent results from journal.
17. Terminal notification contains task id, output file, status, result, failures, and usage.
18. `/workflows` shows live progress from manifest updates.
