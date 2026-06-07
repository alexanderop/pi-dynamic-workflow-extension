# Pi Dynamic Workflow Extension

A Pi package scaffold for building a Claude-Code-like dynamic workflow feature.

This repository is exploratory. The current source is only the installable package shell; the actual workflow launcher, sandbox runtime, scheduler, persistence layer, subagent runner, and `/workflows` UI will be implemented later against the behavior documented in [spec.md](./spec.md).

Reference notes for future implementation:

- [Learning guide](./docs/learning/README.md)
- [Pi extension reference](./docs/pi-extension-reference.md)
- [Pi testing reference](./docs/testing-reference.md)
- [Error handling](./docs/error-handling.md)
- [Dynamic workflows backlog](./docs/backlog.md)

## Install

Install a tagged release from git:

```bash
pi install git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.0
```

Install into project settings instead of global settings:

```bash
pi install -l git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.0
```

Try the local checkout without installing:

```bash
pi -e .
```

## Current Behavior

The package announces auth-configured Pi models and their supported thinking modes when a session starts, then registers a `/workflows` command that lists project-local workflow run manifests from `.pi/workflows/<runId>/manifest.json`.

The core workflow modules now support metadata parsing, sandboxed script execution, scheduler-capped `agent()` calls, run-state discovery, inline launch persistence, saved workflow launch by name or explicit path, saved workflow listing with `description`/`whenToUse` guidance, per-run `journal.jsonl` audit/cache events, resume cache replay for inline launches, terminal `output.json` files, and testable task-notification payloads. The `ultracode` trigger wires plain-text agents to real Pi sidechain sessions and sends completion notifications back through `pi.sendMessage()`; structured-output subagents are still a planned slice.

## Development

This project uses Oxlint for JavaScript/TypeScript linting and Oxfmt for code/config formatting:

```bash
pnpm run lint
pnpm run lint:fix
pnpm run fmt
pnpm run fmt:check
```

The formatter scripts intentionally target source, tests, workflow scripts, and project config files rather than the whole repository. This keeps reverse-engineering notes such as `spec.md` out of routine formatter churn.

## Package Shape

Pi loads this package through the `pi` manifest in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/extension/index.ts"]
  }
}
```

The extension entrypoint stays small. Most behavior should live in ordinary TypeScript modules so the workflow runtime can be unit-tested without launching Pi.

Current module structure follows [ADR 0007](./docs/adr/0007-organize-workflows-as-domain-modules.md):

```text
src/
  extension/
    index.ts
    commands/
      workflows-command.ts
  workflows/
    agent/
      model.ts
      scheduler.ts
    launch/
      model.ts
      launcher.ts
    run/
      model.ts
      store.ts
      state-machine.ts
    saved/
      resolver.ts
    script/
      model.ts
      parser.ts
      runtime.ts
    result.ts
```

Future `/workflows` TUI code should stay as a UI adapter instead of moving workflow execution logic into terminal components.

## `/workflows` UI Plan

The `/workflows` command should be a custom Pi UI, not a stream of plain notifications. The UI should be split into three layers:

1. Data model: a read-only projection of workflow run state from disk.
2. Controller: command handlers for pause, resume, stop, save, restart agent, and open output paths.
3. View component: a focused TUI component rendered with `ctx.ui.custom()`.

Recommended first screen:

```text
Workflows

Runs
> wf_901813da-ebe  completed  webfetch-quality-audit  34 agents  4m15s
  wf_6da350cb-7c6  failed     webfetch-quality-audit  12 agents  1m08s

Progress
  Review  6/6 done
  Verify  28/28 done

Agents
  done     review:security                       31k tok  14 tools
  running  verify:tests:missing-edge-coverage    read
  queued   verify:api:tool-parity

Details
  output: .../workflows/wf_901813da-ebe.output.json
```

Expected controls:

- Up/down: move through runs or agents.
- Tab: switch focus between Runs, Agents, and Details.
- `r`: resume or restart selected failed/stopped run.
- `p`: pause or resume the selected running run.
- `s`: stop the selected run or selected agent after confirmation.
- `w`: save the selected run script as a reusable workflow.
- Enter: open the selected run details panel.
- Escape: close the UI.

Implementation guidance:

- Keep rendering separate from workflow execution. The view should read `WorkflowRunState` and dispatch controller actions.
- Use stable row dimensions so progress updates do not shift the layout.
- Start with a polling read model from run JSON files. Add live event subscriptions only if polling is not enough.
- Keep destructive actions behind `ctx.ui.confirm()`.
- Do not parse subagent transcripts for the list view. The run JSON should contain enough progress data for `/workflows` to render cheaply.

## Versioning

Use SemVer tags. Pi pins git refs, so users should install tagged versions rather than `main`.

Release checklist:

```bash
npm version patch --no-git-tag-version
git add package.json CHANGELOG.md
git commit -m "Release v0.1.1"
git tag -a v0.1.1 -m "v0.1.1"
git push origin main --tags
```

Users upgrade by installing the new tag:

```bash
pi install git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.1
```
