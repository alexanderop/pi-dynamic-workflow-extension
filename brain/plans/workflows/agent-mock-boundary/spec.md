# MSW-Style Agent Mock Developer Experience Specification

## Purpose

This document describes the target developer experience for the workflow
`agent()` mock. The goal is that testing dynamic workflows should feel like
using Mock Service Worker in a frontend project:

- tests describe mocked external boundaries declaratively;
- unhandled calls fail loudly with useful diagnostics;
- per-test overrides are easy and scoped;
- lifecycle setup is familiar and repeatable;
- integration tests exercise the public `agent()` boundary, not scheduler
  internals.

In this project, `agent()` plays the same role that `fetch()` plays in a web
application. A workflow should be tested against a fake agent boundary in the
same way a frontend app is tested against a fake HTTP boundary.

## Current Baseline

The current helper lives at `test/workflows/agent/agent-mock.ts`.

It already supports:

- strict unhandled-agent failures by default;
- `setupAgentMock(...)`;
- `agent.call(...)`, `agent.any(...)`, and `agent.pending(...)`;
- `AgentResponse.text(...)`, `AgentResponse.json(...)`, and
  `AgentResponse.error(...)`;
- `agents.runner` for prompt/options calls;
- `agents.schedulerRunner` for full scheduler-shaped calls;
- `use`, `resetHandlers`, `restoreHandlers`, and `listHandlers`;
- recorded calls and lifecycle events;
- scoped `agents.boundary(...)` runtime overrides for nested and concurrent
  async test scenarios;
- call assertions such as `expectNoAgents`, `expectNoUnhandledAgents`,
  `expectAgentCalledTimes`, and `expectAgentsInOrder`;
- a small JSON-schema subset validator for structured fake responses.

This is good enough for current integration tests. The remaining work is mostly
DX: making the API feel obvious, hard to misuse, and close to MSW muscle memory.

## Design Principles

### Agent Calls Are Requests

Treat every workflow `agent(prompt, options)` call as an intercepted request:

- `prompt` is the primary request body;
- `label`, `phase`, `agentType`, `model`, `schema`, and `isolation` are request
  metadata;
- `agentId`, `journalKey`, and `signal` are scheduler/runtime metadata;
- the mock response is the subagent result.

Tests should assert at this boundary instead of mocking internals below it.

### Strict By Default

Unhandled calls should fail by default. Bypassing is useful for exploratory or
low-value tests, but integration tests should normally run with
`onUnhandledAgent: "error"`.

### Declarative First, Escape Hatches Second

Common cases should read like scenario declarations. Lower-level resolver
functions should remain available for timing, concurrency, and stateful
behaviors.

### Scope Must Be Explicit

Runtime overrides should be easy to add and easy to reset. Shared mock state
must not leak across tests.

## Target API

### Server Lifecycle

Add an MSW-like lifecycle API:

```ts
const agents = setupAgentServer(
  agent.prompt("scan src").withLabel("scan-agent").replyJson({ summary: "ok" }),
);

beforeAll(() => {
  agents.listen({ onUnhandledAgent: "error" });
});

afterEach(() => {
  agents.resetHandlers();
});

afterAll(() => {
  agents.close();
});
```

Requirements:

- `setupAgentServer(...handlers)` creates a server but does not enable it.
- `listen(options?)` enables the server and applies runtime options.
- `close()` disables the server.
- Calling `runner` or `schedulerRunner` before `listen()` SHOULD fail with a
  clear error unless the server was created in compatibility mode.
- Calling `listen()` twice SHOULD fail with a clear error.
- Calling `close()` twice MAY be a no-op, matching MSW's forgiving close
  behavior.
- `resetHandlers()` restores the initial handler list and clears per-test calls
  and events.
- `resetHandlers(...nextHandlers)` replaces the initial handler list, matching
  MSW behavior.
- `restoreHandlers()` restores consumed one-time handlers without removing
  runtime overrides.

Compatibility:

- Keep `setupAgentMock(...)` as a convenience wrapper for existing tests.
- Internally, `setupAgentMock(...)` MAY call `setupAgentServer(...).listen()` so
  current tests remain concise.

### Global Test Setup Helper

Support a shared-test-server pattern for larger suites:

```ts
export const agents = setupDefaultAgentTestServer(
  agent.label("default-scan").replyText("ok"),
);
```

`setupDefaultAgentTestServer(...)` appends a catch-all default mocked agent
handler after the explicit handlers, so every `agent()` call has a deterministic
fake response unless a more specific global handler or test-local boundary
override matches first. This is the preferred MSW-like shared-server API. Use
`setupAgentTestServer(...)` only when a suite deliberately wants strict
unhandled-agent failures with no fallback.

`setupAgentTestServer` and `setupDefaultAgentTestServer` should register Vitest
lifecycle hooks:

- `beforeAll(() => agents.listen())`
- `afterEach(() => agents.resetHandlers())`
- `afterAll(() => agents.close())`

This helper should be optional. Per-test servers remain preferred for tests that
need precise call/event isolation.

### Declarative Handler DSL

Keep `agent.call(matcher, resolver)` as the lowest-level API, but add a fluent
DSL for common scenarios:

```ts
agent.prompt("scan src").replyText("scan complete");

agent
  .prompt(/^scan /)
  .withLabel("scan-agent")
  .withPhase("Scan")
  .replyJson({ summary: "ok" });

agent.label("verify-agent").replyJson({ verdict: "valid" });

agent.any().replyText("fallback");
```

Target matcher builders:

- `agent.prompt(value)`
- `agent.label(value)`
- `agent.phase(value)`
- `agent.model(value)`
- `agent.agentType(value)`
- `agent.schema(value)`
- `agent.any()`

Target chain methods:

- `.withPrompt(value)`
- `.withLabel(value)`
- `.withPhase(value)`
- `.withModel(value)`
- `.withAgentType(value)`
- `.withSchema(value)`
- `.once()`
- `.replyText(value | resolver)`
- `.replyJson(value | resolver)`
- `.replyError(message | Error)`
- `.replyWith(resolver)`
- `.pending()`

All matcher values should support the same forms as today:

- exact values;
- regular expressions for strings;
- predicates.

### Resolver Request Object

Resolvers should receive a stable request object in addition to convenience
fields:

```ts
agent.label("scan-agent").replyJson(({ request }) => {
  expect(request.prompt).toBe("scan src");
  expect(request.options.phase).toBe("Scan");
  expect(request.agentId).toMatch(/^a/);
  expect(request.journalKey).toMatch(/^v2:/);
  return { summary: "ok" };
});
```

Target resolver info:

```ts
interface AgentMockResolverInfo {
  request: AgentMockRequest;
  prompt: string;
  options: AgentOptions;
  callIndex: number;
  agentId?: string;
  journalKey?: string;
  signal?: AbortSignal;
}

interface AgentMockRequest {
  prompt: string;
  options: AgentOptions;
  agentId?: string;
  journalKey?: string;
  signal?: AbortSignal;
}
```

The request object MUST be a defensive snapshot. Resolver mutations must not
change recorded calls or events.

### Response Helpers

Expand `AgentResponse` so tests read as scenarios:

```ts
AgentResponse.text("ok");
AgentResponse.json({ summary: "ok" });
AgentResponse.error("agent exploded");
AgentResponse.delay(100, AgentResponse.json({ summary: "slow" }));
AgentResponse.networkError("connection reset");
AgentResponse.schemaError("invalid structured output");
```

Requirements:

- `delay(ms, response)` returns a delayed response.
- `networkError` and `schemaError` should throw distinguishable
  `AgentMockError` variants.
- `json(...)` should continue to return a structured clone.
- Schema validation should run after resolver completion and before the result
  is emitted or journaled by integration code.

### Pending Agents

Keep the current pending-agent control flow, but expose it through the fluent
DSL too:

```ts
const scan = agent.label("scan-agent").pending();

agents.use(scan);

await scan.waitUntilStarted();
scan.resolve(AgentResponse.json({ summary: "ok" }));
```

Pending handlers should expose:

- `started`
- `callCount`
- `info`
- `prompt`
- `waitUntilStarted()`
- `resolve(value)`
- `reject(reason)`

Future enhancement:

- support waiting for the Nth call: `waitUntilStarted(2)`.

### Unhandled Agent Behavior

Support the same strategy shapes MSW users expect:

```ts
agents.listen({ onUnhandledAgent: "error" });
agents.listen({ onUnhandledAgent: "warn" });
agents.listen({ onUnhandledAgent: "bypass" });

agents.listen({
  onUnhandledAgent(call, print) {
    if (call.options.label?.startsWith("debug:")) return print.bypass();
    return print.error();
  },
});
```

Requirements:

- `"error"` throws.
- `"warn"` logs and returns the prompt as the fake result.
- `"bypass"` returns the prompt without logging.
- callback strategies receive the recorded call and print helpers:
  - `warning()`
  - `error()`
  - `bypass()`

### Diagnostics

Unhandled failures should include:

- the actual agent call;
- all registered handlers;
- the closest prompt/label/phase matches where practical;
- full matchable metadata: `label`, `phase`, `agentType`, `model`, `schema`;
- a hint when handlers are passed as an array instead of spread.

Example:

```txt
Unhandled agent call:
  agent("scan src" label="scan-agent" phase="Scan" model="default")

Registered handlers:
  agent.prompt(/^verify /).withLabel("verify-agent")
  agent.label("scan-agent").withPhase("Review")

Closest handler:
  agent.label("scan-agent").withPhase("Review")
  phase differs: expected "Review", received "Scan"
```

Add:

```ts
agents.printHandlers();
```

It should return the same handler list shown in diagnostics.

### Events

Continue to record lifecycle events and make them easy to assert:

```ts
expect(agents.events()).toMatchObject([
  { type: "agent:start" },
  { type: "agent:match" },
  { type: "agent:result" },
  { type: "agent:end" },
]);
```

Target event types:

- `agent:start`
- `agent:match`
- `agent:unhandled`
- `agent:result`
- `agent:error`
- `agent:end`

Optional future event subscription API:

```ts
agents.events.on("agent:match", listener);
agents.events.removeListener("agent:match", listener);
```

Do not add event emitters until tests need active subscriptions. Recorded
events are sufficient for now.

### Boundary Scoping

MSW supports scoped runtime overrides for concurrent tests. The current helper
implements this with async-context scoped handler lists so workflow integration
tests can share a global mock server without runtime handler leakage.

Target API:

```ts
await agents.boundary(async () => {
  agents.use(agent.label("scan-agent").replyText("scoped"));
  // calls inside this closure see scoped handlers
});
```

Requirements:

- handlers added inside a boundary are scoped to that boundary;
- nested boundaries inherit parent handlers;
- concurrent boundaries keep their runtime overrides isolated;
- `resetHandlers()` inside a boundary resets to the boundary's initial state.

## Recommended Test Shapes

### Shared Default Server Suite

```ts
const agents = setupDefaultAgentTestServer(
  agent.label("repo-inventory").replyJson({ summary: "default inventory" }),
);

it("should override one mocked agent for this scenario", async () => {
  await agents.boundary(async () => {
    agents.use(agent.label("repo-inventory").replyJson({ summary: "scenario inventory" }));

    // calls inside this block see the scenario override; other calls fall back
    // to the shared defaults, including the catch-all default agent mock.
  });
});
```

Use this shape for larger MSW-style suites where every agent call should have a
safe deterministic fake by default. Use `setupAgentTestServer(...)` instead when
a suite intentionally wants strict unhandled-agent failures.

### Runtime Integration Test

```ts
const agents = setupAgentMock(
  agent.label("scan-agent").replyJson({ summary: "ok" }),
);

const state = await runWorkflowScript(script, {
  schedulerRunner: agents.schedulerRunner,
});

agents.expectNoUnhandledAgents();
agents.expectAgentCalled({ label: "scan-agent" });
```

### Launcher Filesystem Integration Test

```ts
const scan = agent.label("scan-agent").pending();
const agents = setupAgentMock(scan);

const launch = unwrap(
  await launchWorkflow(
    { script },
    launchOptions({ schedulerRunner: agents.schedulerRunner }),
  ),
);

await scan.waitUntilStarted();
scan.resolve(AgentResponse.json({ summary: "ok" }));

const completed = unwrap(await launch.completion);
expect(completed.status).toBe("completed");
agents.expectNoUnhandledAgents();
```

### Structured Output Failure

```ts
const agents = setupAgentMock(
  agent.label("scan-agent").replyJson({ count: "one" }),
);

await expect(
  runWorkflowScript(scriptWithIntegerSchema, {
    schedulerRunner: agents.schedulerRunner,
  }),
).rejects.toThrow(/does not satisfy agent schema/);
```

## Migration Plan

1. Add `setupAgentServer` and lifecycle methods while keeping
   `setupAgentMock` compatibility.
2. Add the fluent handler DSL on top of existing `AgentMockHandler`.
3. Update docs and examples to prefer the fluent DSL.
4. Migrate a few representative tests first:
   - one runtime test;
   - one launcher success test;
   - one launcher failure test;
   - one resume-cache test.
5. Keep low-level `agent.call(...)` tests to protect matcher internals.
6. Add optional global `setupAgentTestServer` only after we decide whether the
   test suite benefits from a shared mock server. Implemented alongside
   `setupDefaultAgentTestServer`, the preferred shared-server helper with a
   deterministic catch-all default agent mock.
7. Add `boundary(...)` only if concurrent shared-server tests need scoped
   overrides. Implemented for nested and concurrent async scenarios.

## Non-Goals

- Do not simulate real LLM reasoning.
- Do not make the mock depend on a full JSON Schema implementation unless the
  small local subset becomes insufficient.
- Do not replace live Pi/session tests. This mock is for deterministic workflow
  integration tests.
- Do not expose scheduler internals in test APIs beyond the public
  scheduler-shaped runner request.

## Decisions

- Use `setupAgentMock(...)` for focused per-test fake-agent fixtures.
- Use `setupDefaultAgentTestServer(...)` for MSW-style shared suites where every
  agent call should have a deterministic default fake.
- Use `setupAgentTestServer(...)` for shared suites that deliberately want strict
  unhandled-agent failures.
- Keep schema validation enabled by default for schema-bearing calls.
- Print fluent handler diagnostics in the fluent form developers wrote.
