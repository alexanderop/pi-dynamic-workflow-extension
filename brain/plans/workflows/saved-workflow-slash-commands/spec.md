---
title: Saved Workflow Slash Commands
status: proposed
priority: P1
last_audited: 2026-06-07
implementation: "Not implemented. Saved workflows can currently be saved, listed, and launched by Workflow({ name }), but .pi/workflows/*.js files are not registered as Pi slash commands."
next: "Build a Pi command adapter that registers saved workflow scripts as slash commands and launches them by name with trailing text as args."
---

# Spec: Saved Workflow Slash Commands

## Status

Proposed.

Current behavior is functional but incomplete for the desired user experience:

- A completed run can be promoted with `saveRunScript(...)` / `/workflows` save.
- The saved file is copied to the project/workspace workflow root as `.pi/workflows/<meta.name>.js`.
- A saved workflow can be launched by the model-facing tool call `Workflow({ name: "<meta.name>", args })`.
- `/workflows` can list saved workflow metadata.
- Pi does **not** currently register each saved workflow as a user-visible slash command.

This spec adds the missing Pi adapter so a saved workflow behaves like a project-local reusable command:

```text
/deep-research who is alexander opalic
```

launches `.pi/workflows/deep-research.js` by `meta.name === "deep-research"` and passes the trailing text as workflow `args`.

## Source material

- `spec.md` §15 already defines saved workflows as retriggerable command templates and says an adapter may surface them as slash-style commands.
- `spec.md` §18 defines the Pi workflow root and saved `.js` layout.
- ADR 0009 keeps saved workflows project/workspace-local under the Pi `.pi/workflows` namespace.
- Pi extension docs: `pi.registerCommand(...)` registers slash commands, extension commands execute before input/skill/template expansion, and `pi.getCommands()` exposes extension/prompt/skill commands for command discovery.
- Pi skill docs: skills are discoverable as `/skill:<name>` commands; the target here is analogous discoverability, but saved workflows should be direct project commands such as `/deep-research` when safe.

## Product summary

As a user who saved a workflow under `.pi/workflows`, I want it to appear in Pi slash-command autocomplete and be executable by typing `/<workflow-name> [args]`, so I can reuse multi-agent workflows without asking the main model to author or call `Workflow({ name })` manually.

## Goals

1. Register command-safe saved workflow names as Pi extension commands.
2. Launch the selected saved workflow directly from the command handler.
3. Pass command trailing text to the workflow as `args` without JSON parsing or prompt-template substitution.
4. Use saved workflow `meta.description` as the command description in autocomplete.
5. Refresh command registration on session start/reload and after a workflow is saved from `/workflows`.
6. Preserve existing `Workflow({ name })`, `script`, `scriptPath`, save, list, resume, journal, and notification semantics.
7. Avoid surprising command shadowing: do not silently override built-in extension commands or existing prompt templates.

## Non-goals

- Do not add user-home saved workflow scope; ADR 0009 remains project/workspace-local unless separately amended.
- Do not make saved workflow scripts more privileged. Scripts still run in the sandbox and can only use workflow globals.
- Do not convert saved workflows into Pi skills or prompt templates.
- Do not parse command arguments into JSON in the first slice.
- Do not implement deletion/unregistration of commands for removed files; Pi exposes no unregister-command API in the current docs/source. Stale commands may require `/reload`.
- Do not change `/workflows` monitor layout beyond save/registration feedback.

## User-facing behavior

### Direct saved command

Given `.pi/workflows/deep-research.js`:

```js
export const meta = {
  name: "deep-research",
  description: "Research a question with source verification",
}
```

Pi should expose:

```text
/deep-research [question]
```

Invoking:

```text
/deep-research who is alexander opalic
```

launches:

```ts
launchWorkflow(
  { name: "deep-research", args: "who is alexander opalic" },
  { triggerSource: "saved", ...currentPiLaunchOptions },
)
```

The command handler should emit an immediate launch confirmation in the current mode:

- TUI/RPC: `ctx.ui.notify(...)` with run id and `/workflows` hint.
- print/json: explicit stdout/stderr output, matching the existing `/workflows` non-interactive pattern.

Terminal workflow notifications use the existing `prepareWorkflowNotification(...)` path. Completed and failed saved-command runs may trigger a follow-up model turn; stopped runs must keep the current no-rerun cancellation policy.

### Empty args

If the command has no trailing text, pass `args: ""` to preserve the direct mapping from command input to workflow input. Workflow authors can branch on an empty string or ask clarifying questions inside their agent prompts.

### Command discovery

A saved workflow command should appear in `pi.getCommands()` as an extension command:

```ts
{
  name: "deep-research",
  description: "Research a question with source verification",
  source: "extension",
  sourceInfo: ...
}
```

The command description comes from `meta.description`. `meta.whenToUse` remains visible in `/workflows` saved workflow listings; Pi extension command metadata does not currently have a documented `whenToUse` field.

### Save feedback

When `/workflows` saves a completed run and the saved name can be registered, notify:

```text
Saved workflow 'deep-research' to .pi/workflows/deep-research.js and registered /deep-research.
```

If registration is skipped because of a conflict or invalid command name, still save the file and notify the usable fallback:

```text
Saved workflow 'review' to .pi/workflows/review.js. /review is already used by a prompt template; launch with /workflow review <args> or Workflow({ name: "review" }).
```

## Command name policy

Saved workflow resolution is keyed by `meta.name`, but not every valid saved workflow name is a safe Pi slash command. Direct command registration requires:

- non-empty name;
- no path separators;
- no whitespace;
- no leading `/`;
- not equal to reserved extension commands such as `workflows` and `workflow`;
- not starting with `skill:`;
- no collision with an existing extension command, prompt template, or skill command returned by `pi.getCommands()`.

A workflow that fails direct-command registration remains valid as a saved workflow. It can still be launched by:

- `Workflow({ name })` from the model-facing tool;
- a future generic `/workflow <name> [args]` command;
- direct code/tests.

## Generic fallback command

Register a stable generic command:

```text
/workflow <name> [args]
```

Behavior:

- First token after `/workflow` is the saved workflow name.
- Remaining text is passed as `args`.
- The handler launches by `name` through the same launch path as direct commands.
- `getArgumentCompletions(prefix)` should offer saved workflow names from the current project/workspace root when Pi calls it.

This fallback makes conflicted saved workflows executable without requiring the main model to call `Workflow({ name })`.

## Registration lifecycle

### Session start / reload

On `session_start`, scan the resolved workflow root for saved workflows:

```ts
const rootDir = workflowRootDirForCwd(ctx.cwd)
const saved = await listSavedWorkflows({ projectDir: rootDir })
```

For each saved workflow:

1. validate command-name safety;
2. check collisions against `pi.getCommands()` before registering;
3. register direct command when safe;
4. record skipped registrations for `/workflows` diagnostics.

### After saving

After `saveRunScript(...)` succeeds from `/workflows`, rescan or register the saved workflow immediately. Re-registering an existing command name should update the handler/description in memory when Pi permits it. If Pi autocomplete does not refresh immediately, the save notification should say `/reload` may be needed for autocomplete, while invocation should be tested against the real prompt path.

### Removed files

Because Pi currently documents `registerCommand` but not `unregisterCommand`, deletion is out of scope. A command whose file was deleted should fail at invocation with the normal saved-workflow not-found error and tell the user to run `/reload` to clear stale command metadata.

## Architecture

Add a thin Pi adapter; do not move workflow execution logic into command code.

Recommended modules:

| Module | Responsibility |
|---|---|
| `src/extension/commands/saved-workflow-commands.ts` | Register `/workflow` and safe direct commands, track skipped/registered names, build command handlers. |
| `src/extension/commands/workflows-command.ts` | Keep `/workflows`; call the saved-command registry after successful save and include diagnostics if useful. |
| `src/extension/index.ts` | Create one saved-command registry instance and wire it with `registerWorkflowsCommand(...)`. |
| `src/workflows/saved/list.ts` | Existing saved workflow discovery remains the source of truth. |
| `src/workflows/saved/resolver.ts` | Existing launch-by-name resolver remains the execution source of truth. |

Core data structures:

```ts
type SavedWorkflowCommandStatus =
  | "registered"
  | "skipped_invalid_name"
  | "skipped_reserved"
  | "skipped_collision";

interface SavedWorkflowCommandRegistration {
  readonly workflowName: string;
  readonly commandName: string;
  readonly path: string;
  readonly status: SavedWorkflowCommandStatus;
  readonly reason?: string;
}
```

The handler should not capture workflow source. It should launch by `name` at invocation time so edits to `.pi/workflows/<name>.js` are picked up without re-registering the command.

## Launch options

Saved slash commands use the same launch-option builder as the `Workflow` tool and stopped-run resume path:

- `rootDir: workflowRootDirForCwd(ctx.cwd)`
- `cwd: ctx.cwd`
- `sessionId: currentSessionId(ctx)` through `buildWorkflowLaunchOptions(...)`
- `triggerSource: "saved"`
- current Pi model and thinking level
- feature flags and model availability
- terminal notification delivery via `prepareWorkflowNotification(...)`

This preserves model inheritance, feature flags, notifications, and session-scoped `/workflows` filtering.

## Error handling

- Discovery/listing errors should be surfaced as extension diagnostics, not crash Pi startup.
- Invocation errors should emit user-facing command output with the saved workflow name and resolver error message.
- Missing/invalid workflow files use existing resolver/parser error variants.
- Launch failures before run creation should not create run artifacts.
- Launch failures after run creation follow existing workflow launch behavior.

## Security

- Saved workflow command registration reads metadata statically; it must not execute workflow JavaScript during discovery.
- Direct command handlers launch through `launchWorkflow({ name })`; they must not read or eval the script themselves.
- Workflow scripts remain sandboxed and deterministic according to `spec.md` §6/§20.
- Command arguments are raw user text passed as `args`; do not interpolate them into JavaScript source.

## Implementation slices

### Slice 1: Registry and command-name planning

- Add pure helpers for command-name safety and collision classification.
- Add tests for valid names, invalid names, reserved names, prompt/template collisions, and repeated registration planning.
- No Pi launch behavior yet.

Verification:

- `pnpm run check`
- Unit tests for helper functions.

### Slice 2: Generic `/workflow` command

- Register `/workflow <name> [args]`.
- Launch saved workflows by name with trailing text as args.
- Add completions for saved workflow names when available.
- Add print/json/TUI output tests.

Verification:

- Command test launches `{ name, args, triggerSource: "saved" }`.
- Missing name returns usage.
- Missing saved workflow reports resolver error.

### Slice 3: Direct saved workflow commands

- On `session_start`, scan `.pi/workflows/*.js` and register safe direct commands.
- Direct command handlers launch by name and pass trailing text as args.
- Ensure handlers read current saved source at invocation via existing resolver, not captured source.

Verification:

- A fixture `.pi/workflows/deep-research.js` causes `/deep-research` to be registered.
- `/deep-research question` launches the correct workflow with `args: "question"`.
- A conflicting prompt template name is skipped and does not shadow the prompt template.

### Slice 4: Save-time refresh

- After `/workflows` save succeeds, refresh/register the saved command.
- Improve save notification with registered/skipped status.
- Keep completed-run save precondition unchanged.

Verification:

- TUI save callback writes `.pi/workflows/<name>.js` and registers `/name` when safe.
- Conflict notification shows fallback.
- Running save twice is idempotent.

### Slice 5: Docs and coverage

- Update `spec.md` §15 from optional adapter language to the accepted Pi behavior.
- Update `brain/contracts/spec-coverage.md` with the new command adapter owner/tests.
- Update `README.md` current behavior once implemented.
- Add or amend an ADR if implementation settles a non-obvious collision/registration lifecycle decision.

Verification:

- `pnpm run verify`
- Manual smoke: create `.pi/workflows/echo.js`, `/reload`, confirm `/echo` appears in autocomplete, run `/echo hello`, watch `/workflows`, and confirm terminal notification.

## Acceptance criteria

1. A saved `.pi/workflows/<name>.js` with command-safe `meta.name` appears as a Pi slash command after session start/reload.
2. Invoking `/<name> trailing text` launches `launchWorkflow({ name, args: "trailing text" })` with `triggerSource: "saved"`.
3. The generic `/workflow <name> trailing text` command launches any valid saved workflow by name, including direct-command conflicts.
4. Saved workflow command descriptions come from `meta.description`.
5. Invalid or conflicting saved workflow names are skipped for direct registration without breaking other saved commands.
6. Saving a completed run registers the new direct command immediately when safe, or reports the fallback when not safe.
7. Discovery never executes workflow JavaScript; it statically parses `meta` only.
8. Existing `Workflow({ name })`, `/workflows`, save, resume, notifications, and feature flags continue to pass their current tests.
9. Non-interactive print/json modes receive explicit command output instead of relying on ignored handler return values.
10. Removed saved workflow files fail gracefully until `/reload` clears stale direct commands.
