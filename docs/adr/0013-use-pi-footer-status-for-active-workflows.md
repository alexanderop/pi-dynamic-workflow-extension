# ADR 0013: Use Pi Footer Status For Active Workflow Runs

## Status

Accepted

## Context

Dynamic workflows run in the background while the main Pi session stays usable.
The `/workflows` TUI is the full monitor, but users also need a lightweight
always-visible cue that a workflow is still running. Pi exposes
`ctx.ui.setStatus(key, text)` for extension-owned footer/status entries, and the
built-in footer renders those entries below the normal model/token status.

A status entry is non-interactive. It cannot own arrow keys or Enter without a
separate custom widget or focused UI, so it is only suitable for the passive
part of the workflow strip.

## Decision

Use a Pi footer status entry keyed as `dynamic-workflows` for the passive active
workflow strip.

The extension owns a statusline controller that projects manifest-backed
`WorkflowRunState` values into compact text:

```text
○ workflow-name  2/3 agents · 4m 18s · phase Verify · agent verify-api · ↓ 832.6k tokens  optional descript…
```

The status keeps the active-run metrics, elapsed time, phase, and active agent
before the optional description. The description is truncated so Pi's footer-level
line truncation does not hide the live progress context.

The controller selects the newest active run in the current Pi session when a
session id is available, updates elapsed time on a timer, and clears the status
when no active workflows remain or when the session shuts down.

The launcher exposes a best-effort `onRunStateChange` observer hook so live Pi
adapters can push immediate status updates without waiting for polling. Observer
failures are swallowed because UI status must not affect workflow execution.

## Consequences

- Active workflows become visible in Pi's normal footer/status area without
  replacing the default footer or patching Pi core.
- `/workflows` remains the interactive detail monitor.
- The first statusline slice is passive. A future selectable workflow strip must
  use a below-editor widget or custom focused UI instead of `setStatus()` alone.
- Statusline rendering depends only on the run manifest/read model, not journals,
  outputs, or transcripts.
