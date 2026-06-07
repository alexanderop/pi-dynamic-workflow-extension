# References

This file points to source-of-truth material. Read this learning guide first, then use these files to verify details.

## Project source of truth

| File | Why to read it |
|---|---|
| [`../../README.md`](../../../README.md) | Package overview, install commands, current behavior. |
| [`../../AGENTS.md`](../../../AGENTS.md) | Agent/developer instructions and docs index. |
| [`../../spec.md`](../../../spec.md) | Reverse-engineered dynamic workflow specification. |
| [`../backlog.md`](../../archive/backlog.md) | Implementation plan and slice status. |
| [`../error-handling.md`](../../areas/references/error-handling.md) | Local Result pattern and error conventions. |
| [`../testing-reference.md`](../../areas/references/testing-reference.md) | Testing strategy copied from Pi patterns. |
| [`../pi-extension-reference.md`](../../areas/references/pi-extension-reference.md) | Local map of relevant Pi extension/package behavior. |
| [`../adr/README.md`](../../areas/adr/README.md) | ADR format and when to record decisions. |

## Current ADRs

- [`../adr/0001-use-adrs-for-workflow-architecture.md`](../../areas/adr/0001-use-adrs-for-workflow-architecture.md)
- [`../adr/0002-use-acorn-and-node-vm-for-first-workflow-runtime.md`](../../areas/adr/0002-use-acorn-and-node-vm-for-first-workflow-runtime.md)
- [`../adr/0003-use-explicit-workflow-state-machines.md`](../../areas/adr/0003-use-explicit-workflow-state-machines.md)
- [`../adr/0004-use-pi-extension-context-for-mode-and-prompt-aware-workflows.md`](../../areas/adr/0004-use-pi-extension-context-for-mode-and-prompt-aware-workflows.md)
- [`../adr/0005-use-project-local-pi-workflow-run-storage.md`](../../areas/adr/0005-use-project-local-pi-workflow-run-storage.md)
- [`../adr/0006-use-terminal-notification-hook-before-pi-message-wiring.md`](../../areas/adr/0006-use-terminal-notification-hook-before-pi-message-wiring.md)
- [`../adr/0007-organize-workflows-as-domain-modules.md`](../../areas/adr/0007-organize-workflows-as-domain-modules.md)

## Implementation files

Read in this order:

1. [`../../src/workflows/result.ts`](../../../src/workflows/result.ts)
2. [`../../src/workflows/run/model.ts`](../../../src/workflows/run/model.ts)
3. [`../../src/workflows/agent/model.ts`](../../../src/workflows/agent/model.ts)
4. [`../../src/workflows/script/model.ts`](../../../src/workflows/script/model.ts)
5. [`../../src/workflows/launch/model.ts`](../../../src/workflows/launch/model.ts)
6. [`../../src/workflows/script/parser.ts`](../../../src/workflows/script/parser.ts)
7. [`../../src/workflows/run/state-machine.ts`](../../../src/workflows/run/state-machine.ts)
8. [`../../src/workflows/agent/scheduler.ts`](../../../src/workflows/agent/scheduler.ts)
9. [`../../src/workflows/script/runtime.ts`](../../../src/workflows/script/runtime.ts)
10. [`../../src/workflows/run/store.ts`](../../../src/workflows/run/store.ts)
11. [`../../src/workflows/launch/launcher.ts`](../../../src/workflows/launch/launcher.ts)
12. [`../../src/extension/commands/workflows-command.ts`](../../../src/extension/commands/workflows-command.ts)
13. [`../../src/extension/index.ts`](../../../src/extension/index.ts)

## Tests as examples

The tests are the behavior lock: when the docs and the code disagree, these files settle it. Read in this order:

1. [`../../test/workflows/result.test.ts`](../../../test/workflows/result.test.ts)
2. [`../../test/workflows/script/parser.test.ts`](../../../test/workflows/script/parser.test.ts)
3. [`../../test/workflows/script/runtime.test.ts`](../../../test/workflows/script/runtime.test.ts)
4. [`../../test/workflows/agent/scheduler.test.ts`](../../../test/workflows/agent/scheduler.test.ts)
5. [`../../test/workflows/run/state-machine.test.ts`](../../../test/workflows/run/state-machine.test.ts)
6. [`../../test/workflows/run/store.test.ts`](../../../test/workflows/run/store.test.ts)
7. [`../../test/workflows/launch/launcher.test.ts`](../../../test/workflows/launch/launcher.test.ts)
8. [`../../test/extension/index.test.ts`](../../../test/extension/index.test.ts)

Shared test helper: [`../../test/workflows/script/workflow-factory.ts`](../../../test/workflows/script/workflow-factory.ts) builds inline workflow scripts (`workflowScript()`, `invalidWorkflowScript()`) used by the runtime, launcher, and parser tests.

## Pi docs to read when changing extension behavior

The Pi docs are the source of truth for Pi APIs. They ship inside the vendored Pi repo at
`repos/pi/packages/coding-agent/docs/` (and identically in the installed package under
`node_modules/@earendil-works/pi-coding-agent/docs/`). The bare filenames below are relative to
that `docs/` directory — they are not top-level files of this repo.

| Pi doc | When to read |
|---|---|
| `repos/pi/packages/coding-agent/docs/extensions.md` | Registering commands/tools/events/UI; extension contexts and modes. |
| `repos/pi/packages/coding-agent/docs/packages.md` | Package manifests, git installs, dependency rules. |
| `repos/pi/packages/coding-agent/docs/tui.md` | `ctx.ui.custom()` and custom component contracts. |
| `repos/pi/packages/coding-agent/docs/session-format.md` | Session JSONL format and SessionManager concepts. |
| `repos/pi/packages/coding-agent/docs/sessions.md` | User-facing session behavior and branching. |
| `repos/pi/packages/coding-agent/docs/rpc.md` | Headless/RPC behavior and extension UI protocol. |
| `repos/pi/packages/coding-agent/docs/compaction.md` | Compaction and branch summarization hooks. |

Local summary that maps these topics to the files we actually use:

```text
docs/areas/references/pi-extension-reference.md
```

## Reference repo

Treat as read-only (per `AGENTS.md`, this is the squashed `github.com/earendil-works/pi` repo at `main`):

```text
repos/pi/
```

Use it when the topic docs above are not enough or when you need exact source behavior — for
example `repos/pi/packages/coding-agent/src/core/extensions/types.ts` for the `ExtensionAPI`
and command-context types this extension implements.
