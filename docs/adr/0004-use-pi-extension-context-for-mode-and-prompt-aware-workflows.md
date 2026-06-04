# ADR 0004: Use Pi Extension Context For Mode And Prompt Aware Workflows

Status: accepted

## Context

Pi 0.78.1 added richer extension context. Extension handlers can now read
`ctx.mode` to distinguish TUI, RPC, JSON, and print mode. Extension command
handlers can call `ctx.getSystemPromptOptions()` to inspect the structured base
inputs Pi uses to build the system prompt, including cwd, selected tools, tool
snippets, prompt guidelines, appended/custom prompt text, loaded context files,
and loaded skills.

The dynamic workflow feature needs to feel native in Pi while supporting both
interactive and headless use. `spec.md` also requires subagents to start from the
same project cwd and normal context assumptions as the main session, and the run
state must be useful for audit and replay.

## Decision

Use Pi's richer extension context as a first-class integration point for workflow
launching and workflow UI behavior.

At workflow launch time, command handlers will snapshot the relevant base system
prompt inputs from `ctx.getSystemPromptOptions()` into workflow run metadata. The
snapshot should preserve provenance that affects subagent behavior, such as cwd,
active tools, prompt guidelines, loaded context file paths, loaded skill names,
and prompt customization metadata. Full context file contents are sensitive and
should only be persisted if a later implementation slice explicitly needs them.

Workflow subagent creation will use this launch snapshot to keep subagents aligned
with the main Pi session instead of rediscovering project context independently.

The `/workflows` command and related extension UI will branch on `ctx.mode`:

- In `"tui"` mode, show the rich live workflow viewer with `ctx.ui.custom()`.
- In `"rpc"` mode, expose RPC-compatible dialogs, notifications, and status
  updates without terminal-only components.
- In `"json"` and `"print"` modes, avoid interactive UI and return plain status
  or launch output.

Use `ctx.hasUI` only for UI methods that work in both TUI and RPC. Use
`ctx.mode === "tui"` for terminal-only features such as custom components,
keyboard handling, and direct TUI rendering.

## Consequences

- The workflow extension can support interactive, embedded/RPC, and headless Pi
  modes without separate implementations.
- Workflow runs can record the Pi prompt context that shaped subagent behavior,
  making audits and bug reports easier to understand.
- Subagents can be made more consistent with the main session because launch-time
  context is explicit rather than inferred.
- Persisting prompt inputs requires care: loaded context files may contain
  sensitive content, so early slices should store paths and summaries rather than
  full contents unless the storage policy is decided separately.
- `ctx.getSystemPromptOptions()` reports base prompt inputs only. It does not
  include later `before_agent_start` chained prompt edits, `context` event message
  mutations, or `before_provider_request` provider-payload rewrites.
