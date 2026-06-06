# Testing DSL And Page-Object Specification

## Purpose

Define the target developer experience for refactoring this repository's tests
around a small testing DSL and page-object pattern.

The goal is not to build a second test framework. The goal is to make tests read
like the dynamic-workflow specification: runs, phases, agents, journals, saved
workflows, terminal outputs, and `/workflows` screens.

This spec is for a later implementation/refactor. It records the intended shape
before changing the tests.

## Current Baseline

The project already has useful testing layers:

- pure unit tests for workflow semantics;
- property-based tests for invariant-heavy modules;
- extension unit tests with mocked Pi APIs;
- filesystem integration tests using temp directories;
- MSW-style fake-agent tests through `test/workflows/agent/agent-mock.ts`.

The current pain is repeated test ceremony:

- TUI tests manually construct full `WorkflowRunState` and
  `WorkflowAgentProgress` objects;
- TUI tests manually render components, join lines, strip controls, and check
  width contracts;
- launcher tests repeat temp-directory setup, root workflow path setup, fake
  clock wiring, fake-agent wiring, launch completion unwrapping, and filesystem
  assertions;
- test names describe behavior well, but individual test bodies often expose
  too much object-construction and harness detail.

## Design Principles

### Thin DSL, Explicit Assertions

The DSL should remove ceremony, not hide behavior. Prefer explicit assertions:

```ts
screen.shouldShowAgentDetail("review:security");
scenario.shouldHaveJournalEvent("result", { label: "review-agent" });
```

Avoid broad assertions that make failures vague:

```ts
screen.shouldBeCorrect();
scenario.shouldBeValid();
```

### Spec Language Over Implementation Language

Test helpers should use the vocabulary from `spec.md`:

- workflow;
- run;
- phase;
- agent;
- journal;
- saved workflow;
- output file;
- task notification;
- overview;
- chooser;
- agent detail;
- original prompt reader.

Avoid making tests speak in private implementation details unless the test is
specifically protecting an implementation seam.

### Boundary Objects, Not Global Magic

Use page objects and scenarios at public boundaries:

- `/workflows` TUI rendering and input handling;
- workflow launch and filesystem persistence;
- fake-agent request/response boundary;
- domain fixture construction.

Keep pure unit tests and property tests direct when direct assertions are clearer.

### Failures Must Stay Useful

Custom assertions should include helpful failure context:

- current screen text when text is missing;
- rendered width and offending line when a TUI width check fails;
- run id, task id, and manifest path when a workflow persistence assertion fails;
- journal path and parsed events when a journal assertion fails;
- fake-agent call list when an agent assertion fails.

### No Production Coupling

Testing helpers must live under `test/`. Production modules must not import from
or depend on the DSL. The DSL may import production types and public APIs.

## Non-Goals

- Do not replace Vitest, `expect`, or fast-check.
- Do not hide every assertion behind helper methods.
- Do not make property tests use page objects unless that clarifies the invariant.
- Do not introduce live model calls.
- Do not mock scheduler internals when the fake-agent boundary is enough.
- Do not make the DSL depend on the user's real `~/.pi` or project `.pi` data.

## Target File Layout

Initial target layout:

```text
test/
  builders/
    workflow-agent.ts
    workflow-run.ts
    workflow-script.ts
  extension/
    tui/
      workflows-screen.ts
  workflows/
    launch/
      workflow-scenario.ts
```

Optional later helpers:

```text
test/
  workflows/
    journal/
      journal-assertions.ts
    saved/
      saved-workflow-scenario.ts
```

## Layer 1: Domain Builders

Builders create valid domain objects with boring defaults and explicit important
fields. They are for test readability, not for generating arbitrary data.

### Workflow Run Builder

Target examples:

```ts
const run = workflowRun.running("hardening", {
  phases: ["Slice", "Author"],
  agents: [
    workflowAgent.running("slice:P0.1-journal-keying", { phase: "Slice" }),
    workflowAgent.done("author:pipeline", { phase: "Author", result: "ok" }),
  ],
});

const completed = workflowRun.completed("review", {
  result: { summary: "ok" },
  outputPath: "/tmp/wf_test/output.json",
});
```

Target API:

```ts
workflowRun.running(name, options?)
workflowRun.completed(name, options?)
workflowRun.failed(name, options?)
workflowRun.stopped(name, options?)
workflowRun.paused(name, options?)
```

Options should support:

- `runId`;
- `taskId`;
- `description`;
- `phases` as strings or phase objects;
- `agents` as `WorkflowAgentProgress[]`;
- `logs`;
- `script`;
- `scriptPath`;
- `startTime`;
- terminal fields such as `endTime`, `durationMs`, `result`, `error`, and
  `outputPath`.

Defaults should be stable and deterministic. Use constants like `wf_test`,
`task_test`, and `NOW` only when doing so cannot create confusion in multi-run
tests.

### Workflow Agent Builder

Target examples:

```ts
const scan = workflowAgent.queued("scan:src", { phase: "Scan" });
const review = workflowAgent.running("review:security", { tool: "Read" });
const verify = workflowAgent.done("verify:tests", { result: "valid" });
const failed = workflowAgent.failed("verify:api", { error: "timeout" });
```

Target API:

```ts
workflowAgent.queued(label, options?)
workflowAgent.running(label, options?)
workflowAgent.done(label, options?)
workflowAgent.failed(label, options?)
workflowAgent.stopped(label, options?)
```

Options should support:

- `index`;
- `agentId`;
- `phase` / `phaseTitle`;
- `prompt`;
- `promptPreview`;
- `agentType`;
- `model`;
- `attempt`;
- `tokens`;
- `toolCalls`;
- `tool` / `lastToolName`;
- `result` / `resultPreview`;
- `error`.

### Workflow Script Builder

`test/workflows/script/workflow-factory.ts` already provides a useful
`workflowScript(...)` helper. The future builder layer should either keep that
file as-is or re-export it from `test/builders/workflow-script.ts`.

Do not create a second competing script factory.

## Layer 2: `/workflows` Screen Object

The screen object wraps `WorkflowsTuiComponent` tests. It should make tests read
like user interaction with the `/workflows` monitor while still allowing raw key
checks.

### Target Examples

Overview rendering:

```ts
it("should render the overview with phases and agent metrics", () => {
  const run = workflowRun.running("hardening", {
    phases: ["Slice", "Author"],
    agents: [workflowAgent.running("slice:P0.1-journal-keying", { phase: "Slice" })],
  });

  const screen = workflowsScreen([run]).atWidth(120).render();

  screen.shouldShowOverview();
  screen.shouldShowPhase("Slice");
  screen.shouldShowAgent("slice:P0.1-journal-keying");
  screen.shouldShowControls("↑↓ select", "← detail", "x stop workflow");
  screen.shouldFitWidth();
});
```

Agent-detail navigation:

```ts
it("should render agent detail after opening the selected agent", () => {
  const run = workflowRun.running("audit", {
    agents: [workflowAgent.running("review:security")],
  });

  const screen = workflowsScreen([run]).atWidth(120);

  screen.openSelectedAgent();

  screen.shouldShowAgentDetail("review:security");
  screen.shouldShowSection("Prompt");
  screen.shouldShowSection("Outcome");
});
```

Confirmation flow:

```ts
it("should require confirmation before stopping a workflow", () => {
  const screen = workflowsScreen([workflowRun.running("audit")])
    .withStopRunSpy()
    .atWidth(120);

  screen.requestStopWorkflow();
  screen.shouldAskForConfirmation("Stop workflow?");

  screen.confirm();
  screen.shouldHaveStoppedRun("wf_test");
});
```

### Target API Shape

Construction:

```ts
workflowsScreen(runs, options?)
```

Options:

- `now`;
- `theme`;
- `savedWorkflowCount`;
- callbacks such as `onClose`, `onStopRun`, `onStopAgent`, `onRestartAgent`,
  `onPauseRun`, and `onSaveRun`.

Rendering and input:

```ts
screen.atWidth(width)
screen.render()
screen.text()
screen.lines()
screen.press(key)
screen.press.up()
screen.press.down()
screen.press.left()
screen.press.right()
screen.press.enter()
screen.press.escape()
```

Semantic actions:

```ts
screen.openSelectedAgent()
screen.openOriginalPrompt()
screen.goBack()
screen.requestStopWorkflow()
screen.requestStopAgent()
screen.confirm()
screen.cancel()
screen.restartAgent()
screen.pauseOrResumeRun()
screen.saveRun()
```

Assertions:

```ts
screen.shouldShowText(textOrPattern)
screen.shouldNotShowText(textOrPattern)
screen.shouldShowOverview()
screen.shouldShowRunChooser()
screen.shouldShowAgentDetail(label)
screen.shouldShowOriginalPrompt(label?)
screen.shouldShowPhase(title)
screen.shouldShowAgent(label)
screen.shouldShowSection(title)
screen.shouldShowControls(...fragments)
screen.shouldAskForConfirmation(message)
screen.shouldFitWidth()
screen.shouldHaveClosed()
screen.shouldHaveStoppedRun(runId)
screen.shouldHaveStoppedAgent(agentId)
screen.shouldHaveRestartedAgent(agentId)
screen.shouldHaveSavedRun(runId)
```

### Raw-Key Escape Hatch

Some tests should explicitly protect keybindings. The screen object must allow
raw key input:

```ts
screen.press("\x1b[D");
screen.shouldShowAgentDetail("review:security");
```

Semantic actions should be implemented in terms of raw keys so key mappings stay
centralized in the helper.

### Width Contract

`screen.shouldFitWidth()` should:

1. render at the current width;
2. strip VT control characters;
3. assert every rendered line has `visibleWidth(line) <= width`;
4. report all offending lines, not just the first one.

This should preserve the current golden/snapshot readability convention from
`docs/testing-reference.md`.

## Layer 3: Workflow Scenario Harness

The workflow scenario harness wraps filesystem integration tests around the
launcher, run store, journal, output file, and fake-agent server.

### Target Examples

Inline launch:

```ts
const scenario = await workflowScenario()
  .withScript(
    workflowScript({
      meta: { name: "review", phases: [{ title: "Review" }] },
      body: `
        phase("Review");
        return await agent("review src", { label: "review-agent", phase: "Review" });
      `,
    }),
  )
  .withAgents(agent.label("review-agent").replyText("ok"))
  .launch();

scenario.shouldHaveReturnedImmediately();
scenario.shouldHaveWrittenScriptCopy();
scenario.shouldHaveWrittenInitialManifest();

await scenario.complete();

scenario.shouldHaveCompletedWithResult("ok");
scenario.shouldHaveOutputFile();
scenario.shouldHaveJournalEvent("started", { label: "review-agent" });
scenario.shouldHaveJournalEvent("result", { label: "review-agent" });
scenario.agents.shouldHaveNoUnhandledCalls();
```

Saved workflow launch:

```ts
const scenario = await workflowScenario()
  .withSavedWorkflow("review", projectScript)
  .withPersonalWorkflow("review", personalScript)
  .withAgents(agent.label("review-agent").replyText("project result"))
  .launchByName("review");

await scenario.complete();

scenario.shouldHaveUsedProjectSavedWorkflow("review");
scenario.shouldHaveCompletedWithResult("project result");
```

Pending agent timing:

```ts
const scan = agent.pending({ label: "scan-agent" });

const scenario = await workflowScenario()
  .withScript(script)
  .withAgents(scan)
  .launch();

scenario.shouldHaveReturnedImmediately();
scenario.shouldHaveWrittenInitialManifest();
expect(scan.started).toBe(false);

await scan.waitUntilStarted();
scan.resolve("done");
await scenario.complete();
```

### Target API Shape

Construction and configuration:

```ts
workflowScenario(options?)
  .withNow(valueOrFn)
  .withIds({ runId, taskId })
  .withRootDir(path)
  .withScript(source, args?)
  .withScriptPath(path, source?)
  .withSavedWorkflow(name, source)
  .withPersonalWorkflow(name, source)
  .withAgents(...handlers)
  .withLaunchOptions(overrides)
```

Launch methods:

```ts
scenario.launch()
scenario.launchInline(script?, args?)
scenario.launchByName(name, args?)
scenario.launchByPath(path, args?)
scenario.resumeFrom(runId, script?, args?)
```

Completion:

```ts
scenario.complete()
scenario.expectLaunchError(tagOrMatcher)
```

Assertions:

```ts
scenario.shouldHaveReturnedTask(taskId)
scenario.shouldHaveReturnedRun(runId)
scenario.shouldHaveReturnedImmediately()
scenario.shouldHaveConfirmationText(...fragments)
scenario.shouldHaveWrittenScriptCopy(expectedSource?)
scenario.shouldHaveWrittenInitialManifest(matcher?)
scenario.shouldHaveManifest(matcher)
scenario.shouldHaveStatus(status)
scenario.shouldHaveCompletedWithResult(result)
scenario.shouldHaveFailedWithError(matcher)
scenario.shouldHaveOutputFile(matcher?)
scenario.shouldHaveTaskNotification(matcher?)
scenario.shouldHaveJournalEvent(type, matcher?)
scenario.shouldNotHaveJournalEvent(type, matcher?)
scenario.shouldHaveUsedProjectSavedWorkflow(name)
scenario.shouldHaveUsedPersonalSavedWorkflow(name)
scenario.shouldNotHaveCreatedRunStorage()
```

Useful exposed properties:

```ts
scenario.tempDir
scenario.rootDir
scenario.runId
scenario.taskId
scenario.scriptPath
scenario.transcriptDir
scenario.outputPath
scenario.journalPath
scenario.agents
scenario.store
```

### Cleanup

The harness should create isolated temp directories and clean them up after each
test. It may expose a `cleanup()` method, but normal use should be automatic via
Vitest lifecycle hooks or an async helper wrapper.

The harness must never write to the user's real `~/.pi` directory or project
`.pi/workflows` directory unless a test explicitly passes a temp path that points
there.

## Layer 4: Journal Assertions

Journal assertions can start inside the workflow scenario harness. If they grow,
extract them to `test/workflows/journal/journal-assertions.ts`.

Target examples:

```ts
scenario.journal.shouldHaveEvents(["started", "result"]);
scenario.journal.shouldHaveAgentResult("review-agent", "ok");
scenario.journal.shouldNotHaveInvalidEvents();
```

Keep journal assertions grounded in `spec.md` and ADR 0008:

- JSONL append order matters;
- `started` is written before agent execution;
- `result` is written only after successful validation;
- replay uses latest non-invalidated result.

## Relationship To Existing Agent Mock DSL

The fake-agent mock already has an MSW-style DSL:

```ts
setupAgentMock(
  agent.label("review-agent").replyText("ok"),
);
```

The page-object/testing DSL should reuse this API rather than replace it. The
workflow scenario harness should expose the configured fake-agent server as
`scenario.agents` so existing assertions remain available:

```ts
scenario.agents.expectNoUnhandledAgents();
scenario.agents.expectAgentCalledTimes({ label: "review-agent" }, 1);
```

## Migration Plan

### Slice 1: Builders Only

Add `test/builders/workflow-run.ts` and `test/builders/workflow-agent.ts`.
Refactor a small number of TUI tests that currently construct large object
literals.

Acceptance criteria:

- builder defaults produce valid `WorkflowRunState` and `WorkflowAgentProgress`;
- refactored tests are shorter without losing explicit assertions;
- `pnpm test`, `pnpm run check`, and `pnpm run lint` pass.

### Slice 2: `/workflows` Screen Object

Add `test/extension/tui/workflows-screen.ts` and refactor several
`WorkflowsTuiComponent` tests.

Acceptance criteria:

- common render/input/width checks use the screen object;
- keybinding-specific tests can still use raw key input;
- width failures print useful offending-line context;
- no production code changes are required.

### Slice 3: Launcher Scenario Harness

Add `test/workflows/launch/workflow-scenario.ts` and refactor a small cluster of
launcher tests.

Acceptance criteria:

- temp directory setup, root-dir setup, fake clock setup, and fake-agent wiring
  move out of individual tests;
- launch tests still assert script copies, run manifests, journal JSONL, output
  files, and notifications explicitly;
- pending-agent timing tests remain precise.

### Slice 4: Broader Refactor

Refactor the rest of the noisy tests opportunistically. Do not churn direct unit
or property tests where the DSL does not improve clarity.

Acceptance criteria:

- behavior names remain `should ...`;
- tests read closer to the workflow/domain spec;
- failure output stays at least as actionable as before.

## Review Checklist For Future Implementation

Before merging the DSL refactor, verify:

- helpers live under `test/` only;
- helpers do not call live models;
- helpers do not write to real user Pi config or project workflow data;
- custom assertions include enough debug context;
- direct tests remain direct when helper indirection would obscure the invariant;
- `docs/testing-reference.md` links to this spec;
- `pnpm run check`, `pnpm test`, and `pnpm run lint` pass.
