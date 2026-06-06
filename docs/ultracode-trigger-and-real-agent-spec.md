# Ultracode Trigger And Real Agent Implementation Spec

## Purpose

Implement `ultracode` as the user-facing trigger and visual identity for Pi
dynamic workflows.

`ultracode` is not an LLM tool name. It is a TUI/editor trigger word. When a user
types `ultracode`, Pi should visually highlight that word with an animated
rainbow/blink effect. When the user submits a prompt beginning with
`ultracode`, the extension should start the dynamic workflow launch path.

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
- Launch a persisted dynamic workflow run from that prompt.
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
to avoid accidental launches.

If the user submits only `ultracode` with no goal, do not launch. Show a warning
such as:

```text
Usage: ultracode <workflow goal>
```

### Running

After a launch starts:

- Show a short confirmation with `runId` and `scriptPath`.
- Set a rainbow/pulse working indicator while the workflow is active.
- Persist the run under the resolved Pi workflow root (`.pi/workflows/<runId>/`, preferring an existing workspace-level ancestor root over a nested repo-local root).
- Wire `agent()` calls to real Pi sidechain sessions for plain-text agent results; do not leave ultracode on the development fallback runner that echoes prompts.
- Let `/workflows` show the run and its agents.

### Completion

When a workflow reaches a terminal state:

- Write `.pi/workflows/<runId>/output.json`.
- Persist terminal `manifest.json`.
- Inject a custom task notification using `pi.sendMessage(...)`.
- Clear or reset the ultracode working indicator.

Do not use `sendUserMessage()` for terminal workflow notifications, because that
would trigger a new main-agent turn.

## Architecture

Add the implementation in three layers.

### 1. Ultracode TUI Layer

Suggested files:

```text
src/extension/ultracode/rainbow-editor.ts
src/extension/ultracode/input-trigger.ts
src/extension/ultracode/working-indicator.ts
```

Responsibilities:

- Install the animated editor on `session_start`.
- Detect submitted `ultracode` prompts through the Pi `input` event.
- Coordinate UI state while workflows are running.

This layer depends on Pi extension/TUI APIs. It should not contain workflow
runtime logic.

### 2. Workflow Launch Adapter

Suggested file:

```text
src/extension/ultracode/launch-ultracode-workflow.ts
```

Responsibilities:

- Convert an ultracode prompt into a `WorkflowLaunchRequest`.
- Call `launchWorkflow(...)`.
- Wire `rootDir`, `cwd`, `notifyTerminal`, real agent runner, and runtime
  options from the Pi extension context.

The adapter should call the existing launcher rather than duplicating persistence
logic.

### 3. Real Pi Agent Runner

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

There are two viable launch strategies. Implement Strategy B first.

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

Recommended path:

1. Build Strategy B with a simple bundled/default workflow for the first working
   vertical slice.
2. Add Strategy A later for open-ended workflow authoring once the model-facing
   workflow launch surface is designed.

## Bundled First Workflow

For the first shippable vertical slice, include a minimal built-in workflow
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

The actual bundled script may be stored as a string constant or as a package
asset. It must still pass the existing workflow parser.

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

### Slice 3: Extension Wiring

Files:

```text
src/extension/index.ts
src/extension/ultracode/register-ultracode.ts
test/extension/ultracode/register-ultracode.test.ts
```

Deliverable:

- `session_start` installs the editor in TUI mode.
- `input` handler detects the trigger.
- Empty `ultracode` prompt warns and returns `handled`.
- Non-trigger input returns `continue`.

### Slice 4: Direct Launch With Fake Agents

Files:

```text
src/extension/ultracode/launch-ultracode-workflow.ts
test/extension/ultracode/launch-ultracode-workflow.test.ts
```

Deliverable:

- Input `ultracode <goal>` calls `launchWorkflow(...)`.
- Uses bundled ultracode workflow script.
- Uses fake agent runner in tests.
- Writes manifest, journal, output, notification payload.
- `/workflows` can list the run.

### Slice 5: Real Pi Agent Runner

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

### Slice 6: Structured Output

Files:

```text
src/workflows/agent/structured-output-tool.ts
test/workflows/agent/structured-output-tool.test.ts
```

Deliverable:

- `agent({ schema })` returns captured structured params.
- Missing structured output fails the agent.
- Journal result is written only after valid capture.

### Slice 7: Polished Running Indicator

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
- valid trigger launches and returns `handled`.

### Filesystem Integration Tests

Use temp directories and the existing `launchWorkflow()` test style.

Scenario:

1. Create fake Pi command/input context with `cwd = tempDir`.
2. Submit `ultracode audit repo`.
3. Use fake scheduler runner with deterministic outputs.
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

- Whether the first trigger path is direct saved workflow launch or transformed
  main-agent authoring.
- How `agentType` maps to Pi concepts.
- Structured-output retry/nudge policy.
- Transcript retention and privacy policy.
- Whether bundled workflows live as package assets or source string constants.

## Acceptance Criteria

The implementation is ready for the first `ultracode` milestone when:

- Typing `ultracode` in TUI animates the word without breaking editor behavior.
- Submitting `ultracode <goal>` starts a persisted workflow run.
- The first slice works with fake agents in automated tests.
- Real Pi subagent runner exists behind an injectable seam and is covered by
  mocked-session tests.
- Terminal workflow output and notification are persisted/sent through the
  existing launcher path.
- `/workflows` lists ultracode-launched runs.
- No user-facing LLM tool named `ultracode` is registered.
