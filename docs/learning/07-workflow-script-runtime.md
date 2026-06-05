# 07: Workflow Script Runtime

This file explains how workflow JavaScript is parsed and executed today.

Two source files do the work:

- [`src/workflows/script/parser.ts`](../../src/workflows/script/parser.ts) extracts `meta`, strips it from the body, and rejects nondeterministic calls.
- [`src/workflows/script/runtime.ts`](../../src/workflows/script/runtime.ts) runs the remaining body inside a `node:vm` context that exposes the workflow globals.

## Script shape

Every script must start with literal metadata:

```js
export const meta = {
  name: "demo",
  description: "A tiny fake workflow",
  phases: [{ title: "Scan" }],
}

phase("Scan")
log("starting")
const result = await agent("Scan the repo", { label: "scan", phase: "Scan" })
return { result }
```

The parser requires `export const meta = { ... }` to be the **first statement** (`parser.ts:25-28`), then removes it from the source before runtime execution (`parser.ts:33`). The remaining body runs inside an async wrapper: the runtime wraps it as `(async () => { ...body... })()` (`runtime.ts:83`), which is why top-level `await` and top-level `return` work.

## Metadata rules

Accepted metadata values are plain literals (`literalValue` in `parser.ts:69-85`):

- object literals
- arrays
- strings
- numbers
- booleans
- `null`

Only `name` (required, non-empty string), `description`, `whenToUse`, and `phases` are kept by `validateWorkflowMeta` (`parser.ts:114-127`); any other keys you put in `meta` are parsed but dropped. Object spreads, computed keys, and getters/setters/methods are rejected (`parser.ts:91-99`).

Rejected metadata examples:

```js
const workflowName = "demo"
export const meta = { name: workflowName }
```

```js
export const meta = { name: buildName() }
```

```js
export const meta = { ...baseMeta, name: "demo" }
```

```js
export const meta = { name: `demo` }
```

## Determinism rules

These are forbidden in workflow scripts:

```js
Date.now()
Math.random()
new Date() // argument-less only; new Date(args.startedAt) is allowed
```

This is enforced in **two** places, so neither a direct call nor an alias slips through:

- **Parse time:** `assertDeterministic` walks the script body's AST and rejects literal `Date.now()`, `Math.random()`, and argument-less `new Date()` calls (`parser.ts:153-178`).
- **Run time:** the VM context swaps in deterministic `Date` and `Math` objects whose `now`/`random` throw, so aliases like `const m = Math; m.random()` still fail (`runtime.ts:184-219`, proven by `test/workflows/script/runtime.test.ts:54-78`).

Why forbid them? Resume (a future slice — not implemented yet) will re-run the script from the top and compute a stable key for each `agent()` call. Randomness or implicit current time would change the call sequence or key inputs, breaking the cache.

If a workflow needs time, pass it through `args`:

```js
export const meta = { name: "timestamped" }
return args.startedAt
```

## Exposed globals

Current runtime globals:

| Global | Purpose |
|---|---|
| `args` | Invocation input (`options.args`, typed `unknown`). |
| `budget` | `{ total, spent(), remaining() }`. `spent()` reports estimated tokens; `remaining()` computes against `total`. See caveat below. |
| `phase(title)` | Add a phase progress row (throws on empty/non-string title). |
| `log(message)` | Add a run log (coerces to `String(message)`). |
| `agent(prompt, options)` | Schedule one agent through the scheduler; runner is fake today. |
| `parallel(thunks)` | Run promise thunks concurrently and return ordered results. |
| `pipeline(items, ...stages)` | Run each item through async stages independently. |

`budget.spent()` and `budget.remaining()` do compute (`runtime.ts:40-45`), but two things are missing today: token spend is only an **estimate** — `(prompt.length + result.length) / 4`, rounded up (`runtime.ts:179-182`) — and there is **no enforcement**: exceeding `budget.total` does not reject an `agent()` call. Also note `spent()` only counts tokens from *already-resolved* agent calls, so reading it mid-call sees a stale total.

Not implemented yet:

| Global/feature | Status |
|---|---|
| `workflow()` | Future nested workflow support. |
| real `agent()` subagents | Future Pi agent-session adapter. |
| `agent({ schema })` validation | Future structured output slice. |
| `agent({ isolation: "worktree" })` | Future worktree isolation slice. |

## Fake `agent()` today

Today, `agent()` pushes to `agentCalls`, then calls the scheduler (`WorkflowAgentScheduler`), which calls a runner. There are no real Pi subagents yet — that adapter is future work. If you do not inject a runner, the default just returns the prompt unchanged (`defaultAgentRunner`, `runtime.ts:175-177`).

Example test-style usage that injects a fake runner:

```ts
const state = await runWorkflowScript(script, {
  agentRunner: async (prompt) => `fake:${prompt}`,
});
```

Inside the workflow:

```js
const result = await agent("Scan src")
```

The fake result becomes:

```text
fake:Scan src
```

## `parallel()` correctly

Use thunks:

```js
const results = await parallel([
  () => agent("first"),
  () => agent("second"),
  () => agent("third"),
])
```

Do not pass already-started promises:

```js
// Wrong
const results = await parallel([
  agent("first"),
  agent("second"),
])
```

The wrong form starts agents before `parallel()` can validate/control them.

## `pipeline()` correctly

Example:

```js
const results = await pipeline(
  ["src", "test"],
  async (_previous, item, index) => {
    return await agent(`Review ${item}`, { label: `review:${index}` })
  },
  async (review, item) => {
    return await agent(`Verify ${item}: ${review}`, { label: `verify:${item}` })
  },
)
```

Each item advances independently. If `src` finishes review before `test`, `src` can start verify immediately.

## Captured runtime state

After execution, the runtime returns `WorkflowRuntimeState` (`runtime.ts:73-80`, type in [`src/workflows/run/model.ts`](../../src/workflows/run/model.ts)):

```ts
{
  meta,            // parsed metadata
  phases,          // phase() rows
  logs,            // log() messages
  agentCalls,      // { prompt, options } per agent() call
  workflowProgress, // phases + scheduler.progress() merged
  result,          // the script's return value (optional)
}
```

`workflowProgress` is `[...phases, ...scheduler.progress()]`, and `scheduler.progress()` returns a defensive copy, so the returned state is a snapshot, not a live view.

The launcher ([`src/workflows/launch/launcher.ts`](../../src/workflows/launch/launcher.ts)) later merges this into a durable `WorkflowRunState` manifest written to `.pi/workflows/<runId>/manifest.json`. (Note: launching by saved `name` or `scriptPath` is not implemented yet — only inline `script` works.)

## Sandbox limits

The runtime uses Node's `node:vm` with a small context and a hard `timeout: 1000` ms on the synchronous slice of `script.runInContext` (`runtime.ts:85`). Long busy loops will time out.

Current tests prove scripts do not see:

```js
process
require
```

(`test/workflows/script/runtime.test.ts:41-52` checks `typeof process` and `typeof require` are both `"undefined"`.)

However, [ADR 0002](../adr/0002-use-acorn-and-node-vm-for-first-workflow-runtime.md) explicitly says `node:vm` is not a complete security boundary. Treat this as an execution kernel for the first implementation, not a finished security story.
