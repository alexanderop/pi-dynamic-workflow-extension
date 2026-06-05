# 09: Testing and Debugging

This project is built through small tested slices. Prefer fake-agent and filesystem tests before real Pi/model integration.

The source-of-truth for the test strategy is [`../testing-reference.md`](../testing-reference.md). This guide is the practical, file-by-file debugging companion to it.

## Main commands

Run type checking:

```bash
pnpm run check
```

Run tests once:

```bash
pnpm test
```

Run lint:

```bash
pnpm run lint
```

Check formatting for targeted code/config paths:

```bash
pnpm run fmt:check
```

Apply formatting to targeted paths:

```bash
pnpm run fmt
```

The formatter intentionally does not target exploratory docs such as `spec.md`, ADRs, or this learning guide unless explicitly changed.

## Test layout

| Area | Test file |
|---|---|
| Result helper | `test/workflows/result.test.ts` |
| Parser | `test/workflows/script/parser.test.ts` |
| Runtime, `parallel`, `pipeline` | `test/workflows/script/runtime.test.ts` |
| Scheduler | `test/workflows/agent/scheduler.test.ts` |
| Fake agent helper | `test/workflows/agent/agent-mock.test.ts` |
| State machines | `test/workflows/run/state-machine.test.ts` |
| Run store | `test/workflows/run/store.test.ts` |
| Launcher | `test/workflows/launch/launcher.test.ts` |
| Extension command | `test/extension/index.test.ts` |
| Local lint rule | `test/lint/test-name-should.test.ts` |

## Test naming convention

Every static `it(...)`/`test(...)` name must start with `should ` (the word `should` followed by a space and an action verb). The rule also covers `.only`/`.skip` variants and ignores dynamic names (e.g. `it(dynamicName, ...)`).

Good:

```ts
it("should persist the script copy before fake agents start", async () => {})
```

Avoid:

```ts
it("persists script", async () => {})
```

The mechanical part of this convention is enforced by a local Oxlint rule in `tools/oxlint-plugin-local.js`, whose behavior is locked by `test/lint/test-name-should.test.ts`. It runs as part of `pnpm run lint`.

## Debugging parser issues

Relevant file:

```text
src/workflows/script/parser.ts
```

`parseWorkflowScript()` throws `WorkflowParseError`; `tryParseWorkflowScript()` returns the same failure as `Result<ParsedWorkflowScript, WorkflowParseError>` (`src/workflows/script/parser.ts:39`). Common errors (messages paraphrased; exact text lives in `parser.ts`):

| Error | Likely cause | Source |
|---|---|---|
| Must start with `export const meta = { ... }` | Code, imports, or declarations appear before meta. | `parser.ts:26-27` |
| Meta must contain only literal values | Meta uses variables, calls, templates, spreads, computed keys, or methods. | `parser.ts:81-98` |
| Must not call `Date.now()` | Workflow body uses nondeterministic current time. | `parser.ts:156-159` |
| Must not call `Math.random()` | Workflow body uses randomness. | `parser.ts:161-164` |
| Must not call argument-less `new Date()` | Workflow body uses implicit current time. | `parser.ts:167-175` |

The determinism checks run twice: at parse time over the AST (`parser.ts:153-178`), and again at runtime where `Date`/`Math` are replaced with guarded versions (`src/workflows/script/runtime.ts:184-219`). The runtime check also catches aliases like `const m = Math; m.random()` that the AST walk cannot see.

Start with:

```bash
pnpm test test/workflows/script/parser.test.ts
```

## Debugging runtime issues

Relevant file:

```text
src/workflows/script/runtime.ts
```

The runtime parses the script, then runs the body as **raw JavaScript** inside a `node:vm` context wrapped in an `async` IIFE, with a 1000ms timeout (`src/workflows/script/runtime.ts:82-85`). There is no TypeScript transpilation, so any TypeScript-only syntax in the body is a syntax error in the VM. The context only exposes `args`, `budget`, `phase`, `log`, `agent`, `parallel`, `pipeline`, and guarded `Date`/`Math` (`runtime.ts:55-71`); `process`, `require`, and friends are absent.

`runWorkflowScript()` throws on failure; `tryRunWorkflowScript()` returns `Result<WorkflowRuntimeState, WorkflowRuntimeError>` (`runtime.ts:103-116`).

Useful questions:

1. Did parsing succeed?
2. Did the script body contain TypeScript-only syntax (the VM runs raw JS, no transpile)?
3. Did the script try to access an unavailable global (e.g. `process`, `require`)?
4. Did a fake `agentRunner` reject?
5. Did `parallel()` receive thunks (`() => Promise<T>`), or already-started promises (rejected)?
6. Did a `pipeline()` stage throw for one item (that item becomes `null`, others continue)?
7. Did a long loop or heavy computation hit the 1000ms VM timeout?

Run:

```bash
pnpm test test/workflows/script/runtime.test.ts
```

## Debugging scheduler issues

Relevant file:

```text
src/workflows/agent/scheduler.ts
```

Check:

- `maxConcurrent` (defaults to `min(16, max(1, cpuCores - 2))` via `calculateDefaultMaxConcurrent`, `scheduler.ts:185-187`)
- `maxTotalAgents` (a hard ceiling; `schedule()` rejects once exceeded)
- FIFO queue ordering
- `stopAgent(agentId)` behavior — returns `false` (silent no-op) if the agent is unknown or already terminal; a stopped agent resolves to `null`, not its result
- whether the fake runner resolves, rejects, or waits forever
- whether the abort signal (`request.signal`) is observed by the fake runner
- `progress()` returns a defensive copy; a `queued` entry can appear before the agent actually starts

Run:

```bash
pnpm test test/workflows/agent/scheduler.test.ts
```

## Debugging launcher issues

Relevant file:

```text
src/workflows/launch/launcher.ts
```

Check the launch sequence (`launchWorkflow`, `launcher.ts:78`):

1. select source (`script`, saved workflow `name`, or explicit `scriptPath`)
2. parse before touching disk (a parse error fails the launch and writes nothing)
3. prepare run files (`rootDir/<runId>/script.js` and `transcripts/`)
4. write initial manifest with `status: "running"`
5. defer background execution (defaults to `setImmediate`; `launchWorkflow` returns immediately)
6. merge runtime state into the initial state
7. transition the state machine and write the final manifest

The fake agent work runs in the deferred background pass; the returned `completion` promise settles when it finishes. `resumeFromRunId` replays cached journal results for inline fake workflows; `description` is used only for summary text.

For most launcher tests, use the MSW-style helper from `test/workflows/agent/agent-mock.ts` instead of ad-hoc runner functions:

```ts
const agents = setupAgentMock(
  agent.call({ prompt: "scan src", label: "scan-agent" }, () => {
    return AgentResponse.json({ summary: "ok" });
  }),
);

await launchWorkflow(
  { script },
  launchOptions({ agentRunner: agents.runner }),
);
```

Use manual runner functions only when testing launch timing or promise choreography.

Run:

```bash
pnpm test test/workflows/launch/launcher.test.ts
```

## Debugging `/workflows`

Relevant files:

```text
src/extension/index.ts
src/workflows/run/store.ts
```

Check:

- Is the command registered? (`pi.registerCommand("workflows", ...)`, `src/extension/index.ts:11`)
- Is `ctx.cwd` what you expect? The store reads `join(ctx.cwd, ".pi", "workflows")` (`index.ts:14`).
- Does `.pi/workflows` exist under that cwd? A missing directory yields an empty list (ENOENT), not an error (`run-store.ts:63`).
- Is the manifest valid JSON? Invalid or unparseable manifests are silently filtered by `listRuns()` (`run-store.ts:58-75`) — a bad manifest disappears rather than erroring.
- Does the manifest match `WorkflowRunState` enough to normalize? The store also accepts the legacy "observed" format (`run-store.ts:208-258`).
- Which mode is being tested: `tui`, `rpc`, `json`, or `print`? Without an explicit mode override, output falls back to `print` when `ctx.hasUI` is false (`index.ts:36`); `tui` and `rpc` both route to `ctx.ui.notify()`.

Run:

```bash
pnpm test test/extension/index.test.ts test/workflows/run/store.test.ts
```

## Fake-agent first rule

Do not add live model tests for behavior that can be tested with fake agents.

Default to the MSW-style fixture:

```ts
const agents = setupAgentMock(
  agent.call({ label: "scan-agent" }, () => AgentResponse.text("ok")),
);
```

Use the fixture for:

- successful strings
- successful objects
- failures
- strict unhandled-call checks
- asserting no calls during resume/cache hits
- runtime handler overrides
- one-time and sequential responses

Use manual fake runners only for:

- delayed results controlled by a deferred promise
- aborted running agents where the test choreographs the abort signal directly
- never-resolving agents
- scheduler concurrency tests that need explicit counters

Live Pi subagent tests should come later, after fake-agent and filesystem behavior is stable.

## When to update docs

- New observed dynamic workflow behavior: update [`../../spec.md`](../../spec.md).
- New implementation decision: add/update an ADR under [`../adr/`](../adr/).
- New planned slice or status: update [`../backlog.md`](../backlog.md).
- New onboarding explanation: update a doc under [`./`](./) (this `docs/learning/` folder).
