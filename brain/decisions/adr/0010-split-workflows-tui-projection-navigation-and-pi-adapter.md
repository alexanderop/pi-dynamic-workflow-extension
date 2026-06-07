# ADR 0010: Split Workflows TUI Projection, Navigation, And Pi Adapter

Status: accepted

## Context

The `/workflows` command needs an interactive Pi TUI, but workflow execution,
manifest persistence, scheduler state, and journal replay should stay testable
without terminal rendering or Pi runtime objects.

Pi TUI components are easiest to test when the view model and navigation logic are
plain TypeScript and the terminal component is a thin adapter over `render(width)`
and `handleInput(data)`.

## Decision

Split the `/workflows` UI into three layers:

1. `src/workflows/view/` owns TUI-agnostic projection and navigation state.
2. `src/extension/tui/` owns Pi TUI components and `ctx.ui.custom()` integration.
3. `src/extension/commands/workflows-command.ts` owns mode routing and keeps the
   existing text/json fallback for non-interactive modes.

The overview reads workflow manifests through `WorkflowRunStore`. It does not read
journals or transcripts for the list view.

## Consequences

- Projection and keyboard state can be unit-tested without Pi or a terminal.
- Pi TUI imports are isolated from workflow runtime, persistence, and scheduler
  modules.
- The first custom TUI can poll manifest state; future controller actions can be
  added behind the same command/TUI adapter boundary.
- Saved-workflow browsing remains minimal in this first TUI and can become its own
  chooser state later.
