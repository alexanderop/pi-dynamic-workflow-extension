---
title: Agent Transcript Replay View
status: proposed
priority: P3
last_audited: 2026-06-07
implementation: "Not implemented; ADR 0018 is proposed and the real Pi runner still uses SessionManager.inMemory(...)."
next: "Thread transcriptDir to the runner, persist Pi-native sidechain sessions, then add the raw transcript drill-down view."
---

# Spec: Agent Transcript Replay View

## Status

Proposed. This is a future implementation spec for drilling from `/workflows` agent detail into a full Pi-like subagent transcript view.

## Problem

The current `/workflows` State B agent detail is a compact manifest-backed summary. It shows prompt preview, live activity digest, metrics, and outcome, but it cannot show the full sidechain conversation as it actually looked in Pi.

Users need to inspect a workflow agent at full fidelity: the initial prompt, assistant text/thinking, tool calls, tool results, structured-output calls, errors, and final answer. This is especially important for long ultracode runs where a summary hides too much.

## Goals

- From an agent detail row, press arrow right to open a Pi-like raw transcript replay.
- Persist enough data for future workflow agents to replay their sidechain after completion or failure.
- Keep `/workflows` overview and structured detail cheap: they still read `manifest.json` only.
- Lazy-load transcript files only when the user opens the raw transcript view.
- Use Pi-native session storage as the source of truth instead of inventing a second transcript format.
- Render old runs without transcripts honestly instead of pretending full detail exists.

## Non-goals

- Do not record terminal ANSI output or screen frames.
- Do not require exact byte-for-byte Pi private TUI rendering.
- Do not make manifest rendering parse transcript files.
- Do not change workflow scheduling, journal resume semantics, or subagent prompt semantics.
- Do not run live model tests for this feature.

## Technical decision

Persist each real Pi workflow subagent as a Pi-native sidechain session file under the workflow run's transcript directory, then replay that session in a new `/workflows` drill-down screen.

The runner should stop using only `SessionManager.inMemory(...)` for real workflow subagents when transcript capture is enabled. Instead, it should create a per-agent `SessionManager` rooted under the run's transcript directory and pass that manager into `createAgentSession(...)`.

Why Pi-native session files:

- Pi already stores user, assistant, tool result, custom, model, thinking, and tree metadata as JSONL.
- The SDK documents `SessionManager` and `AgentSession.subscribe()` as public surfaces.
- Replaying semantic messages is more durable than recording terminal frames.
- The view can improve over time without changing the captured artifact.

## Storage layout

Future run artifact shape:

```text
.pi/workflows/<runId>/
  manifest.json
  journal.jsonl
  script.js
  output.json
  transcripts/
    agent-<agentId>.meta.json
    sessions/
      <pi-session-file>.jsonl
```

`agent-<agentId>.meta.json` should map the workflow agent row to its Pi session file:

```json
{
  "format": "pi-session-v3",
  "agentId": "a60d76a21cde8691b",
  "label": "implement:tdd-feature-flags",
  "sessionFile": ".pi/workflows/<runId>/transcripts/sessions/<file>.jsonl"
}
```

The path stored in manifests should be project/workspace-relative when practical, but the reader must tolerate absolute paths from older/dev artifacts.

## Data model additions

Add optional fields to workflow agent progress rows:

```ts
interface WorkflowAgentProgress {
  transcriptPath?: string;
  transcriptFormat?: "pi-session-v3";
}
```

These fields are optional for backwards compatibility. Old manifests and fake runners can omit them.

Add an internal live event from the runner to scheduler:

```ts
type WorkflowAgentLiveEvent =
  | { type: "transcript_started"; at: number; path: string; format: "pi-session-v3" }
  | ExistingWorkflowAgentLiveEvent;
```

The scheduler remains the owner of `WorkflowAgentProgress` and patches the manifest when transcript capture starts.

## Runtime flow

1. `launchWorkflow()` already computes `transcriptDir` after `runId` allocation.
2. Pass `transcriptDir` through `WorkflowRuntimeOptions` into `WorkflowAgentScheduler`.
3. Include `transcriptDir` in `WorkflowAgentRunRequest`.
4. `createPiWorkflowAgentRunner()` creates a per-agent session directory:
   `transcripts/sessions/`.
5. Create a persisted `SessionManager` for the sidechain and pass it into `createAgentSession(...)`.
6. Emit `transcript_started` with the session file path as soon as it exists.
7. Write `agent-<agentId>.meta.json` next to the session mapping label, model, thinking level, and session path.
8. Keep existing compact live events and manifest fields for overview/detail.
9. On completion/failure/abort, dispose the session normally; the JSONL session is the transcript artifact.

If creating the transcript session fails, the agent should still run with the current in-memory fallback and the manifest should omit `transcriptPath` or surface a compact failure label. Transcript capture failure must not fail the workflow by itself.

## UI navigation

Current states:

- State A: overview
- State B: structured agent detail
- State C: prompt reader
- State D: chooser

Add:

- State E: raw Pi transcript replay

Proposed keys:

```text
chooser Enter       -> overview
overview right      -> agent detail
agent detail right  -> raw transcript replay
agent detail Enter  -> prompt reader
raw transcript left -> agent detail
raw transcript esc  -> agent detail or close according to existing unwind rules
prompt reader left/esc -> agent detail
```

State B footer should advertise the deeper view:

```text
↑↓ agent · → transcript · ↵ prompt · x stop · r restart · p pause · esc back · s save
```

State E footer:

```text
↑↓ scroll · PgUp/PgDn page · Enter expand/collapse · t follow tail · ← back · esc close
```

## Raw transcript view UX

The view should look like a replay of Pi conversation blocks, not a summary table:

```text
feature-flags-tdd-ultracode                         implement:tdd-feature-flags
.pi/workflows/wf_e50ffcd8c5ef1b6f/transcripts/agent-a60d76a21cde8691b.meta.json

● Running · openai-codex/gpt-5.5 · thinking xhigh · turn 6 · 13 tools

──────────────────────────────────────────────────────────────────────────────

USER
  You are a dynamic-workflow subagent running in an isolated Pi sidechain...

ASSISTANT thinking
  I need inspect feature flag spec and existing routing...

TOOL read  brain/plans/workflows/feature-flags/spec.md
  # Spec: Workflow Feature Flags
  ...

TOOL bash  pnpm test test/workflows/model-routing/resolve.test.ts
  FAIL ...

ASSISTANT
  I found the resolver needs explicit source precedence...

STRUCTURED_OUTPUT
  pending...
```

Rendering should use a stable transcript projector first:

```text
Pi session JSONL -> TranscriptBlock[] -> State E renderer
```

`TranscriptBlock` should cover user messages, assistant messages, thinking, tool calls, tool results, custom messages, model/thinking changes, and unknown entries. The renderer may use Pi's exported public components such as `UserMessageComponent`, `AssistantMessageComponent`, and `ToolExecutionComponent` where safe, but tests should target the project-local block projection and stable rendered labels rather than exact Pi private formatting.

## Missing or legacy transcript states

If `transcriptPath` is missing:

```text
No full transcript was captured for this agent.
This run only has compact manifest activity. Future runs can record Pi-native sidechain transcripts.
```

If the transcript file is missing or unreadable:

```text
Transcript file could not be opened: <path>
The manifest still contains compact activity for this agent.
```

If the transcript is malformed:

```text
Transcript file is not a valid Pi session JSONL transcript.
```

These are UI states, not workflow failures.

## Testing strategy

### Storage and runner tests

Owners: `src/workflows/agent/pi-runner.ts`, `src/workflows/agent/scheduler.ts`, launch/runtime option plumbing.

Test with fake session factories and temp directories:

- Creates a persisted sidechain session under `.pi/workflows/<runId>/transcripts/sessions/`.
- Does not write workflow agent transcripts to the normal user session directory.
- Emits `transcript_started` and scheduler patches `transcriptPath`/`transcriptFormat`.
- Writes `agent-<agentId>.meta.json` with the expected mapping.
- Falls back to in-memory execution if transcript setup fails.
- Still records transcript metadata for failed and aborted agents when the session file was created.

### Transcript reader/projector tests

Owners: future `src/workflows/transcript/*` or `src/workflows/view/transcript-*` modules.

Use hand-written Pi session JSONL fixtures. Assert projection for:

- user message blocks;
- assistant text and thinking blocks;
- tool call and tool result pairs;
- structured_output tool calls;
- model and thinking-level change entries;
- custom messages;
- unknown entries as safe fallback blocks;
- missing, unreadable, and malformed files.

### TUI navigation and rendering tests

Owners: `src/workflows/view/navigation.ts`, `src/extension/tui/workflows-component.ts`.

Add tests:

- State B right arrow opens State E.
- State E left arrow returns to State B.
- State E escape unwinds according to the existing monitor rules.
- `j/k`, arrow keys, PageUp/PageDown scroll transcript content.
- `t` toggles follow-tail mode for active/running transcripts.
- Missing transcript renders the honest unavailable state.
- Every rendered line stays within widths 42 and 120.
- Golden-ish snapshots cover one canonical raw transcript screen, but assertions should not depend on exact Pi private component internals.

### End-to-end fake-runner test

Create a fake Pi session that appends representative Pi session messages into a temp `SessionManager`, run one workflow agent through the real scheduler/runner boundary, then open the `/workflows` component and render State E.

This proves:

```text
runner -> persisted sidechain session -> manifest transcriptPath -> reader -> raw transcript UI
```

without calling a live model.

## Implementation slices

1. **Transcript capture plumbing**
   - Thread `transcriptDir` from launcher to runtime to scheduler to runner.
   - Persist Pi-native sidechain sessions and meta files.
   - Patch manifest agent rows with transcript fields.

2. **Transcript reader/projector**
   - Parse Pi session JSONL into stable `TranscriptBlock[]`.
   - Handle missing/corrupt/legacy states.
   - Keep this independent from Pi TUI components.

3. **State E TUI**
   - Add navigation state and key handling.
   - Render raw transcript blocks with width-safe scrolling.
   - Add follow-tail for running agents.

4. **Polish with Pi component adapter**
   - Optionally use public Pi message/tool components for closer visual parity.
   - Keep project-local fallback renderers for tests and non-standard blocks.

## Acceptance criteria

- A future workflow run writes a durable per-agent Pi-native transcript session.
- `manifest.json` stores optional transcript pointers without bloating overview data.
- `/workflows` State B can drill right into a full transcript replay.
- Old runs without transcript capture show an honest missing-transcript state.
- The overview and structured detail continue to render from manifest only.
- Unit and integration-style fake tests prove the storage, projector, navigation, and renderer behavior without live model calls.
