# ADR 0012: Use Pi Session Policy For Ultracode

Status: accepted

## Context

`ultracode` should behave like a standing session opt-in, not like a one-shot
slash command or hidden direct workflow launcher. Once the user types a prompt
that begins with `ultracode`, later substantive turns in the same Pi session
should default to workflow orchestration until the mode is cleared.

The current Pi extension API supports the pieces needed for this:

- `pi.on("input", ...)` can detect and transform submitted user input before the
  main agent sees it.
- `pi.on("before_agent_start", ...)` can inject a custom message and/or replace
  the system prompt for the upcoming agent turn.
- `pi.appendEntry(...)` can persist extension state as custom session entries,
  and `ctx.sessionManager.getEntries()` can restore that state on session start.
- `pi.registerTool(...)` is the Pi-native way to expose a model-facing workflow
  launcher without making `ultracode` itself an LLM tool.

## Decision

Implement `ultracode` as a Pi session policy state machine:

- The input hook detects `ultracode <goal>`, transitions the session mode to
  `on`, records the transition with `pi.appendEntry(...)`, and returns
  `{ action: "transform", text }` so the main agent still receives the task.
- The `before_agent_start` hook injects an `ultracode` custom message and appends
  policy text to the system prompt whenever the session mode is `on`.
- The main agent launches dynamic workflows through a model-facing workflow tool
  registered with `pi.registerTool(...)`; that tool delegates to the existing
  `launchWorkflow(...)` persistence/runtime path.
- Direct bundled `ultracode` workflow launch remains a legacy fallback, not the
  primary user-facing behavior.

## Consequences

This matches Pi's extension lifecycle: input changes intent, `before_agent_start`
changes the next agent turn, and registered tools expose explicit model actions.
It also preserves the existing workflow launcher as the only code path that
creates run artifacts.

The design is less deterministic than direct launch because the main model must
author and launch workflows. The enforcement boundary is therefore split:
prompt/system policy tells the model what to do, while the workflow launch tool
validates scripts with the existing parser before execution.

Session restoration requires replaying custom `ultracode` entries from
`ctx.sessionManager.getEntries()` on `session_start`.
