# Pi Dynamic Workflow Extension

A Pi package for Claude-Code-like dynamic workflows: deterministic JavaScript orchestration, background subagents, saved workflow commands, run manifests, notifications, and a `/workflows` monitor.

Status: alpha. The core launcher/runtime/scheduler/Pi-subagent path is implemented and tested, but richer monitor polish, restart-agent controls, and Pi-native transcript surfacing are still evolving. See [spec.md](./spec.md) for the target behavior and current constraints.

Wondering where a spec behavior is implemented? [brain/contracts/spec-coverage.md](./brain/contracts/spec-coverage.md) maps each spec area to its production files, tests, and remaining gaps.

Reference notes for future implementation:

- [Learning guide](./brain/learning/README.md)
- [Pi extension reference](./brain/references/pi-extension-reference.md)
- [Pi testing reference](./brain/references/testing-reference.md)
- [Error handling](./brain/references/error-handling.md)
- [Workflow plans and status](./brain/plans/index.md)

## Install

Install a tagged release from git:

```bash
pi install git:github.com/alexanderopalic/pi-dynamic-workflow-extension@<tag>
```

For example, after publishing `v0.1.18`:

```bash
pi install git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.18
```

Install into project settings instead of global settings:

```bash
pi install -l git:github.com/alexanderopalic/pi-dynamic-workflow-extension@<tag>
```

Try the local checkout without installing:

```bash
pi -e .
```

## Quick Start After Install

1. Start Pi in a project where the package is installed:

   ```bash
   pi
   ```

2. Check the monitor:

   ```text
   /workflows
   ```

3. Run the bundled smoke-test skill:

   ```text
   /skill:hello-workflow
   ```

   The skill launches `skills/hello-workflow/workflows/hello-workflow.js` with the `Workflow` tool and reports back through a workflow notification.

4. Opt into workflow orchestration for a real task by using the `ultracode` trigger in your prompt, for example:

   ```text
   ultracode review this change and verify the risky parts with subagents
   ```

Saved workflows live under the resolved project/workspace `.pi/workflows` root. A saved workflow named `deep-research` can be launched as `/deep-research ...` when the name is command-safe, or with the generic fallback `/workflow deep-research ...`.

## Current Behavior

The package announces auth-configured Pi models and their supported thinking modes when a session starts, registers a `/workflows` command for project-local workflow run manifests from `.pi/workflows/<runId>/manifest.json`, registers saved workflows as slash commands (a generic `/workflow <name> [args]` plus direct `/<meta.name>` commands discovered on session start), ships the `hello-workflow` smoke-test skill, and ships the `workflow-debugger` skill for investigating failed or surprising workflow runs.

The core workflow modules now support metadata parsing, sandboxed script execution, scheduler-capped `agent()` calls, run-state discovery, inline launch persistence, saved workflow launch by name or explicit path, saved workflow listing with `description`/`whenToUse` guidance, per-run `journal.jsonl` audit/cache events, resume cache replay for inline launches, terminal `output.json` files, structured-output capture for Pi subagents, and testable task-notification payloads. The `ultracode` trigger wires agents to real Pi sidechain sessions and sends completion notifications back through `pi.sendMessage()`.

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
    "extensions": ["./src/extension/index.ts"],
    "skills": ["./skills"]
  }
}
```

The extension entrypoint stays small. Most behavior should live in ordinary TypeScript modules so the workflow runtime can be unit-tested without launching Pi. Packaged skills live under `skills/`; `hello-workflow` provides a first-run smoke test, and `workflow-debugger` teaches agents how to diagnose existing workflow artifacts without relaunching work by default.

Current module structure follows [ADR 0007](./brain/decisions/adr/0007-organize-workflows-as-domain-modules.md):

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

Use SemVer git tags. Pi pins git refs, so every shipped version should be an annotated `vX.Y.Z` tag and users should install tags rather than `main`.

Prepare the next patch release:

```bash
git checkout main
git pull --ff-only
git fetch --tags origin
pnpm run release:patch
```

The release helper updates `package.json` and moves the `CHANGELOG.md` `[Unreleased]` section under the new version. It chooses the next version from the highest existing `vX.Y.Z` tag or `package.json`, whichever is newer, then prints the exact commit/tag/push commands. Add `--dry-run` to preview the next tag without changing files.

One-command release when you are ready to commit, tag, and push:

```bash
pnpm run release:patch -- --commit --push
```

Other bumps:

```bash
pnpm run release:minor
pnpm run release:major
pnpm run release:version -- 0.2.0
```

Users upgrade by installing the new tag:

```bash
pi install git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.18
```
