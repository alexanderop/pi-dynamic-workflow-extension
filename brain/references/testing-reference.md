# Pi Testing Reference

This note records the testing patterns from the real Pi codebase that we should copy as this project grows.

Companion planning spec: `brain/plans/workflows/test-page-objects/spec.md` describes the future testing DSL, domain builders, `/workflows` screen object, and workflow scenario harness we intend to use when refactoring noisy tests.

## Source Files To Read First

- `repos/pi/packages/coding-agent/test/trigger-compact-extension.test.ts` shows the smallest useful extension unit-test style: mock `ExtensionAPI`, capture handlers, invoke them directly.
- `repos/pi/packages/coding-agent/test/extensions-discovery.test.ts` tests real extension discovery and loading from temporary directories.
- `repos/pi/packages/coding-agent/test/extensions-runner.test.ts` tests `ExtensionRunner` behavior with fake extension actions and fake contexts.
- `repos/pi/packages/coding-agent/test/utilities.ts` contains reusable test helpers for loading inline extension factories and creating test sessions.
- `repos/pi/packages/coding-agent/test/compaction-extensions.test.ts` shows live-agent integration tests guarded by credentials.

## Testing Layers For This Project

Use five layers. Do not jump to live model tests early. When a test needs to control `agent()` output, prefer the MSW-style fake agent helper (`test/workflows/agent/agent-mock.ts`) over one-off runner mocks.

1. Pure unit tests for workflow semantics:
   - `parallel()` result ordering and thunk validation.
   - `pipeline()` per-item stage progression.
   - scheduler concurrency cap.
   - journal replay and stable key hashing.
   - run-state persistence transitions.
   - deterministic runtime guards for `Date.now()`, `Math.random()`, and argument-less `new Date()`.

2. Property-based tests for invariant-heavy pure or tightly bounded modules:
   - layout width contracts and wrapping/truncation invariants.
   - monitor navigation clamping and impossible-screen prevention.
   - canonical journal-key serialization and stable hashing inputs.
   - state-machine replay equivalence and terminal-state behavior.
   - parser metadata and deterministic-runtime guards.
   - saved-workflow name validation and runtime helper semantics.
   - bounded scheduler caps without live model calls.

3. Extension unit tests:
   - instantiate `src/extension/index.ts` with a mocked `ExtensionAPI`.
   - assert commands and tools are registered.
   - invoke command handlers with mocked contexts.

4. Filesystem integration tests:
   - use temporary directories.
   - use `setupAgentMock(...)` as the default fake subagent runner when controlling agent responses, failures, or call assertions.
   - use `agent.pending(...)` for timing-sensitive cases (deferred launch, ordering, "not settled yet") instead of hand-rolled `agentRunner` closures — it keeps the test on the mock boundary while letting you control exactly when the agent resolves.
   - reach for a raw `agentRunner` closure only when the agent is genuinely incidental to the assertion and the mock would add noise.
   - assert script copies, run JSON, journal JSONL, output files, and notification payloads.

5. Pi/session integration tests:
   - use Pi's `SessionManager.inMemory()` or temp session pattern.
   - keep credentials optional.
   - skip live model tests unless required auth env vars are present.

## Minimal Extension Unit Test Pattern

Adapted from `repos/pi/packages/coding-agent/test/trigger-compact-extension.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import extension from "../../src/extension/index.ts";

describe("extension", () => {
  it("registers commands", () => {
    const registerCommand = vi.fn();

    extension({
      registerCommand,
    } as any);

    expect(registerCommand).toHaveBeenCalledWith(
      "workflows",
      expect.objectContaining({
        handler: expect.any(Function),
      }),
    );
  });
});
```

This is the fastest way to protect extension wiring.

## Capturing Event Handlers

Pi tests capture handlers from `pi.on(...)` and call them directly. Use this for events such as `session_start`, `turn_end`, `tool_call`, and later workflow notifications.

Pattern:

```ts
let turnEndHandler: ((event: any, ctx: any) => void) | undefined;

const api = {
  on: (event: string, handler: (event: any, ctx: any) => void) => {
    if (event === "turn_end") turnEndHandler = handler;
  },
  registerCommand: vi.fn(),
};

extension(api as any);
turnEndHandler?.({ type: "turn_end" }, fakeContext);
```

Reference: `repos/pi/packages/coding-agent/test/trigger-compact-extension.test.ts`.

## Loading Inline Extension Factories

Pi's own test utilities create loaded extension results without writing files:

```ts
const runtime = createExtensionRuntime();
const eventBus = createEventBus();
const extension = await loadExtensionFromFactory(factory, cwd, eventBus, runtime, "<inline>");
```

Reference: `repos/pi/packages/coding-agent/test/utilities.ts`.

Use this pattern when we need real Pi extension objects rather than a mocked `ExtensionAPI`.

## Test Resource Loader Pattern

Pi's utilities create a resource loader that returns controlled extensions and empty resources for everything else:

```ts
return {
  getExtensions: () => extensionsResult,
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => undefined,
  getAppendSystemPrompt: () => [],
  extendResources: () => {},
  reload: async () => {},
};
```

Reference: `repos/pi/packages/coding-agent/test/utilities.ts`.

Use this when constructing `AgentSession` integration tests without relying on the user's real Pi config.

## Temporary Session Pattern

Pi creates temp sessions like this:

```ts
const sessionManager = options.inMemory
  ? SessionManager.inMemory()
  : SessionManager.create(tempDir);
const settingsManager = SettingsManager.create(tempDir, tempDir);
const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
const modelRegistry = ModelRegistry.create(authStorage, tempDir);
```

Reference: `repos/pi/packages/coding-agent/test/utilities.ts`.

For this project:

- prefer `SessionManager.inMemory()` for command and UI tests.
- prefer temp dirs for persistence behavior.
- never write workflow test data into the user's real `~/.pi/agent` directory.

## Live Model Tests

Pi skips live model tests unless credentials are present:

```ts
const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

describe.skipIf(!API_KEY)("live integration", () => {
  // tests that call a real model
});
```

Use this only after the fake subagent runner tests pass. Most workflow behavior should be testable without real LLM calls.

## Property-Based Tests With Fast-Check

Property-based tests use `fast-check` to generate many inputs for one contract-level invariant. They are a complement to example-based tests, not a replacement. Keep them grounded in `spec.md`, ADRs, existing examples, and user-visible contracts.

File and import conventions:

- Name files `*.property.test.ts`; Vitest already includes them through `test/**/*.test.ts`.
- Import `fast-check` helpers by name, not as a default namespace, to satisfy Oxlint:

```ts
import { array, assert, integer, property } from "fast-check";
```

- Bound generated runs so the suite stays fast:
  - use `const propertyRuns = { numRuns: 200 };` for pure synchronous invariants.
  - use 50–100 runs for async scheduler/runtime properties.
- Prefer small generated domains (`maxLength`, `maxDepth`, small integer ranges) over huge fuzz spaces.

Current property-test coverage:

- `test/workflows/view/layout.property.test.ts` protects the Pi TUI width contract for truncation, padding, headers, two-pane boxes, and wrapping.
- `test/workflows/view/navigation.property.test.ts` protects monitor navigation clamping and prevents agent-only screens when there are no agents.
- `test/workflows/journal/key.property.test.ts` protects canonical JSON idempotence, insertion-order independence, stable schema keying, and rejection of cyclic/non-finite values.
- `test/workflows/run/state-machine.property.test.ts` protects terminal-state behavior and replay equivalence.
- `test/workflows/script/parser.property.test.ts` protects literal metadata parsing and deterministic primitive rejection.
- `test/workflows/saved/resolver.property.test.ts` protects saved-workflow command-name validation and path construction.
- `test/workflows/script/runtime.property.test.ts` protects `parallel()` and `pipeline()` helper semantics.
- `test/workflows/agent/scheduler.property.test.ts` protects generated concurrency and total-agent caps.

Good targets for future property tests:

- pure functions with exact invariants;
- state machines and replay algorithms;
- serializers, canonicalizers, and parsers;
- TUI line-width contracts;
- bounded async schedulers with fake runners.

Avoid starting property tests with full filesystem launcher flows, live Pi sessions, or live model calls. Those are better covered by example-based integration tests.

When a property fails:

1. Read the minimal counterexample from `fast-check`.
2. Decide whether it is a real implementation bug, an over-broad property, or a bad generator.
3. If real, fix the implementation and keep the property as a regression guard.
4. If not real, narrow the generator/property and add a short comment only when the domain boundary is non-obvious.

Avoid conditional `expect(...)` calls inside generated loops; Oxlint's Vitest rules flag them. Prefer boolean helper predicates and one unconditional assertion:

```ts
expect(indexWithin(index, length)).toBe(true);
```

Do not assert probabilistic guarantees such as “hashes never collide.” Assert deterministic canonicalization and that documented effective inputs are included in the key preimage.

## MSW-Style Fake Agent Fixture

This is the standard way to mock workflow subagents in tests. Use
`test/workflows/agent/agent-mock.ts` when a test needs controlled agent
outputs through the public fake-agent boundary.

Longer-term DX goals for making this feel like MSW in frontend projects are
captured in `brain/plans/workflows/agent-mock-boundary/spec.md`.

```ts
const agents = setupAgentMock(
  agent.call({ prompt: "scan src", label: "scan-agent" }, () => {
    return AgentResponse.json({ summary: "ok" });
  }),
);

const launch = unwrap(
  await launchWorkflow(
    { script },
    launchOptions({ schedulerRunner: agents.schedulerRunner }),
  ),
);

unwrap(await launch.completion);
agents.expectNoUnhandledAgents();
```

For MSW-style shared server suites, define one global default server at module
scope:

```ts
export const agents = setupDefaultAgentTestServer(
  agent.label("repo-inventory").replyJson({ summary: "default inventory" }),
);
```

This appends a deterministic catch-all mocked agent response after explicit
global handlers, so every agent has a default fake. Individual tests can override
handlers without leaking by wrapping their scenario in `agents.boundary(...)`.

Testing strategy:

- Prefer this fixture over ad-hoc `let runnerCalls = 0` mocks in launcher/runtime integration tests.
- Keep tests at the public boundary: pass `agents.schedulerRunner` to runtime/launch options when the test needs scheduler metadata (`agentId`, journal key, abort signal), or `agents.runner` when prompt/options are enough. Do not mock scheduler internals.
- Handlers are strict by default; unhandled agent calls fail the test.
- Use `agents.expectNoAgents()` when resume/cache behavior should avoid new agent work.
- Use `agents.expectNoUnhandledAgents()` when every expected agent call should be covered by a handler.
- Use `agents.expectAgentCalled(...)`, `agents.expectAgentCalledTimes(...)`, `agents.expectAgentsInOrder(...)`, and `agents.expectAllHandlersUsed()` for MSW-style assertions at the agent boundary.
- Use `setupDefaultAgentTestServer(...)` for shared MSW-style suites where every
  agent should have a default fake response.
- Use `agents.use(...)` for runtime overrides; newer handlers take priority.
- Use `agents.boundary(async () => { ... })` when a runtime override must stay
  scoped to one async scenario; nested boundaries inherit parent handlers and
  concurrent boundaries keep their overrides isolated.
- Use `agents.resetHandlers()` and `agents.restoreHandlers()` for lifecycle tests.
- Use `{ once: true }` or generator resolvers for sequential responses.
- Use `agent.pending(...)` for timing tests: register it like any handler, then
  drive it with `await scan.waitUntilStarted()`, inspect `scan.started` /
  `scan.prompt`, and release it with `scan.resolve(...)` or `scan.reject(...)`.
  Prefer this over hand-rolled deferred promises and `agentStarted` booleans.

Shared async test utilities (`deferred`, `waitFor`, `delay`, `unwrap`,
`pathExists`) live in `test/support.ts`; import them instead of re-declaring
per file.

Use a raw `agentRunner` closure only when the agent is incidental to the
assertion and `setupAgentMock` / `agent.pending` would add noise.

## What To Assert For Dynamic Workflows

Map tests back to `spec.md` acceptance criteria:

- Launcher returns immediately with task and run identifiers.
- Initial run JSON is written before execution starts.
- Progress rows update on phase, queue, start, tool use, result, failure, and stop.
- Journal writes `started` before execution and `result` only after validation.
- Resume reuses completed results and reruns incomplete calls.
- `/workflows` renders from run JSON without reading transcripts.
- Terminal runs produce a task notification with an output file pointer.

## Test Naming Convention

Name tests from the behavior being protected:

- Every `it(...)` name should start with `should` followed by an action verb.
- Include the trigger, precondition, or error condition when it affects the behavior.
- Use workflow and extension language from `spec.md` instead of implementation mechanics.
- Describe user-visible or contract-visible outcomes, not private state updates.
- Group related tests with `describe("when ...")` contexts when a file grows beyond a small set of direct contract checks.

Preferred pattern:

```ts
describe("workflow runtime", () => {
  describe("when workflow script starts", () => {
    it("should write initial run state before agents are queued", () => {});
  });
});
```

`pnpm run lint` enforces only the first mechanical part of this convention for
static `it(...)`, `it.only(...)`, `it.skip(...)`, `test(...)`, `test.only(...)`,
and `test.skip(...)` names. It intentionally ignores dynamic test names and does
not try to enforce subjective naming quality.
