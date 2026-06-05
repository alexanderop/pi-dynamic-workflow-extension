# ADR 0007: Organize Workflows As Domain Modules

Status: accepted

## Context

The workflow implementation started with a flat `src/workflows/` folder and a shared
`types.ts` file. That was useful while the feature was small, but the domain now
has distinct concepts: runs, agents, scripts, launch/notification behavior, and a
future `/workflows` TUI.

Keeping every type in one shared file makes the interface of each module harder to
read. Adding the TUI would make this worse if terminal UI types, run persistence
shapes, scheduler progress, and launch contracts all lived in the same bucket.

## Decision

Organize the extension as a modular monolith: one package, split internally by
feature/domain module.

Workflow code lives under domain folders:

```text
src/workflows/
  agent/   # agent options, progress read model, scheduler
  launch/  # launch request/result contracts, launcher, terminal notification payloads
  run/     # run state, state machine, manifest store
  script/  # workflow meta, parser, sandbox runtime
```

Each module owns its model in a local `model.ts` when the model is shared inside
that module or imported by another module. Types used only by one implementation
stay in that implementation file. Avoid a catch-all `src/workflows/types.ts`.

The Pi extension entrypoint should stay thin. Command adapters live under
`src/extension/commands/` and call workflow modules. When the `/workflows` TUI is
added, keep it as a UI adapter under a workflow UI module, with rendering and Pi
TUI imports isolated from run persistence, scheduling, and script execution.

## Consequences

- Workflow concepts are easier to navigate because model and behavior are grouped
  by domain.
- Future TUI work can read run models and dispatch controller actions without
  owning workflow execution logic.
- Imports become more explicit, e.g. `workflows/run/model.ts` instead of a global
  `workflows/types.ts`.
- Some files move deeper in the tree, so tests mirror the domain folders and use
  slightly longer relative imports.
