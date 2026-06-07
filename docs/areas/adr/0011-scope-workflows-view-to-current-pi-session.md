# ADR 0011: Scope `/workflows` To The Current Pi Session

Status: accepted

## Context

Workflow run artifacts are project/workspace-local so they can survive process
restarts and support audit/resume behavior. That means `.pi/workflows` can contain
runs launched from many Pi sessions.

For the day-to-day `/workflows` view, users expect to see the workflows they
triggered from the current conversation/session, not every historical run in the
workspace.

Pi exposes the active session id through `ctx.sessionManager.getSessionId()`.

## Decision

Persist optional session ownership metadata on each workflow run manifest:

```text
sessionId
triggerSource
```

Launch paths that know the current Pi session should pass `sessionId` into
`launchWorkflow()`. The `ultracode` input trigger also stamps
`triggerSource: "ultracode"`.

The `/workflows` command filters run manifests to the current Pi session when a
session id is available. Legacy manifests without `sessionId` and manifests from
other sessions are hidden by default.

Saved workflow scripts remain unfiltered because they are reusable commands, not
run history.

## Consequences

- `/workflows` is focused on the current conversation by default.
- Historical run files remain on disk for future audit/resume features.
- Old manifests without session metadata do not appear in session-scoped views.
- A future `/workflows --all` or equivalent UI toggle can expose all workspace
  runs without changing the storage layout.
