# 02: Pi Extension Model

This file explains the Pi extension layer as it applies to this repository.

## The entrypoint

Pi loads the extension declared in `package.json` (`package.json:41-45`):

```json
{
  "pi": {
    "extensions": ["./src/extension/index.ts"]
  }
}
```

The file exports a default factory (`src/extension/index.ts:10`). Pi calls it
with an `ExtensionAPI` and the factory registers commands:

```ts
export default function dynamicWorkflowExtension(pi: ExtensionAPI) {
  pi.registerCommand("workflows", {
    description: "Show dynamic workflow runs",
    handler: async (_args, ctx) => {
      // command behavior
    },
  });
}
```

The handler signature Pi expects is
`(args: string, ctx: ExtensionCommandContext) => Promise<void>` (see
`RegisteredCommand` in `repos/pi/packages/coding-agent/src/core/extensions/types.ts:1070`).
The `/workflows` handler ignores its `args` argument today, hence the `_args` name.

The extension layer should stay thin. Most workflow logic belongs in testable modules under `src/workflows/`.

## Current command: `/workflows`

Current behavior (`src/extension/index.ts:11-28`):

1. Build a `WorkflowRunStore` rooted at `join(ctx.cwd, ".pi", "workflows")`.
2. Call `store.listRuns()`, which returns a `Result<WorkflowRunState[], WorkflowRunStoreError>`.
3. On error, emit `Could not read workflow runs: <message>`.
4. On success, format a text summary with `formatWorkflowRuns(...)` and emit it based on Pi mode.

The formatter lists each run's `runId`, status, workflow name, agent count, and
(when present) duration and output path (`src/extension/index.ts:68-79`). When
there are no runs it prints `No workflow runs found in .pi/workflows.`. This
command is read-only: it never parses journals or transcripts, only the
`manifest.json` per run.

Implementation file:

```text
src/extension/index.ts
```

Current tests:

```text
test/extension/index.test.ts
```

## Why command output is explicit

Pi extension command handlers return `Promise<void>` and Pi ignores any return
value (`RegisteredCommand.handler` in
`repos/pi/packages/coding-agent/src/core/extensions/types.ts:1075`). That means
headless output cannot just be returned from the handler.

So `/workflows` emits output itself through `emitWorkflowCommandOutput`
(`src/extension/index.ts:31-53`). It first resolves a mode:
`ctx.mode ?? (ctx.hasUI ? "tui" : "print")`. Anything that is not `json` or
`print` (so `tui` and `rpc`) routes to `ctx.ui.notify`:

| Mode | Current behavior |
|---|---|
| `tui` / `rpc` | `ctx.ui.notify(message, type)` where `type` is `"info"` or `"error"` |
| `print` | write plain text to `stdout` (`stderr` for errors) |
| `json` | write one JSON line (`{ type: "workflow_command_output", ... }`) to `stdout`/`stderr` |

This matches the Pi-mode mapping in `spec.md` and
[ADR 0004](../../areas/adr/0004-use-pi-extension-context-for-mode-and-prompt-aware-workflows.md).
Note `ctx.mode` and `ctx.hasUI` come from Pi's `ExtensionContext`
(`repos/pi/packages/coding-agent/src/core/extensions/types.ts:303-306`).

## Future launch commands

The project does not yet expose workflow launch through a Pi command. `/workflows`
is the only registered command today. The launcher exists only as a module:

```text
src/workflows/launch/launcher.ts
```

`launchWorkflow(request, options)` accepts a `WorkflowLaunchRequest` with
`script`, `name`, or `scriptPath`. Inline launch, saved workflow launch by name,
and explicit script-path launch are implemented for fake-agent runs.

Future extension work will likely add commands or tools that wrap the launcher.
The exact command names are not decided; hypothetical examples could be a
"run inline script" command plus a "run saved workflow" command. The command
layer should translate Pi context into `WorkflowLaunchOptions`, then delegate to
`src/workflows/launch/launcher.ts`.

## Future rich UI

None of this exists yet — today `/workflows` only emits text/notifications. The
plan (README "`/workflows` UI Plan", [ADR 0004](../../areas/adr/0004-use-pi-extension-context-for-mode-and-prompt-aware-workflows.md))
is for the final `/workflows` UI to be a custom TUI monitor built with
`ctx.ui.custom()`, guarded by `ctx.mode === "tui"`.

Important rule:

```ts
if (ctx.mode === "tui") {
  // terminal-only custom component is safe
}
```

Do not use `ctx.hasUI` to guard terminal-only custom components. `ctx.hasUI` is
`true` in both TUI and RPC modes
(`repos/pi/packages/coding-agent/src/core/extensions/types.ts:306`), and Pi's
own docs say to use `mode === "tui"` to guard terminal-only UI such as custom
components (`...types.ts:303`).

## Prompt-context snapshot

[ADR 0004](../../areas/adr/0004-use-pi-extension-context-for-mode-and-prompt-aware-workflows.md)
says workflow launch should eventually snapshot selected parts of Pi's structured
system-prompt inputs. This is not wired up yet — the current launcher does not read
or persist any prompt context. The planned source is the extension API method:

```ts
ctx.getSystemPromptOptions()
```

Why this matters:

- Subagents should share the same project cwd.
- Subagents should align with loaded context files, tools, guidelines, and skills.
- Run metadata should explain what context shaped a workflow.

Be careful: prompt options may include sensitive context file contents. Early slices should persist paths and summaries, not full contents, unless a later ADR explicitly decides otherwise.

## Extension boundary rule

Treat these as trusted Pi extension code:

```text
src/extension/*
src/workflows/*
```

Treat workflow scripts as untrusted orchestration code:

```js
export const meta = { name: "example" };
await agent("do work");
```

Workflow scripts run inside a Node `vm` sandbox and only see the runtime globals
the runtime injects — `args`, `budget`, `phase()`, `log()`, `agent()`,
`parallel()`, `pipeline()`, and deterministic `Date`/`Math` (see the VM context
in `src/workflows/script/runtime.ts:55-71`), not full Node/Pi access. The full
contract is documented in `spec.md`. See also the
[glossary](./glossary.md) for "Pi extension", "fake agent", and "workflow read
model".
