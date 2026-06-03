---
created: 2026-06-04
implemented: false
---

# Spec: Pi-Style Testing Strategy and Tooling Refactor

## Problem

The current test suite is useful and passing, but it is weighted toward library internals:

- workflow VM/runtime behavior
- parser validation
- manager persistence
- dashboard rendering
- package contract checks
- one Pi CLI smoke test that only proves the extension loads

This leaves the riskiest user-facing layer under-tested: the Pi extension lifecycle in `extensions/workflow.ts`.

Important behaviors currently require a real-ish Pi runtime to validate:

- `session_start` registers stores and saved workflow commands
- the workflow tool is activated for the session
- status text updates when background jobs run
- background workflows are interrupted on `session_shutdown`
- completed background workflows notify the user and send one `workflow-completion` message
- `/workflow-save`, `/workflow-delete`, `/workflow-edit`, `/workflow-refresh`, and saved workflow commands behave correctly

Pi itself solves similar problems with deterministic harnesses, faux providers, temp dirs, in-memory services, and Vitest. This repo should adopt that pattern without overbuilding a full Pi clone.

## Evidence from Pi core

From the cloned Pi repo at `/tmp/pi-main-audit`:

- Root `package.json` uses Biome and TypeScript as the main quality gate:
  - `biome check --write --error-on-warnings .`
  - custom checks
  - `tsgo --noEmit`
- `packages/coding-agent/package.json` uses Vitest:
  - `"test": "vitest --run"`
- `packages/coding-agent/vitest.config.ts` sets:
  - `environment: "node"`
  - `globals: true`
  - `testTimeout: 30000`
- `packages/coding-agent/test/suite/README.md` defines testing rules:
  - use the suite harness
  - use the faux provider
  - no real provider APIs, keys, network calls, or paid tokens
  - keep tests CI-safe and deterministic
  - put issue-specific tests in `test/suite/regressions/`
- `packages/coding-agent/test/suite/harness.ts` creates temp dirs, in-memory auth/settings/session managers, faux model responses, event capture, and cleanup.

## Product goal

Refactor this repo so future tests can exercise realistic Pi extension behavior deterministically, using the same broad tooling style as Pi:

- Vitest for tests
- Biome for lint/format
- strict TypeScript build/checks
- Pi-style harnesses instead of fragile real API/e2e tests
- regression tests for user-visible bugs

## Non-goals

- Do not rewrite all existing tests in one PR.
- Do not require real LLM calls, real API keys, or paid tokens.
- Do not build a full mock implementation of Pi.
- Do not remove the existing CLI smoke test; keep it as a thin public-contract check.

## Desired end state

```text
src/
  extension/
    register-workflow-extension.ts
    workflow-extension-deps.ts
    workflow-extension-format.ts
  ...existing source files

extensions/
  workflow.ts

tests/
  support/
    extension-harness.ts
    faux-workflow-agent.ts
    temp-dir.ts
  suite/
    extension-lifecycle.test.ts
    extension-commands.test.ts
    workflow-agent.integration.test.ts
  suite/regressions/
    completion-message-sent-once.test.ts
    shutdown-interrupts-background-workflows.test.ts
  e2e/
    extension-loading.test.ts
```

`extensions/workflow.ts` should become a small adapter. The testable logic should move into `src/extension/` with explicit dependencies.

## Refactor plan

### Phase 1: Adopt Pi-style tooling

Add Vitest and move the test runner from `node:test`/`tsx --test` to Vitest.

Target dependencies:

```json
{
  "devDependencies": {
    "vitest": "^3.2.4"
  }
}
```

Target `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["tests/**/*.test.ts"],
	},
});
```

Target scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "biome check --write --error-on-warnings .",
    "check": "npm run lint && tsc -p tsconfig.json --noEmit",
    "test:unit": "vitest --run tests/*.test.ts",
    "test:suite": "vitest --run tests/suite/**/*.test.ts",
    "test:e2e": "vitest --run tests/e2e/**/*.test.ts",
    "test": "npm run check && npm run build && vitest --run"
  }
}
```

Notes:

- Pi uses `biome check --write --error-on-warnings .`; mirror that if we want identical local behavior.
- If CI should never write files, add a separate `lint:ci` script later with `biome ci .` or `biome check --error-on-warnings .`.
- Keep `tsx` only if another script still needs it; otherwise remove it after tests migrate.

### Phase 2: Align Biome with Pi

Current repo already uses Biome. Tighten it to look more like Pi while keeping repo-specific includes.

Target `biome.json` direction:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.5/schema.json",
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noNonNullAssertion": "off",
        "useConst": "error",
        "useNodejsImportProtocol": "off"
      },
      "suspicious": {
        "noExplicitAny": "off",
        "noControlCharactersInRegex": "off",
        "noEmptyInterface": "off"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "formatWithErrors": false,
    "indentStyle": "tab",
    "indentWidth": 3,
    "lineWidth": 120
  },
  "files": {
    "includes": [
      "src/**/*.ts",
      "extensions/**/*.ts",
      "tests/**/*.ts",
      "types/**/*.ts",
      "*.json",
      "*.md",
      "!dist/**/*",
      "!node_modules/**/*",
      "!.pi/**/*",
      "!!**/node_modules"
    ]
  }
}
```

Decision needed before implementation:

- Either pin `@biomejs/biome` to the same major/minor as Pi, or keep the current installed version and update the schema URL accordingly.
- Prefer pinning exact dev dependency versions for reproducible tooling, as Pi does.

### Phase 3: Extract extension registration from the adapter

Current `extensions/workflow.ts` mixes:

- command registration
- tool registration
- session lifecycle hooks
- manager/store/library creation
- UI formatting
- completion notification logic

Refactor to this shape:

```ts
// extensions/workflow.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDefaultWorkflowExtensionDeps, registerWorkflowExtension } from "../src/extension/register-workflow-extension.js";

export default function extension(pi: ExtensionAPI) {
	return registerWorkflowExtension(pi, createDefaultWorkflowExtensionDeps());
}
```

Introduce:

```ts
export interface WorkflowExtensionDeps {
	manager: WorkflowManager;
	workflowTool: ToolDefinition;
	globalWorkflowLibrary: WorkflowLibrary;
	createWorkflowStore(cwd: string): WorkflowJobStore;
	createBrowser(...): WorkflowBrowser;
	formatCompletion(job: WorkflowJob): string;
}
```

The production dependency factory should keep today’s behavior:

- `createWorkflowManager()`
- `createWorkflowTool({ manager })`
- global library at `~/.pi/agent/workflows`
- per-project store at `<ctx.cwd>/.pi/workflows`

The tests can inject in-memory managers/libraries and avoid touching the real home directory.

### Phase 4: Build a small extension harness

Add `tests/support/extension-harness.ts`.

It should capture only what this extension uses:

```ts
interface ExtensionHarness {
	pi: ExtensionAPILike;
	commands: Map<string, RegisteredCommand>;
	tools: ToolDefinition[];
	handlers: {
		input: Function[];
		session_start: Function[];
		session_shutdown: Function[];
	};
	entries: unknown[];
	sentMessages: unknown[];
	notifications: Array<{ message: string; level: string }>;
	statuses: Map<string, string | undefined>;
	ctx: ExtensionContextLike;
	startSession(): Promise<void>;
	shutdownSession(): Promise<void>;
	runCommand(name: string, args?: string): Promise<void>;
}
```

The harness should provide:

- temp `cwd`
- fake `ctx.ui.notify`
- fake `ctx.ui.setStatus`
- fake `ctx.ui.confirm`
- fake `ctx.ui.input`
- fake `ctx.ui.editor`
- fake `pi.sendMessage`
- fake `pi.appendEntry`
- fake `pi.getActiveTools` / `pi.setActiveTools`
- fake `ctx.sessionManager.getEntries`

Rules copied from Pi:

- use temp dirs
- clean up after each test
- no real provider APIs
- no real API keys
- deterministic fake agents only

### Phase 5: Add lifecycle tests first

Create `tests/suite/extension-lifecycle.test.ts`.

Required tests:

1. `session_start activates the workflow tool`
   - Register extension through the harness.
   - Trigger `session_start`.
   - Assert active tools include `workflow`.

2. `session_start attaches a project workflow store`
   - Trigger `session_start` with a temp `cwd`.
   - Start a background workflow.
   - Assert `.pi/workflows` files are created in the temp project, not the real home dir.

3. `status shows running workflow count`
   - Start a never-resolving workflow with a fake agent.
   - Assert status key `workflow` is set.
   - Cancel/interrupt.
   - Assert status clears.

4. `session_shutdown interrupts running workflows`
   - Start a never-resolving workflow.
   - Trigger `session_shutdown`.
   - Assert job status becomes `interrupted`.

5. `completed workflow sends exactly one completion message`
   - Start a workflow that completes.
   - Wait for manager settlement.
   - Assert one `pi.sendMessage` call with `customType: "workflow-completion"`.
   - Trigger unrelated manager changes if possible.
   - Assert no duplicate message.

### Phase 6: Add command tests

Create `tests/suite/extension-commands.test.ts`.

Required tests:

1. `/workflow-save` saves a workflow job as a global workflow command.
2. `/workflow-list` reports saved workflows.
3. `/workflow-delete` deletes a saved workflow after confirmation.
4. `/workflow-edit` updates script text from the fake editor.
5. `/workflow-refresh` registers new workflow files.
6. A saved workflow command starts a new background job with command args as `args`.

These should use an injected temp/global workflow library, not `~/.pi/agent/workflows`.

### Phase 7: Add WorkflowAgent integration tests with faux behavior

Keep the current `tests/workflow-agent.test.ts` unit tests. Add `tests/suite/workflow-agent.integration.test.ts` only after the extension harness is stable.

Targets:

- structured output is captured from the tool
- missing structured output triggers one repair turn
- abort signal calls session abort
- tool activity and text activity are emitted

If Pi’s exported faux provider APIs are available from the installed `@earendil-works/pi-ai`, use them. If not, keep a local fake session seam and do not force fragile real model setup.

### Phase 8: Organize regressions

Add:

```text
tests/suite/regressions/
```

Policy:

- Every user-visible bug fix gets a regression test.
- Name tests by behavior or issue number if available:
  - `completion-message-sent-once.test.ts`
  - `shutdown-interrupts-background-workflows.test.ts`
  - `saved-workflow-command-uses-latest-script.test.ts`

## Acceptance criteria

Tooling:

- `npm run lint` uses Biome with Pi-like strict warning behavior.
- `npm run check` runs lint plus TypeScript no-emit checking.
- `npm test` runs Vitest and existing e2e smoke coverage.
- Existing tests are migrated from `node:test` to Vitest without weakening assertions.

Architecture:

- `extensions/workflow.ts` is a thin adapter.
- Extension behavior can be tested without invoking the real `pi` binary.
- Global workflow library and project workflow store are injectable.
- Completion formatting is testable as a pure function.

Coverage behavior:

- Extension lifecycle tests cover `session_start` and `session_shutdown`.
- Command tests cover save/list/delete/edit/refresh/saved-command execution.
- Completion notification tests prove no duplicate `workflow-completion` messages.
- No tests require real LLM/API calls or paid tokens.

## Suggested implementation order

1. Add `vitest.config.ts` and migrate one small test file as proof.
2. Update package scripts to run Vitest.
3. Align Biome config and run formatter/linter.
4. Extract `registerWorkflowExtension(pi, deps)` from `extensions/workflow.ts`.
5. Add the extension harness.
6. Add lifecycle tests.
7. Add command tests.
8. Add regression folder and move future bug tests there.
9. Optionally add faux-provider integration tests for `WorkflowAgent`.

## Risk notes

- Migrating all tests to Vitest in one step may create noisy diffs. Prefer mechanical migration with no behavior changes.
- `biome check --write` modifies files. That mirrors Pi, but CI may prefer a non-writing command.
- Avoid making the extension harness too generic. It should support this extension’s used Pi API surface, not all of Pi.
- Keep the real CLI e2e smoke test small. Deeper behavior should live in deterministic suite tests.
