# Ultracode Trigger And Real Agent Implementation Spec

## Purpose

Implement `ultracode` as the user-facing trigger and visual identity for Pi
dynamic workflows.

`ultracode` is not an LLM tool name. It is a TUI/editor trigger word and a
session-level policy switch. When a user types `ultracode`, Pi should visually
highlight that word with an animated rainbow/blink effect. When the user submits
a prompt beginning with `ultracode`, the extension should turn on a standing
session opt-in that steers the main agent toward workflow orchestration.

The workflow engine remains generic. `ultracode` is only the entrypoint and
experience layer that makes workflows feel native in Pi.

## Reference Material

Use these local references while implementing:

- `spec.md` for the Claude-Code-like workflow contract.
- `src/workflows/launch/launcher.ts` for the existing launch/persistence seam.
- `src/workflows/script/runtime.ts` for the sandbox runtime and host API.
- `src/workflows/agent/scheduler.ts` for queued/concurrent agent execution.
- `src/extension/commands/workflows-command.ts` for existing extension command
  wiring and `/workflows`.
- `/tmp/pi-real-compare/packages/coding-agent/src/core/extensions/types.ts` for
  current Pi extension APIs.
- `/tmp/pi-real-compare/packages/coding-agent/examples/extensions/rainbow-editor.ts`
  for animated editor rendering.
- `/tmp/pi-real-compare/packages/coding-agent/examples/extensions/input-transform.ts`
  for input interception.
- `/tmp/pi-real-compare/packages/coding-agent/examples/extensions/working-indicator.ts`
  for animated working indicators.
- `/tmp/pi-real-compare/packages/coding-agent/examples/extensions/structured-output.ts`
  for terminating structured output.
- `/tmp/pi-dynamic-workflows-compare/src/agent.ts` and
  `/tmp/pi-dynamic-workflows-compare/src/workflow-tool.ts` for a prototype
  in-process Pi subagent adapter and workflow guidance.

The `/tmp/pi-dynamic-workflows-compare` project is a helpful prototype, but do
not copy its architecture wholesale. This repository already has stronger
persistence, journal, resume, saved workflow, and `/workflows` foundations.

## Goals

- Show animated rainbow/blinking `ultracode` text in the Pi editor while the user
  types the trigger word.
- Intercept submitted prompts that begin with `ultracode`.
- Turn on a durable per-session `ultracode` mode.
- Inject Pi-native policy context before main-agent turns while the mode is on.
- Let the main agent author and launch persisted dynamic workflow runs through a
  model-facing workflow tool.
- Replace fake `agent()` execution with real Pi subagent sessions.
- Keep `/workflows` as the run monitor and controller.
- Persist terminal output and notify the main conversation when the workflow
  completes or fails.
- Make the first slice testable without live model credentials.

## Non-Goals

- Do not expose a public LLM tool named `ultracode`.
- Do not make `ultracode` a slash command only. A command can be a fallback, but
  the primary experience is typing the word in the editor.
- Do not bypass the existing `launchWorkflow()` persistence path.
- Do not implement nested `workflow()` in the first slice.
- Do not implement `agent({ isolation: "worktree" })` in the first slice.
- Do not require live model tests in CI.

## Pi API Facts From The Real Pi Repo

The real Pi extension API supports:

- `pi.on("session_start", handler)` for installing TUI customizations when a
  session starts.
- `ctx.ui.setEditorComponent(...)` for replacing the editor component.
- `CustomEditor` for custom editor rendering and input behavior.
- `pi.on("input", handler)` for intercepting submitted user input before the
  agent starts.
- Input handlers can return:
  - `{ action: "continue" }`
  - `{ action: "transform", text, images? }`
  - `{ action: "handled" }`
- `event.source` can be `"interactive"`, `"rpc"`, or `"extension"`. Extension
  injected input should be ignored by the ultracode input handler to avoid loops.
- `pi.on("before_agent_start", handler)` runs after prompt expansion and before
  the main agent loop. It can return a custom message and/or replacement system
  prompt for the upcoming turn.
- Custom messages returned from `before_agent_start` are persisted in the
  session and sent to the LLM as context for that turn.
- `pi.appendEntry(customType, data)` persists extension state as a custom session
  entry that does not participate in LLM context.
- `ctx.sessionManager.getEntries()` and `ctx.sessionManager.getBranch()` let the
  extension restore custom state on `session_start`.
- `ctx.ui.setWorkingIndicator(...)` can customize the streaming/running
  indicator.
- `pi.sendMessage(...)` injects a custom session message and can avoid triggering
  a new user turn.
- `pi.sendUserMessage(...)` sends an actual user message and always triggers an
  agent turn.
- `createAgentSession(...)` creates Pi agent sessions. Its `customTools` option
  accepts custom tool definitions. Its `tools` option is a tool-name allowlist,
  not an array of tool definitions.

## User Experience

### Typing

When the editor contains `ultracode`, render every case-insensitive occurrence
with animated styling:

- Rainbow character colors.
- A moving shine/highlight across the word.
- A subtle blink or pulse.
- Animation runs only while the trigger is present.
- Animation stops when the trigger is removed.

The editor must preserve normal editing behavior. Cursor movement, deletion,
multi-line input, and normal submission must still work.

### Submission

When the user submits text beginning with `ultracode`, for example:

```text
ultracode audit this repo for risky workflow bugs
```

the extension should treat `audit this repo for risky workflow bugs` as the
workflow goal.

Accepted trigger forms:

```text
ultracode <goal>
Ultracode <goal>
ULTRACODE <goal>
```

Rejected or ignored forms:

```text
please use ultracode for this
foo ultracode bar
ultracoder audit
```

The first implementation should require the trigger at the start of the prompt
to avoid accidental activation.

If the user submits only `ultracode` with no goal, do not launch. Show a warning
such as:

```text
Usage: ultracode <workflow goal>
```

### Running

After activation:

- Persist the `ultracode` mode transition as a custom session entry.
- Transform the triggering input so the main agent still receives the task.
- Inject an `ultracode` custom message and system-prompt policy through
  `before_agent_start`.
- Tell the main agent that workflow opt-in is automatic for substantive tasks.
- Expose a model-facing workflow launch tool that validates workflow scripts and
  calls `launchWorkflow(...)`.
- Persist launched runs under the resolved Pi workflow root
  (`.pi/workflows/<runId>/`, preferring an existing workspace-level ancestor root
  over a nested repo-local root).
- Wire `agent()` calls to real Pi sidechain sessions for plain-text agent
  results; do not leave workflow launches on the development fallback runner
  that echoes prompts.
- Let `/workflows` show each run and its agents.

### Completion

When a workflow reaches a terminal state:

- Write `.pi/workflows/<runId>/output.json`.
- Persist terminal `manifest.json`.
- Inject a custom task notification using `pi.sendMessage(...)`.
- Clear or reset the ultracode working indicator.

Do not use `sendUserMessage()` for terminal workflow notifications, because that
would create a new user message. Use `pi.sendMessage(..., { triggerTurn: true })`
for workflow completion so the main agent is re-invoked with the result.

## Architecture

Add the implementation in five layers.

### 1. Ultracode Mode State Machine

Suggested files:

```text
src/extension/ultracode/mode-state-machine.ts
src/extension/ultracode/session-mode-store.ts
```

Responsibilities:

- Model `off`, `arming`, `on`, and `disabled` states.
- Transition to `on` when a valid `ultracode <goal>` trigger is submitted.
- Restore mode from custom session entries on `session_start`.
- Append state-transition entries with `pi.appendEntry(...)`.
- Clear in-memory state on `session_shutdown` and restore from the replacement
  session when Pi switches/forks/resumes.

This layer is pure TypeScript except for the small adapter that reads and writes
Pi session entries.

### 2. Ultracode TUI Layer

Suggested files:

```text
src/extension/ultracode/rainbow-editor.ts
src/extension/ultracode/input-trigger.ts
src/extension/ultracode/working-indicator.ts
```

Responsibilities:

- Install the animated editor on `session_start`.
- Detect submitted `ultracode` prompts through the Pi `input` event.
- Coordinate UI state while ultracode mode is active and while workflows are
  running.

This layer depends on Pi extension/TUI APIs. It should not contain workflow
runtime logic.

### 3. Main-Agent Policy Injection

Suggested files:

```text
src/extension/ultracode/system-reminder.ts
src/extension/ultracode/workflow-authoring-prompt.ts
src/extension/ultracode/task-policy.ts
```

Responsibilities:

- Generate the short standing `ultracode is ON` reminder.
- Generate the full workflow-authoring contract for substantive tasks.
- Register a `before_agent_start` handler that injects a custom message and
  appends policy text to the system prompt while mode is `on`.
- Keep trivial chat turns and one-line mechanical edits allowed as solo work.
- Require dynamic workflow orchestration for substantive tasks.

### 4. Model-Facing Workflow Launch Tool

Suggested files:

```text
src/extension/tools/workflow-launch-tool.ts
src/extension/ultracode/launch-ultracode-workflow.ts
```

Responsibilities:

- Register a Pi tool named `Workflow` with `pi.registerTool(...)` that accepts
  the Claude-like launch parameters: `script`, `scriptPath`, `name`,
  `resumeFromRunId`, `args`, and ignored cosmetic `title`/`description`.
- Validate the generated script with the existing parser through
  `launchWorkflow(...)`.
- Return the launch confirmation, `runId`, `taskId`, and artifact paths to the
  main agent.
- Wire `rootDir`, `cwd`, `notifyTerminal`, real agent runner, and runtime
  options from the Pi extension context.
- Keep the direct `launchUltracodeWorkflow(...)` adapter only as a legacy or
  emergency fallback.

The tool must call the existing launcher rather than duplicating persistence
logic. The public tool name is `Workflow`; it must not be named `ultracode`.

### 5. Real Pi Agent Runner

Suggested files:

```text
src/workflows/agent/pi-runner.ts
src/workflows/agent/structured-output-tool.ts
src/workflows/agent/transcript-writer.ts
```

Responsibilities:

- Implement `WorkflowAgentRunner`.
- Create a fresh Pi sidechain session per `agent()` call.
- Use the same project `cwd`.
- Pass the current model/model registry where available.
- Abort the subagent when the scheduler signal aborts.
- Return final assistant text for unstructured calls.
- Return validated structured output for `agent({ schema })`.
- Persist transcript and metadata files.

## Launch Strategy

There are three viable launch strategies. Strategy C is the accepted path; see
[ADR 0012](../areas/adr/0012-use-pi-session-policy-for-ultracode.md).

### Strategy A: Transform To Main-Agent Workflow Authoring

Input handler behavior:

1. Detect `ultracode <goal>`.
2. Return `{ action: "transform", text }`, where `text` asks the main agent to
   create and run a dynamic workflow for the goal.
3. The main agent uses an internal workflow launcher tool or command path to
   start the run.

Pros:

- Lets the main model synthesize a workflow script from the user goal.
- Flexible for arbitrary goals.

Cons:

- Relies on the main model following workflow authoring instructions.
- Requires a generic workflow-launching tool or command to be available to the
  model. The user-facing name still must not be `ultracode`.
- Does not by itself create durable standing opt-in for later turns.

### Strategy B: Direct Saved Workflow Launch

Input handler behavior:

1. Detect `ultracode <goal>`.
2. Return `{ action: "handled" }`.
3. Directly call `launchWorkflow({ name: "ultracode", args: { goal } }, ...)`.

Pros:

- Deterministic.
- No model decision needed to launch.
- Easier to test end-to-end.

Cons:

- Requires a saved/default `ultracode` workflow script to exist or be bundled.
- Less flexible until workflow templates are mature.
- Bypasses the main-agent behavior change that `ultracode` is meant to signal.
- Treats `ultracode` as a one-shot command instead of a session policy.

### Strategy C: Pi Session Policy With Model-Facing Workflow Tool

Input handler behavior:

1. Detect `ultracode <goal>`.
2. Transition the mode state machine to `on`.
3. Persist the transition with `pi.appendEntry("ultracode-mode", ...)`.
4. Return `{ action: "transform", text }`, preserving the user's task while
   removing the trigger prefix or wrapping it with concise activation context.
5. On this and later turns, `before_agent_start` injects policy context when the
   session mode is `on`.
6. The main agent authors workflow scripts using the workflow-authoring prompt
   and launches them through the registered workflow launch tool.

Pros:

- Matches the intended standing opt-in behavior.
- Uses Pi's native input and pre-agent hooks.
- Keeps the main agent responsible for decomposition and phase sequencing.
- Keeps run creation in the existing `launchWorkflow(...)` path.
- Allows later substantive turns to inherit `ultracode` without repeating the
  keyword.

Cons:

- Requires a model-facing workflow launch tool and strong prompt policy.
- Requires tests for session-state restoration from custom entries.
- Enforcement is partly prompt/tool-contract based: the parser validates scripts,
  but the model must choose to call the tool for substantive work.

Recommended path:

1. Build Strategy C with a pure mode state machine and Pi `before_agent_start`
   policy injection.
2. Add the model-facing workflow launch tool.
3. Keep Strategy B's bundled workflow as a test fixture or fallback only.
4. Add deeper enforcement later by classifying trivial vs substantive tasks with
   a dedicated policy tool if prompt-only enforcement proves too weak.

## Workflow Authoring Prompt

When `ultracode` is on and the task is substantive, the main agent should receive
the workflow-authoring contract below, either in the `before_agent_start` system
prompt addition or in the workflow launch tool description.

```text
# Task: Write a Workflow script

You are writing a script for an agent-orchestration runtime. The script is
deterministic JavaScript that spawns subagents via helper functions. Produce a
single self-contained script. Before writing any code, do step 0.

## Step 0 — design first (output this as a short plan, then the script)

State, in 3-5 lines:
1. The work-list: what is the unit of work being fanned out over?
2. The stages each unit passes through (find -> verify -> synthesize, etc.).
3. Where, if anywhere, you genuinely need ALL results from one stage before the
   next can start (a "barrier"). Default answer: nowhere.
4. Which calls need structured output (a JSON schema) vs. plain text.

## Hard rules

- The script MUST begin with a pure literal `export const meta = { ... }` block.
- `meta` is a PURE LITERAL: no variables, function calls, spreads, or template
  strings inside it.
- `meta.phases` must be an array of objects such as `[{ title: "Inspect" }]`,
  never bare strings such as `["Inspect"]`.
- Phase titles in `meta.phases` must match `phase()` calls.
- It is JavaScript, not TypeScript.
- Forbidden: `Date.now()`, `Math.random()`, and argument-less `new Date()`.
- No filesystem or Node APIs.
- The body runs in an async context; use `await` directly.

## Helpers

- `agent(prompt, opts?)`
- `pipeline(items, stage1, stage2, ...)` — stage callbacks receive
  `(previousStageResult, originalItem, index)`; for the first stage,
  `previousStageResult === originalItem`.
- `parallel(thunks)`
- `phase(title)`
- `log(message)`
- `budget.total` / `budget.remaining()`

Default to `pipeline()`. Use a `parallel()` barrier only when a later stage
genuinely needs all earlier results together.

THE ACTUAL TASK:
<describe what the workflow should accomplish, the codebase/domain, and how
thorough it should be>
```

## Bundled Fallback Workflow

The previous direct-launch implementation used a minimal built-in workflow
script equivalent to:

```js
export const meta = {
  name: "ultracode",
  description: "Run an ultracode dynamic workflow for a user goal",
  whenToUse: "Use when the user starts a prompt with ultracode",
  phases: [{ title: "Explore" }, { title: "Synthesize" }],
}

phase("Explore")
const exploration = await agent(
  "Explore the project for this goal and return concise findings:\n" + args.goal,
  { label: "explore project", phase: "Explore" },
)

phase("Synthesize")
const synthesis = await agent(
  "Synthesize the final result for this goal:\n" +
    args.goal +
    "\n\nExploration:\n" +
    exploration,
  { label: "synthesize result", phase: "Synthesize" },
)

return { goal: args.goal, exploration, synthesis }
```

This remains useful as a fixture or fallback, but it is not the primary
`ultracode` behavior.

## Input Trigger Contract

Implement a pure parser first:

```ts
interface UltracodeTrigger {
  goal: string;
}

function parseUltracodeInput(text: string): UltracodeTrigger | undefined;
```

Rules:

- Trim only leading whitespace for matching.
- Match `ultracode` case-insensitively as a complete first word.
- Require at least one whitespace character after `ultracode` and a non-empty
  goal.
- Preserve the goal text after trimming surrounding whitespace.
- Return `undefined` when no trigger is present.

Examples:

| Input | Result |
| --- | --- |
| `ultracode audit repo` | `{ goal: "audit repo" }` |
| `  Ultracode audit repo` | `{ goal: "audit repo" }` |
| `ULTRACODE   audit repo` | `{ goal: "audit repo" }` |
| `ultracode` | no trigger; warn in UI |
| `ultracoder audit repo` | no trigger |
| `please ultracode audit repo` | no trigger |

## Editor Animation Contract

The animated editor should follow the Pi `rainbow-editor.ts` pattern:

- Extend `CustomEditor`.
- Call `super.handleInput(data)` for normal editing.
- Start a timer when `this.getText()` contains `ultracode`.
- Stop the timer when it no longer contains `ultracode`.
- On each timer tick, increment a frame counter and call `this.tui.requestRender()`.
- Override `render(width)` and replace case-insensitive `ultracode` matches with
  ANSI-colored text.

Implementation details:

- Use ASCII source code. ANSI escape sequences are acceptable.
- Keep the color palette in one constant.
- Keep the animation interval around 60-120ms.
- Clear the interval in a disposal method if the editor API exposes one. If not,
  clear it when `session_shutdown` fires by keeping a reference to the editor or
  by relying on the editor replacement lifecycle after checking the Pi API.
- The animation must not change the underlying editor text.

## Real Pi Agent Runner Contract

The runner implements the existing scheduler signature:

```ts
export type WorkflowAgentRunner = (
  request: WorkflowAgentRunRequest,
) => Promise<unknown>;
```

For each request:

1. Create a fresh Pi agent session.
2. Use `request.signal` to abort the session.
3. Build a subagent prompt from:
   - `request.options.label`
   - `request.options.phase`
   - `request.options.agentType`
   - `request.options.model`
   - `request.prompt`
   - structured output instructions when `schema` is present
4. Run one prompt through the subagent.
5. Persist transcript and metadata.
6. Resolve with final text or structured output.

Use `createAgentSession(...)` with:

- `cwd`
- `modelRegistry` from Pi context when available
- `model` from Pi context when available
- `sessionManager: SessionManager.inMemory(cwd)` for sidechain isolation
- `customTools` containing `structured_output` when schema is present

Important current Pi API detail:

- `customTools` is for tool definitions.
- `tools` is an allowlist of tool names.

Do not pass custom tool definitions through `tools`.

## Structured Output Contract

When `request.options.schema` is present:

- Register a terminating `structured_output` custom tool.
- Tell the subagent its final action must be a `structured_output` call.
- Capture the tool params as the agent result.
- If the subagent finishes without calling `structured_output`, fail the agent.
- Journal `result` only after structured output is captured.

Bounded retries are not part of the first slice. Before adding retries, record an
ADR for the retry/nudge policy because `spec.md` treats that as a durable
workflow behavior.

## Transcript And Metadata Contract

For each subagent write files under:

```text
.pi/workflows/<runId>/transcripts/<agentId>.json
.pi/workflows/<runId>/transcripts/<agentId>.metadata.json
```

Minimum transcript content:

- agent id
- journal key, if present
- prompt
- effective options
- final assistant text or structured result
- error, if failed
- timestamps

Minimum metadata content:

- agent id
- label
- phase
- agent type
- model
- token usage if available
- tool call count if available
- duration
- status

If Pi session messages expose token/tool usage, record it. If usage is not
available in the first slice, record `0` and leave a TODO comment near the
adapter, not in the manifest-writing code.

## Notification Contract

The existing launcher already exposes:

```ts
notifyTerminal?: WorkflowTerminalNotifier;
```

Wire it in the Pi extension layer:

```ts
notifyTerminal: (notification) => {
  pi.sendMessage(notification, { deliverAs: "followUp", triggerTurn: true })
}
```

For the ultracode trigger, wrap the generic task notification with an explicit
continuation instruction that includes the original `ultracode <goal>` text.
Pi converts custom messages into user-context messages, but it does not have a
built-in Claude-Code-specific task-notification policy. Without the explicit
instruction, the main agent may treat the XML as a passive status update or redo
the user request itself instead of continuing from the workflow result.

The notification must be sent only after:

1. `output.json` is written.
2. terminal `manifest.json` is persisted.

This ordering is already enforced by `launchWorkflow()` and should not be
duplicated elsewhere. `triggerTurn: true` is required so the main agent sees the
terminal workflow result and can continue from it instead of the notification
only rendering in the transcript.

## `/workflows` Relationship

Do not turn `/workflows` into the launch trigger.

Responsibilities:

- `ultracode`: animated trigger and launch entrypoint.
- `/workflows`: monitor, inspect, pause/resume/stop, and saved workflow manager.

Future `/workflows` UI can show an `ultracode`-launched run exactly like any
other workflow.

## Implementation Slices

### Slice 1: Pure Ultracode Input Parser

Files:

```text
src/extension/ultracode/input-trigger.ts
test/extension/ultracode/input-trigger.test.ts
```

Deliverable:

- `parseUltracodeInput(text)`.
- Tests for matching, non-matching, whitespace, and casing.

### Slice 2: Animated Ultracode Editor

Files:

```text
src/extension/ultracode/rainbow-editor.ts
test/extension/ultracode/rainbow-editor.test.ts
```

Deliverable:

- `UltracodeEditor` extending Pi `CustomEditor`.
- Render tests that assert `ultracode` is colorized without changing other text.
- Timer behavior tested with fake timers where practical.

### Slice 3: Mode State Machine And Session Store

Files:

```text
src/extension/ultracode/mode-state-machine.ts
src/extension/ultracode/session-mode-store.ts
test/extension/ultracode/mode-state-machine.test.ts
test/extension/ultracode/session-mode-store.test.ts
```

Deliverable:

- Pure transitions for `off -> arming -> on -> disabled`.
- Custom session entry serialization and restoration.
- Session shutdown clears in-memory state.
- Restoring a session with prior `ultracode-mode` entries puts the mode back in
  the expected state.

### Slice 4: Extension Wiring

Files:

```text
src/extension/index.ts
src/extension/ultracode/register-ultracode.ts
test/extension/ultracode/register-ultracode.test.ts
```

Deliverable:

- `session_start` installs the editor in TUI mode.
- `session_start` restores ultracode mode from `ctx.sessionManager.getEntries()`.
- `input` handler detects the trigger.
- Empty `ultracode` prompt warns and returns `handled`.
- Non-trigger input returns `continue`.
- Valid trigger transitions mode to `on`, appends a custom entry, and returns
  `transform` rather than `handled`.
- `event.source === "extension"` returns `continue`.

### Slice 5: Main-Agent Policy Injection

Files:

```text
src/extension/ultracode/system-reminder.ts
src/extension/ultracode/workflow-authoring-prompt.ts
test/extension/ultracode/system-reminder.test.ts
test/extension/ultracode/workflow-authoring-prompt.test.ts
```

Deliverable:

- `before_agent_start` injects a custom message while mode is `on`.
- The injected content states that `ultracode` is a standing session opt-in.
- The system prompt addition tells the main agent to author/run workflows for
  substantive tasks and to handle trivial turns solo.
- Tests prove no policy is injected while mode is `off`.

### Slice 6: Model-Facing Workflow Launch Tool

Files:

```text
src/extension/tools/workflow-launch-tool.ts
test/extension/tools/workflow-launch-tool.test.ts
```

Deliverable:

- Register a workflow launch tool with `pi.registerTool(...)`.
- Tool accepts a JavaScript workflow script plus optional args/description.
- Tool calls `launchWorkflow(...)` with Pi cwd/session/model context.
- Parser failures return clear tool errors.
- Successful launch returns task id, run id, script path, transcript dir, and
  confirmation text.
- The tool name is not `ultracode`.

### Slice 7: Legacy Direct Launch Fallback

Files:

```text
src/extension/ultracode/launch-ultracode-workflow.ts
test/extension/ultracode/launch-ultracode-workflow.test.ts
```

Deliverable:

- Keep direct bundled launch covered by tests as an explicit fallback.
- Do not call it from the normal `ultracode <goal>` input path.

### Slice 8: Real Pi Agent Runner

Files:

```text
src/workflows/agent/pi-runner.ts
src/workflows/agent/transcript-writer.ts
test/workflows/agent/pi-runner.test.ts
```

Deliverable:

- Mocked Pi session tests prove the runner creates a session, prompts it, aborts
  it, captures final text, and disposes it.
- Filesystem test proves transcript and metadata files are written.

### Slice 9: Structured Output

Files:

```text
src/workflows/agent/structured-output-tool.ts
test/workflows/agent/structured-output-tool.test.ts
```

Deliverable:

- `agent({ schema })` returns captured structured params.
- Missing structured output fails the agent.
- Journal result is written only after valid capture.

### Slice 10: Polished Running Indicator

Files:

```text
src/extension/ultracode/working-indicator.ts
test/extension/ultracode/working-indicator.test.ts
```

Deliverable:

- While an ultracode workflow is running, set rainbow/pulse working indicator.
- Clear indicator after completion/failure.
- Tests use fake UI context.

## Test Plan

### Unit Tests

#### Input Parser

Use table-driven tests:

```ts
it.each([
  ["ultracode audit repo", "audit repo"],
  ["  Ultracode audit repo", "audit repo"],
  ["ULTRACODE   audit repo", "audit repo"],
])("detects trigger %#", ...)
```

Non-trigger cases:

```ts
[
  "",
  "ultracode",
  "ultracode   ",
  "ultracoder audit repo",
  "please ultracode audit repo",
]
```

#### Editor Rendering

Assertions:

- Rendered lines contain ANSI escape sequences around `ultracode`.
- Rendered lines preserve non-trigger text.
- Multiple occurrences are colorized.
- Case-insensitive occurrences are colorized.
- No color codes are added when no trigger is present.

Use fake timers to assert:

- Timer starts when text contains trigger.
- Timer stops when trigger is deleted.
- Render is requested on ticks.

#### Extension Input Event

Mock `ExtensionAPI`:

- Captures registered `input` handler.
- Captures registered `session_start` handler.

Assertions:

- `event.source === "extension"` returns `continue`.
- non-trigger returns `continue`.
- empty trigger warns and returns `handled`.
- valid trigger transitions mode to `on`.
- valid trigger appends an `ultracode-mode` custom entry.
- valid trigger returns `transform`, not `handled`.

#### Policy Injection

Assertions:

- `before_agent_start` returns no message/system prompt change while mode is
  `off`.
- `before_agent_start` returns an ultracode custom message while mode is `on`.
- The system prompt addition includes the workflow-authoring contract.
- Trivial-task allowance and substantive-task workflow requirement are both
  present.

### Filesystem Integration Tests

Use temp directories and the existing `launchWorkflow()` test style.

Scenario:

1. Create fake Pi command/input context with `cwd = tempDir`.
2. Submit `ultracode audit repo`.
3. Assert the transformed prompt reaches the main-agent path.
4. Call the workflow launch tool with a deterministic script and fake scheduler
   runner.
5. Assert:

   - `.pi/workflows/<runId>/manifest.json` exists.
   - copied `script.js` exists.
   - `journal.jsonl` has started/result events.
   - `output.json` exists after completion.
   - notification payload points to output file.
   - `/workflows` can list the run.

Legacy fallback scenario:

1. Call `launchUltracodeWorkflow(...)` directly in a test.
2. Use fake scheduler runner with deterministic outputs.
4. Assert:
   - `.pi/workflows/<runId>/manifest.json` exists.
   - copied `script.js` exists.
   - `journal.jsonl` has started/result events.
   - `output.json` exists.
   - notification payload points to output file.
   - `/workflows` can list the run.

### Pi Runner Tests With Mocked Session

Do not require real credentials.

Mock or inject a session factory that returns:

- `prompt(promptText)`
- `messages`
- `abort()`
- `dispose()`

Assertions:

- `prompt()` receives built subagent prompt.
- abort signal calls `session.abort()`.
- final assistant text is returned.
- `dispose()` is called in success and failure cases.
- transcript files are written.

### Structured Output Tests

Use a fake session/tool execution path:

- Valid structured output resolves object.
- Missing structured output rejects with clear message.
- Captured structured output appears in transcript.
- No prose fallback is accepted when schema was requested.

### End-To-End Manual Smoke Test

Run locally in Pi after implementation:

```bash
pnpm run check
pnpm test
pnpm run lint
pnpm run fmt:check
pnpm run pi
```

In the Pi TUI:

```text
ultracode inspect this repository and summarize the workflow modules
```

Expected:

- `ultracode` animates while typed.
- Submission starts a workflow.
- `/workflows` shows a running run.
- Completion notification appears.
- `.pi/workflows/<runId>/output.json` contains the final result.

Live model smoke tests should be opt-in only, for example behind an environment
variable such as `PI_E2E_LIVE=1`.

## Risks And Decisions To Record

Add or update ADRs for:

- Whether the first trigger path is direct saved workflow launch or Pi session
  policy with transformed main-agent authoring. Current decision:
  [ADR 0012](../areas/adr/0012-use-pi-session-policy-for-ultracode.md).
- How `agentType` maps to Pi concepts.
- Structured-output retry/nudge policy.
- Transcript retention and privacy policy.
- Whether bundled workflows live as package assets or source string constants.

## Acceptance Criteria

The implementation is ready for the first `ultracode` milestone when:

- Typing `ultracode` in TUI animates the word without breaking editor behavior.
- Submitting `ultracode <goal>` turns on session mode and transforms the prompt
  for the main agent.
- While mode is on, `before_agent_start` injects the standing opt-in policy.
- The main agent can launch a persisted workflow run through the workflow launch
  tool.
- The first state-machine/policy slices work without live model credentials.
- Real Pi subagent runner exists behind an injectable seam and is covered by
  mocked-session tests.
- Terminal workflow output and notification are persisted/sent through the
  existing launcher path.
- `/workflows` lists workflow runs launched while ultracode mode is active.
- No user-facing LLM tool named `ultracode` is registered.
