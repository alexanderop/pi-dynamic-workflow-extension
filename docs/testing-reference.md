# Pi Testing Reference

This note records the testing patterns from the real Pi codebase that we should copy as this project grows.

## Source Files To Read First

- `repos/pi/packages/coding-agent/test/trigger-compact-extension.test.ts` shows the smallest useful extension unit-test style: mock `ExtensionAPI`, capture handlers, invoke them directly.
- `repos/pi/packages/coding-agent/test/extensions-discovery.test.ts` tests real extension discovery and loading from temporary directories.
- `repos/pi/packages/coding-agent/test/extensions-runner.test.ts` tests `ExtensionRunner` behavior with fake extension actions and fake contexts.
- `repos/pi/packages/coding-agent/test/utilities.ts` contains reusable test helpers for loading inline extension factories and creating test sessions.
- `repos/pi/packages/coding-agent/test/compaction-extensions.test.ts` shows live-agent integration tests guarded by credentials.

## Testing Layers For This Project

Use four layers. Do not jump to live model tests early.

1. Pure unit tests for workflow semantics:
   - `parallel()` result ordering and thunk validation.
   - `pipeline()` per-item stage progression.
   - scheduler concurrency cap.
   - journal replay and stable key hashing.
   - run-state persistence transitions.
   - deterministic runtime guards for `Date.now()`, `Math.random()`, and argument-less `new Date()`.

2. Extension unit tests:
   - instantiate `src/extension/index.ts` with a mocked `ExtensionAPI`.
   - assert commands and tools are registered.
   - invoke command handlers with mocked contexts.

3. Filesystem integration tests:
   - use temporary directories.
   - fake subagent runner.
   - assert script copies, run JSON, journal JSONL, output files, and notification payloads.

4. Pi/session integration tests:
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

## What To Assert For Dynamic Workflows

Map tests back to `spec.md` acceptance criteria:

- Launcher returns immediately with task and run identifiers.
- Initial run JSON is written before execution starts.
- Progress rows update on phase, queue, start, tool use, result, failure, and stop.
- Journal writes `started` before execution and `result` only after validation.
- Resume reuses completed results and reruns incomplete calls.
- `/workflows` renders from run JSON without reading transcripts.
- Terminal runs produce a task notification with an output file pointer.
