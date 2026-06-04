# AGENTS.md

This is the `pi-dynamic-workflow-extension` repository: a TypeScript Pi package that adds a dynamic `workflow` tool and a native `/workflows` dashboard. It lets Pi run deterministic JavaScript orchestration scripts, fan work out to isolated subagents, persist and resume background jobs, save workflows as reusable slash commands, and show live progress in the Pi TUI.

The package is written in strict TypeScript for Node.js 22+, uses Vitest for tests, `tsc` for builds, and imports Pi APIs from `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`.

## Why This Extension Exists

The goal is to bring Claude Code-style explicit workflow orchestration to Pi as a normal Pi extension. Pi should be able to launch structured, observable, resumable multi-agent workflows without switching tools: the same ideas users like in Claude Code workflows, but integrated into Pi's tool system, slash commands, persistence, and native TUI.

## Before Changing Code

1. Run `git status --porcelain=v1 -b` first. This repo often has in-progress work; do not overwrite unrelated changes.
2. Read `README.md` for the current install, runtime behavior, commands, persistence locations, and trust model.
3. Read the nearest relevant doc or README before editing an area:
   - `src/prompts/README.md` before prompt work.
   - `tests/suite/README.md` before adding suite tests.
   - The matching `docs/*-spec.md` before implementing planned workflow, TUI, budget, schema, or hardening work.
4. For Pi extension/package/TUI API changes, verify against the installed Pi docs/examples, not memory:
   - `@earendil-works/pi-coding-agent/docs/extensions.md`
   - `@earendil-works/pi-coding-agent/docs/packages.md`
   - `@earendil-works/pi-coding-agent/docs/tui.md`
   - `@earendil-works/pi-coding-agent/examples/extensions/`
5. Prefer small, behavior-backed changes with focused tests. Do not rewrite broad areas unless explicitly asked.

## Building and Running

### Build Commands

- **Install dependencies**: `npm install`
- **TypeScript build**: `npm run build`
  - Runs `tsc -p tsconfig.json` and emits `dist/`.
- **Full quality gate**: `npm test`
  - Runs `npm run check`, `npm run build`, then all Vitest tests.
- **Check only**: `npm run check`
  - Runs `vp check` plus `tsc -p tsconfig.json --noEmit`.
- **Lint only**: `npm run lint`
- **Format write**: `npm run format`

### Running the Extension Manually

- **Quick local Pi run without installing**:

```sh
pi -e ./extensions/workflow.ts
```

- **Install locally while developing**:

```sh
npm install
npm run build
npm test
pi install /absolute/path/to/pi-dynamic-workflow-extension
```

Then run `/reload` inside Pi.

The package entry point is declared in `package.json` under `pi.extensions` and points at `extensions/workflow.ts`.

## Testing

### Test Commands

- **Root unit tests**: `npm run test:unit`
  - Runs `vitest --run tests/*.test.ts`.
- **Harness suite tests**: `npm run test:suite`
  - Runs deterministic Pi-style tests under `tests/suite/` and `tests/suite/regressions/`.
- **Pi CLI e2e smoke tests**: `npm run test:e2e`
  - Runs `tests/e2e/*.test.ts` through the real `pi` CLI in JSON mode.
  - These tests use test probes/fake workflow agents and should not require real LLM calls, API keys, paid tokens, or network services.
- **Live real-model e2e test**: `npm run test:e2e:live`
  - Gated by `PI_E2E_LIVE=1` and skipped under `CI`.
  - Uses the real `pi` CLI, real extension loading, stored local Pi auth, and a real model/subagent call.
  - Optionally set `PI_E2E_LIVE_MODEL="provider/model"` to choose the model.
- **All tests**: `npm test`

### Test Organization

- `tests/*.test.ts` — focused unit/characterization tests for runtime, parser, display, browser, library, prompts, package contract, and trigger behavior.
- `tests/suite/` — deterministic harness tests for extension lifecycle, commands, workflow manager/tool/runtime integration, and broad regressions.
- `tests/suite/regressions/` — issue- or bug-specific regression tests. Name new files `regression-<issue-number-or-slug>.test.ts` when there is no issue number.
- `tests/support/` — faux agents/providers, temp-dir helpers, waits, and extension harnesses.
- `tests/e2e/` — real Pi CLI extension-loading/runtime smoke tests and probe extensions.

### Writing Tests

- Use Vitest and Node assertions (`node:assert/strict`) following neighboring tests.
- Prefer existing test files for the behavior you are changing. Add new files only when the behavior has no natural home.
- Use faux agents/providers, temp directories, in-memory managers, and explicit cleanup.
- Do not call real provider APIs, real API keys, network services, or paid tokens except in explicitly live-gated tests such as `tests/e2e/*.live.test.ts`.
- For extension behavior, prefer `tests/support/extension-harness.ts` and `tests/suite/harness.ts` patterns.
- For workflow agent tests, use `tests/support/faux-workflow-agent.ts` or a local faux prompt session.
- For persistence tests, keep stores under temp dirs; never write to the real `~/.pi/agent/workflows` or a real project `.pi/workflows` unless the test is explicitly an isolated e2e temp project.
- Keep tests deterministic. Avoid sleeping when you can wait for a specific condition with `tests/support/wait.ts`.

### Writing Real Automated E2E Tests

A real automated Pi e2e test should exercise Pi the way a user/model actually does, not call this package's internals directly.

- Launch the real `pi` binary with `spawn("pi", ...)`, normally in `--mode json`, `--no-session`, and `--no-extensions` mode.
- Load the extension under test via Pi's extension mechanism (`-e ./extensions/workflow.ts`) plus a small probe extension (`-e tests/e2e/<probe>.ts`).
- Use a fresh temp cwd and write probe output/state into that temp dir. Assert the output file exists so extension command failures do not degrade into misleading `ENOENT` errors.
- For real-model tests, gate with `PI_E2E_LIVE=1`, skip under `CI`, and allow `PI_E2E_LIVE_MODEL` overrides. Capture `ctx.model` in probe output so the test proves which local authenticated model Pi selected.
- Do not treat `pi.getAllTools()` as executable tool handles. Pi docs say it returns metadata only (`name`, `description`, `parameters`, `promptGuidelines`, `sourceInfo`). Do not call `getAllTools().find(...).execute(...)`.
- To test tool use end-to-end, send or transform a normal user prompt, restrict active tools with `pi.setActiveTools([...])` when needed, and observe `tool_execution_start` / `tool_execution_end` events to prove the model invoked the registered tool.
- To test workflow background behavior, wait for persisted workflow state under the temp project's `.pi/workflows/<runId>/manifest.json` instead of inspecting in-memory objects from the extension.
- Assert the full chain that matters: extension registered, model called the tool, tool completed successfully, background workflow persisted and completed, and any workflow `agent()` subagent returned the expected real-model result.

## Code Architecture

### Package and Extension Entry Points

- `package.json` — npm metadata, scripts, `exports`, peer dependencies, Node engine, and Pi extension declaration.
- `extensions/workflow.ts` — thin Pi package adapter. It should stay small: import `registerWorkflowExtension`, create default deps, and register.
- `src/index.ts` — public TypeScript exports for consumers and tests.
- `types/workflow.d.ts` — ambient workflow-author globals for scripts (`agent`, `parallel`, `pipeline`, `artifact`, `phase`, `log`, `args`, `cwd`, `budget`). Keep this in sync with runtime behavior.

### Extension Registration (`src/extension/`)

- `src/extension/register-workflow-extension.ts` — wires the package into Pi:
  - registers the `workflow` tool,
  - transforms native trigger text (`ultracode`, `quick workflow`, `use workflow to ...`),
  - registers `/workflows`, `/workflow-save`, `/workflow-list`, `/workflow-edit`, `/workflow-delete`, `/workflow-refresh`, and `/workflow-resume`,
  - attaches per-project workflow storage on `session_start`,
  - updates the footer status key `workflow` as `workflows:N`,
  - interrupts running workflows on `session_shutdown`,
  - sends one `workflow-completion` message when a current-session background workflow settles.
- `src/extension/workflow-extension-deps.ts` — dependency injection boundary for manager, tool, browser, global workflow library, store factory, completion formatter, and test start options.
- `src/extension/workflow-extension-format.ts` — formats workflow completion messages via `workflow-report`.

Keep extension registration thin and testable by injecting dependencies instead of reaching directly into real home/project storage in tests.

### Workflow Runtime (`src/workflow.ts`)

`src/workflow.ts` is the core deterministic orchestration runtime. It owns:

- `parseWorkflowScript()` and literal `export const meta = ...` validation.
- Determinism checks for obvious `Date.now()`, `new Date()`, and `Math.random()` uses, including runtime facades for `Date` and `Math`.
- The VM context and supported workflow globals:
  - `agent(prompt, opts)`
  - `parallel(thunks)`
  - `pipeline(items, ...stages)`
  - `artifact(name, value, opts)`
  - `phase(title)`
  - `log(message)`
  - `args`
  - `cwd`
  - `budget`
  - a constrained `process.cwd()` facade and console logging facade.
- Agent journal keys and in-memory/file journals.
- Concurrency limiting for agent calls.
- Abort and `timeoutMs` handling at async boundaries.
- JSON-serializable and structured-cloneable boundaries for workflow results, agent results, and artifacts.

Important runtime facts:

- Workflow scripts must start with literal `export const meta = { name, description }`.
- `meta.name` must be short `snake_case` starting with a lowercase letter.
- Workflow scripts must call `agent()` at least once or the tool/manager treats the run as invalid.
- `parallel()` requires thunks/functions, not already-started promises.
- `pipeline()` runs each stage over all items with `Promise.all` before moving to the next stage.
- `budget` currently tracks estimated tokens from serialized agent results, not real provider usage. Check `docs/workflow-usage-budget-spec.md` before changing this.
- `model`, `isolation`, and `agentType` options are prompt/runtime hints today; do not imply hard model routing or process/worktree isolation unless you implement and test it.
- `node:vm` restrictions are guardrails, not a strong security sandbox. Do not market workflow execution as safe for untrusted scripts.

### Workflow Tool (`src/workflow-tool.ts`)

`createWorkflowTool()` exposes the LLM-facing `workflow` tool.

- With a shared manager, it starts workflows in the background and returns immediately with a message telling the main agent to yield and use `/workflows` for progress.
- Without background mode, it can run in the foreground and stream display snapshots via tool updates.
- It normalizes legacy raw-string tool args into `{ script }`.
- It uses prompt text from `src/prompts/workflow-tool.*`.
- It renders partial/final workflow UI through `WorkflowDashboard` and `display` snapshots.

When changing the tool contract, update tests, README, prompt docs, and `types/workflow.d.ts` together.

### Workflow Manager and Persistence (`src/workflow-manager.ts`)

`WorkflowManager` owns background jobs.

- Statuses: `running`, `done`, `error`, `cancelled`, `interrupted`.
- `start()` parses metadata, creates a `wf_<uuid>` run id, saves the script, starts `runWorkflow()`, and notifies listeners.
- `resume()` reuses the stored script/journal and resets the snapshot.
- `cancel()` marks a user-cancelled job and aborts it.
- `interrupt()` marks session-shutdown interruption separately from user cancellation.
- `attachStore()` restores persisted jobs; previously `running` jobs become `interrupted`.

File persistence from `createFileWorkflowStore(rootDir)` writes:

- `<rootDir>/<runId>/manifest.json`
- `<rootDir>/<runId>/journal.jsonl`
- `<rootDir>/scripts/<workflow-name>.workflow.js`

In the installed extension, project workflow runs live under `<project>/.pi/workflows`.

### Workflow Library (`src/workflow-library.ts`)

Saved reusable workflow commands are stored by `createFileWorkflowLibrary()`.

- Installed default location: `~/.pi/agent/workflows`.
- Files are named `<command>.workflow.js`.
- Command names must normalize to lowercase names starting with a letter and containing 2-64 letters, numbers, underscores, or hyphens.
- Saving/updating parses workflow metadata and rejects invalid scripts.

### Isolated Subagents and Structured Output

- `src/agent.ts` wraps `createAgentSession()` from Pi and creates a fresh in-memory session per workflow `agent()` call.
- Subagents do not share parent conversation history or other subagent history unless the workflow prompt passes context explicitly.
- Base subagent instructions live in `src/prompts/workflow-agent.ts`.
- Structured output support lives in `src/structured-output.ts` and `src/prompts/structured-output.ts`.
- Passing an own `schema` property to `agent()` requests structured output, even if the value is `null`.
- The subagent gets a `structured_output` tool and must call it for the parent workflow to receive the value.
- If the subagent omits `structured_output`, `WorkflowAgent` makes one repair turn with only that tool active; if it still omits it, the agent call fails.

### TUI and Display

- `src/workflow-browser.ts` — interactive `/workflows` browser. It handles key input, job switching, phase/agent/detail focus, detail scrolling, expand/collapse, cancel, save, rerun, and resume actions.
- `src/workflow-dashboard.ts` — compact tool-rendered dashboard for workflow tool partial/final output.
- `src/workflow-ui-format.ts` — shared width-safe formatting helpers, status glyphs, durations, token formatting, phase summaries, and truncation.
- `src/display.ts` — workflow snapshots, text rendering, artifact summaries, previews, and tool-update display snapshots.
- `src/workflow-report.ts` — completion report selection and text rendering.

TUI code must respect the render width. Use Pi TUI helpers such as `visibleWidth`/`truncateToWidth` through `workflow-ui-format.ts`; do not hand-roll ANSI slicing or let rendered lines exceed the provided width.

### Native Input Triggers and Prompts

- `src/workflow-trigger.ts` detects and transforms:
  - `ultracode <task>`
  - `quick workflow <task>`
  - `use [a] workflow to <task>`
- It ignores slash commands and extension-originated input.
- `src/prompts/workflow-trigger.ts` builds the transformed prompt and tells the main agent to launch a background workflow, then yield.
- `src/prompts/workflow-tool.md` is the readable source for workflow authoring guidance injected into the tool prompt.
- `src/prompts/workflow-tool.ts` loads the Markdown prompt and defines tool descriptions/follow-up text.
- `src/prompts/workflow-completion.ts` builds the message sent back to the main agent after a background workflow completes.

Prompt changes are product changes. Keep them concise, behaviorally accurate, and covered by prompt/contract tests where possible.

## Workflow Authoring Contract

When writing or reviewing workflow scripts in this repo, enforce this contract:

```js
export const meta = {
  name: 'short_snake_case',
  description: 'non-empty description',
  phases: [{ title: 'Phase' }]
}

phase('Phase')
const result = await agent('Task with all required context', {
  label: 'phase:worker',
  phase: 'Phase'
})
return { result }
```

Rules:

- The first statement must be literal `export const meta = ...`.
- Use `snake_case` for `meta.name`.
- Include useful `meta.phases` when the dashboard should show planned phases.
- Call `phase()` before visible work groups and `log()` after important reductions.
- Call `agent()` at least once.
- Always `await agent()`, `parallel()`, and `pipeline()`; never return unresolved promises.
- Use `parallel(items.map(item => () => agent(...)))` for independent fan-out. Passing promises directly is wrong.
- Use `pipeline()` for per-item staged work where each stage depends on the previous stage's output.
- Use schemas for subagent outputs consumed by workflow code.
- Use `artifact(name, value, options?)` for durable outputs. Names must be unique safe relative paths; values must be JSON-serializable.
- Return only JSON-serializable values: no functions, symbols, `BigInt`, `undefined`, promises, class instances, cyclic values, sparse arrays, or custom prototypes.
- Do not import modules, read files, call shell commands, or access network APIs inside the workflow script. Delegate repository, git, filesystem, and web work to subagents via `agent()`.

## Documentation Map

Read only the docs relevant to the work you are doing:

- `docs/native-workflow-tdd-product-plan.md` — product intent for native workflow UX, TDD orchestration, task slicing, verification, dashboard save/rerun, resume, routing, budgets, HITL prompts, and safety.
- `docs/workflow-primitives-spec.md` — primitive design for `artifact()`, plus proposed `validateArgs()`, `retry()`, and `withTimeout()`.
- `docs/workflow-correctness-hardening-spec.md` — known runtime, journal, fan-out, schema, cancellation, and VM-hardening findings with severity and test ideas.
- `docs/testing-strategy-refactor-spec.md` — desired Pi-style harness/testing direction and evidence from Pi core.
- `docs/agent-schema-output-spec.md` — schema-enforced subagent output design and acceptance criteria.
- `docs/workflow-tui-improvements-spec.md` — dashboard data model, navigation, rendering, completion report, and candidate files.
- `docs/workflow-ui-reference-screens-spec.md` — target reference screens and navigation behavior for the dashboard.
- `docs/active-workflows-header-spec.md` — active-only workflow header behavior.
- `docs/active-workflow-footer-status-spec.md` — richer footer status behavior.
- `docs/workflow-usage-budget-spec.md` — planned real usage-backed budgets; important because current budget is estimated.
- `docs/product-owner-review.md` — product thesis, adoption gaps, roadmap, and trust/privacy concerns.
- `docs/claude-workflow-authoring-prompt-review.md` — workflow prompt quality review and recommended authoring guidance.

## Important Development Notes

1. **Do not overwrite in-progress work.** This repo is often dirty; inspect status and diffs before editing.
2. **Keep `extensions/workflow.ts` thin.** Put behavior in `src/extension/` or injected dependencies.
3. **Keep runtime behavior and public docs in sync.** If primitives, commands, persistence, or workflow globals change, update `README.md`, `types/workflow.d.ts`, prompt text, and package-contract tests.
4. **Maintain JSON boundaries.** Workflow-visible results, artifact values, persisted snapshots, and completion details must stay JSON-serializable.
5. **Be honest about isolation.** Pi packages run with full system permissions, and the workflow VM is not a security boundary.
6. **Do not add production runtime dependencies casually.** Anything needed after `pi install` belongs in `dependencies`; Pi core packages imported by the extension should remain peer dependencies unless there is a deliberate packaging reason to change that.
7. **Use dependency injection for testability.** Prefer `WorkflowExtensionDeps`, faux agents, temp stores, and harnesses over hardcoded globals.
8. **TUI output must be width-safe.** Every rendered line should fit the width passed to `render(width)`.
9. **Session shutdown must not look like user cancellation.** Preserve the distinction between `interrupted` and `cancelled`.
10. **Completion notifications must be sent once.** See regression tests before touching completion announcement logic.
11. **Saved workflows are global; project runs are local.** Keep `~/.pi/agent/workflows` and `<project>/.pi/workflows` behavior separate.
12. **If you did not run tests, say so.** Be humble and precise in final messages, commits, and release notes.

## Release Automation

For version bumps, publishing, tags, or GitHub releases, use the project release skill:

- `.agents/skills/release/SKILL.md`

Do not improvise release steps unless the user explicitly asks to bypass the release skill.
