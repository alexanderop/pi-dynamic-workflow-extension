# Pi Extension Reference

This note captures the Pi extension and package behavior we want to treat as local reference material while building this project. The source of truth is the vendored Pi repo under `repos/pi/`; this document is a map, not a replacement.

## Source Files To Read First

- `repos/pi/packages/coding-agent/docs/extensions.md` explains extension capabilities, locations, imports, and runtime behavior.
- `repos/pi/packages/coding-agent/docs/packages.md` explains installable Pi packages, git refs, package manifests, and dependency rules.
- `repos/pi/packages/coding-agent/src/core/extensions/types.ts` defines `ExtensionAPI`, command contexts, custom tools, UI context, events, and render hooks.
- `repos/pi/packages/coding-agent/src/core/extensions/loader.ts` implements extension loading, package entry discovery, and `package.json` `pi` manifest handling.
- `repos/pi/packages/coding-agent/src/core/extensions/runner.ts` implements event dispatch, command/tool collection, context construction, and runtime binding.
- `repos/pi/packages/coding-agent/examples/extensions/` contains working extension examples.

## Installable Package Shape

Pi packages can be installed from npm, git, or local paths. For this project, the target install path is:

```bash
pi install git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.0
```

Pi pins git refs. Users upgrade by installing a newer tag:

```bash
pi install git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.1
```

The package root should declare a `pi` manifest:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension/index.ts"],
    "skills": ["./skills"]
  }
}
```

`skills/workflow-debugger/SKILL.md` is packaged with the extension so users can ask Pi to debug workflow artifacts after installing the package.

Reference: `repos/pi/packages/coding-agent/docs/packages.md`.

## Dependency Rules

Pi bundles core extension packages. If we import these, list them as peer dependencies with `"*"`:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`
- `typebox`

Third-party runtime packages should go in `dependencies`, not `devDependencies`, because Pi runs `npm install` when installing git packages with `package.json`.

## Extension Entrypoint Pattern

Extensions export a default factory function. The factory receives `ExtensionAPI` and registers commands, tools, event handlers, renderers, shortcuts, flags, and providers.

Minimal command shape adapted from Pi docs:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function extension(pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

Current package entrypoint:

- `src/extension/index.ts`

Pi docs example:

- `repos/pi/packages/coding-agent/docs/extensions.md`

## Extension Loading Behavior

Important observations from `repos/pi/packages/coding-agent/src/core/extensions/loader.ts`:

- Extensions are loaded through `jiti`, so TypeScript entrypoints work without a build step.
- The extension default export must be a function.
- A directory package can expose resources through `package.json` `pi.extensions`.
- Direct local extension discovery supports `.ts` and `.js`.
- Project-local extensions are discovered from `.pi/extensions/`, but installable packages should use a root package manifest.

The relevant loader flow is:

```ts
const module = await jiti.import(extensionPath, { default: true });
const factory = module as ExtensionFactory;
return typeof factory !== "function" ? undefined : factory;
```

Use this when debugging install/load failures: first ask whether Pi resolved the right file, then whether that file default-exports a function.

## Runtime Boundary For This Project

Pi extensions run with full system permissions. Our workflow scripts must not.

That means:

- `src/extension/*` is trusted package code running inside Pi.
- `src/workflows/script/runtime.ts` should evaluate user workflow JavaScript in our restricted runtime.
- Workflow JavaScript should only see the globals documented in `spec.md`: `args`, `budget`, `phase`, `log`, `agent`, `parallel`, `pipeline`, and `workflow`.
- Subagent side effects should go through Pi agent sessions, not arbitrary workflow JavaScript.

This maps directly to `spec.md` security requirements.

## Custom UI Pattern For `/workflows`

Pi supports custom terminal UI through `ctx.ui.custom()`. The `/workflows` implementation should keep the UI split into:

- Read model: loads `WorkflowRunState` files.
- Controller: pause, resume, stop, save, restart, open output.
- View: focused TUI component that renders runs, phases, agents, and details.

Use Pi TUI imports from `@earendil-works/pi-tui` only in the view layer. Keep workflow execution and persistence independent of TUI classes so they remain easy to test.

Useful examples:

- `repos/pi/packages/coding-agent/examples/extensions/questionnaire.ts` for a custom overlay-like interactive tool.
- `repos/pi/packages/coding-agent/examples/extensions/tools.ts` for command-driven custom UI with persisted extension state.
- `repos/pi/packages/coding-agent/examples/extensions/tic-tac-toe.ts` for a larger stateful custom component and message renderer.
