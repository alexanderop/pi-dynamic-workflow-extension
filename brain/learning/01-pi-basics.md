# 01: Pi Basics

This project is a Pi package, so you need a few Pi concepts before the workflow code makes sense.

## Pi in this project

Pi is the host application. It loads this package, calls the extension entrypoint, and gives extension code access to APIs for commands, tools, events, UI, sessions, and models.

This project is not a standalone app with its own CLI. During development, you can load the local package into Pi with:

```bash
pi -e .
```

There is also a `pnpm run pi` script (`pi --no-extensions -e .` in `package.json`) that loads only this extension and skips other installed extensions, which is handy for isolating its behavior.

The project also has normal TypeScript tests and a type check that do not start Pi:

```bash
pnpm test        # vitest --run
pnpm run check   # tsc --noEmit
```

## Sessions

Pi stores conversations as sessions. Session files are JSONL and can branch like a tree. This matters for dynamic workflows because terminal workflow notifications will eventually be injected back into the main conversation.

Useful project-local summary:

- [`brain/references/pi-extension-reference.md`](../references/pi-extension-reference.md)
- [`../../spec.md`](../spec.md), especially the notification and storage sections

Useful Pi docs:

- Pi `sessions.md`
- Pi `session-format.md`

## Extensions

A Pi extension is a TypeScript module that default-exports a factory function. Pi loads the entrypoint through `jiti`, so `.ts` files run without a build step:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}`, "info");
    },
  });
}
```

This project's extension entrypoint is `src/extension/index.ts`. It is wired into Pi through the `pi.extensions` array in `package.json:41-45`. The real default export is named `dynamicWorkflowExtension` (`src/extension/index.ts:10`) and registers a single command.

## Commands

Commands are slash commands such as:

```text
/workflows
```

This project currently registers exactly one command, `/workflows` (`src/extension/index.ts:11`). Its handler reads `manifest.json` files from disk and renders a plain-text summary of known workflow runs. It does not yet parse command arguments, filter, sort, or page (`_args` is unused).

The `ctx` argument is an `ExtensionCommandContext` (defined in `repos/pi/packages/coding-agent/src/core/extensions/types.ts:337`). Important fields this command uses or will use:

| Field | Why it matters |
|---|---|
| `ctx.cwd` | Current working directory. We derive `.pi/workflows` from this via `join(ctx.cwd, ".pi", "workflows")` (`src/extension/index.ts:14`). |
| `ctx.mode` | Tells us whether Pi is running in `tui`, `rpc`, `json`, or `print` mode (`types.ts:298,304`). |
| `ctx.hasUI` | True in TUI/RPC, false in JSON/print (`types.ts:305`). The command falls back to `print` when `hasUI` is false and no explicit mode is set. |
| `ctx.ui` | Notifications and dialogs (`ctx.ui.notify`). Custom TUI via `ctx.ui.custom()` is not used yet. |
| `ctx.getSystemPromptOptions()` | Real method on `ExtensionCommandContext` (`types.ts:339`). Not yet used here; reserved for a future launch-time snapshot for subagent alignment (see ADR 0004). |

## Tools

Pi tools are callable by the LLM. Built-in examples are `read`, `bash`, `edit`, and `write`.

Dynamic workflows will eventually launch real Pi subagents that use normal Pi tools under normal permission policy. That part is not built yet: today `agent()` calls go through a fake, injectable agent runner (see [`glossary.md`](./glossary.md) "Agent runner" / "Fake agent"), and the runtime returns the prompt unchanged when no runner is supplied. Workflow JavaScript itself must never get direct file, shell, network, or MCP access.

That is why this project separates trusted from untrusted code:

```text
trusted extension code (full system permissions)
  src/extension/*
  src/workflows/*   (parser, runtime, scheduler, state machine, run store, launcher)

untrusted workflow script code
  executed inside a node:vm sandbox by src/workflows/script/runtime.ts
  sees only the host globals listed in glossary.md
```

The sandbox is also deterministic on purpose: the parser and runtime both reject `Date.now()`, `Math.random()`, and argument-less `new Date()` (`src/workflows/script/runtime.ts`, ADR 0002), so a future resume can re-run a script and get the same agent calls.

## UI modes

Pi can run in different modes:

| Mode | Meaning for this project |
|---|---|
| `tui` | Full terminal UI. Future rich `/workflows` monitor can use `ctx.ui.custom()`. |
| `rpc` | Headless JSON protocol with dialog-capable extension UI. No terminal-only custom component. |
| `json` | JSON event output. Extension UI methods are no-ops, so command output must write JSON explicitly. |
| `print` | Non-interactive print mode. Command output must write plain text explicitly. |

The current `/workflows` command already branches for these modes in `emitWorkflowCommandOutput` (`src/extension/index.ts:31-53`): `tui`/`rpc` route to `ctx.ui.notify`, `json` writes a JSON line to stdout/stderr, and `print` writes plain text to stdout/stderr.

## Project-local `.pi/`

This extension uses project-local runtime state. Each run gets its own directory:

```text
.pi/workflows/<runId>/manifest.json     # run read model, the only file /workflows reads
.pi/workflows/<runId>/script.js         # exact workflow source the launcher persisted
.pi/workflows/<runId>/transcripts/      # reserved for future per-agent transcripts (empty today)
```

`manifest.json` is the cheap read model: `WorkflowRunStore.listRuns()` scans these files, sorts them newest first, and silently skips any that fail validation (`src/workflows/run/store.ts`). It deliberately never reads journals or transcripts to build the overview. Note there is no journal file yet — resume/replay (`journal.jsonl`) is planned but not implemented.

Keeping runs under the project root scopes workflow state to the project being worked on. The storage decision is recorded in [`brain/decisions/adr/0005-use-project-local-pi-workflow-run-storage.md`](../decisions/adr/0005-use-project-local-pi-workflow-run-storage.md).
