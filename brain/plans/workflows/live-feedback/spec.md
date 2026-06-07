# Spec: Live Workflow Feedback And Accurate Activity States

## Status

Partial.

Slice A (honest labels only) is implemented: the projector and `/workflows` TUI
now label running agents with no live telemetry as `running … · no live events`
instead of `idle`. Idle remains available only after compact live evidence such
as a tool summary has been observed.

Slice B (phase and agent display dedupe) is implemented: repeated phase progress
entries collapse into one visible phase, repeated agent progress rows are
deduplicated for monitor counts and selected rows, and failed phase agents are
counted separately from completed agents.

Slice C (live event plumbing with fake runner) is implemented: the scheduler/runner
boundary accepts compact `WorkflowAgentLiveEvent` updates, scheduler-owned progress
rows are patched with current activity/tool fields, projection exposes that activity,
and the `/workflows` overview prefers current tool activity such as `using read` over
generic metrics.

Slice D (Pi session subscription adapter) is implemented for the real Pi runner:
`createPiWorkflowAgentRunner` subscribes to sidechain `AgentSession` events and maps
turn/message/tool lifecycle updates into compact workflow live events. Throttled
manifest persistence and a richer detail activity timeline remain planned.

This is a product/technical specification for implementation slices that extend
the existing `/workflows` monitor work in
[`brain/plans/workflows/workflows-monitor/ticket.md`](../workflows-monitor/ticket.md) and the
storage/UI decisions in ADR 0010 and ADR 0013. It does not change scheduling or
workflow script semantics.

## Product owner summary

When a dynamic workflow fans out subagents, the user needs immediate confidence
that work is actually happening. The UI must show agents as queued, starting,
thinking, using tools, waiting, done, or failed based on real runtime events. It
must never label a freshly running subagent as `idle` merely because token/tool
telemetry has not been wired yet.

The target experience is a live control-room dashboard: within a second of
launch, the user sees which agents started; while they run, rows show the latest
known activity and elapsed time; when tools run, the current tool appears; and
when telemetry is unavailable, the UI says that honestly instead of implying a
performance problem.

## Triggering observation

A real run of `in-depth-project-code-review` appeared to show all first-phase
agents as `idle` for roughly four minutes. The persisted data showed a different
story:

- The workflow run started at `09:57:12.778`.
- All six scout agents were queued and marked running within about 16 ms.
- The first scout agent finished/failed at about 164 seconds.
- The slowest scout agent finished at about 242 seconds.

So the scheduler was not delayed. The UI was misleading because running Pi
subagents did not stream live `AgentSession` events into `WorkflowAgentProgress`.
`lastProgressAt` stayed equal to `startedAt`, and the view projected that as
`idle`.

A second issue appeared in the same run: repeated `phase("Adversarial verification")`
calls inside a `pipeline()` produced duplicate phase sections and duplicate agent
rows in the merged progress view. Live feedback work should fix or mask this so
users see one row per real agent.

## Problem statement

Current `/workflows` progress answers only three questions well:

1. Which workflow is running?
2. Which agents have been scheduled?
3. Which agents eventually finished or failed?

It does not answer the user's urgent live questions:

- Did the workflow actually start?
- Is an agent waiting in the queue, creating a sidechain, thinking, or using a tool?
- What was the last observable event?
- Is the agent truly idle, or do we simply lack telemetry?
- Which phase is active right now?
- Is the UI stale, or is the model still working?

## Goals

1. Show a truthful activity label for every agent row.
2. Show useful live feedback from Pi subagent lifecycle events.
3. Preserve the `/workflows` overview as a cheap manifest-backed read model.
4. Avoid creating a new performance problem by writing huge manifests on every
   message delta.
5. Make the UI understandable even when detailed telemetry is missing.
6. Make phase and agent counts stable even when workflow scripts call `phase()`
   repeatedly.
7. Keep projection and TUI rendering testable without live model calls.

## Non-goals

- Do not change `parallel()`, `pipeline()`, scheduler concurrency, journal resume,
  or workflow JavaScript semantics.
- Do not require exact Claude Code internal event names.
- Do not store full streamed assistant text in `manifest.json`.
- Do not make `/workflows` overview parse full transcripts.
- Do not add live model integration tests; use fake sessions/events for tests.
- Do not solve structured-output retry policy in this slice, except to surface
  missing structured output clearly when it happens.

## UX principles

1. **Truth beats optimism.** If no telemetry is available, say `running · no live events yet`, not `idle`.
2. **First feedback must be immediate.** Users should see launch, queue, and start
   transitions before the model produces its first answer.
3. **Every active row needs a clock.** Show elapsed time for queued/running/tool states.
4. **Use activity words, not implementation words.** Prefer `thinking`, `using read`,
   `waiting for model`, and `finalizing` over raw event names.
5. **Make stale data visible.** If the manifest has not changed recently, show
   `last update 37s ago` in detail or footer contexts.
6. **Keep overview compact.** Detailed event timelines belong in agent detail, not
   the phase overview list.
7. **Cap noisy data.** Recent activity summaries should be short and bounded.

## User stories

### Live confidence

As a user who launched a large workflow,
I want to see agents move from queued to running immediately,
so that I know the workflow is not stuck before the first result arrives.

### Current activity

As a user watching a running subagent,
I want to see whether it is thinking, using a tool, or lacking telemetry,
so that I can distinguish real model work from a stalled integration.

### Focused diagnosis

As a user investigating a slow agent,
I want agent detail to show a recent activity timeline,
so that I can understand whether it is doing useful work without opening raw transcripts.

### Accurate phase progress

As a user scanning phase progress,
I want one stable row per phase and one stable row per agent,
so that repeated `phase()` calls inside pipelines do not inflate counts.

## Terminology

| Term | Meaning |
|---|---|
| Activity state | User-facing label derived from scheduler and subagent events, e.g. `queued`, `starting`, `thinking`, `using tool`, `done`. |
| Live event | A runtime event emitted while an agent is running, usually from `AgentSession.subscribe()`. |
| No telemetry | The agent is running, but no live subagent event has been observed beyond start. This is not an idle state. |
| Idle | The agent previously emitted live events, but no new event has arrived beyond a defined threshold while the agent remains running. |
| Manifest snapshot | Compact persisted run state used by `/workflows`; safe to poll and render from. |
| Activity log | Optional append-only per-run/per-agent event stream for detailed drill-down. Not required for overview. |

## Activity-state model

Add an explicit activity projection on top of existing agent lifecycle state.
Lifecycle state remains the durable control state:

```ts
type WorkflowAgentState = "queued" | "running" | "done" | "failed" | "stopped";
```

Activity state is a finer user-facing label:

```ts
type WorkflowAgentActivityState =
  | "queued"
  | "starting"
  | "waiting_for_model"
  | "thinking"
  | "streaming"
  | "using_tool"
  | "waiting_for_tool"
  | "finalizing"
  | "no_telemetry"
  | "idle"
  | "done"
  | "failed"
  | "stopped";
```

Recommended compact labels:

| Activity state | Overview label |
|---|---|
| `queued` | `queued 12s` |
| `starting` | `starting 1s` |
| `waiting_for_model` | `waiting for model 8s` |
| `thinking` | `thinking 2m14s` |
| `streaming` | `writing 4s` |
| `using_tool` | `using read 3s` |
| `waiting_for_tool` | `waiting for bash 9s` |
| `finalizing` | `finalizing` |
| `no_telemetry` | `running 2m27s · no live events` |
| `idle` | `idle 42s` |
| `done` | `done 3m47s · 11 tools` |
| `failed` | `failed 2m44s · missing structured_output` |
| `stopped` | `stopped` |

`idle` MUST NOT be used before at least one real live event has been observed
for the agent after `agent_started`.

## Event sources

### Scheduler events

The scheduler already knows:

- queued
- started
- succeeded
- failed
- stopped
- queued time
- started time
- finished duration

These events must continue to update the compact manifest immediately.

### Pi subagent session events

`createPiWorkflowAgentRunner()` creates an isolated `AgentSession`. That session
can expose lifecycle events through `session.subscribe()`:

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `turn_end`
- `agent_end`
- retry/compaction/queue events when present

Map these to workflow activity events without exposing Pi-internal names directly
in the UI.

## Event mapping

| Pi/session event | Workflow activity update |
|---|---|
| session factory begins | `starting`, `lastEventLabel: "creating sidechain"` |
| `agent_start` | `waiting_for_model`, `turnCount: 0` |
| `turn_start` | `waiting_for_model`, increment/mark turn |
| `message_start` | `thinking` or `streaming`, `lastEventLabel: "assistant started"` |
| `message_update` | `thinking`/`streaming`, update `lastEventAt`, optional token/message counters |
| `tool_execution_start` | `using_tool`, set `currentToolName`, increment `toolCalls` |
| `tool_execution_update` | `using_tool`, update `lastToolSummary` from partial result summary |
| `tool_execution_end` | `waiting_for_model` or `thinking`, clear current tool, record recent tool summary |
| `turn_end` | `finalizing` if no more tool calls are pending, otherwise `waiting_for_model` |
| `agent_end` | let scheduler apply `done` or `failed` based on final result/schema handling |
| missing structured output | `failed`, result preview `missing structured_output` |

## Data model requirements

Extend `WorkflowAgentProgress` with compact live fields. Names are illustrative;
implementation may adjust, but must preserve the product behavior.

```ts
interface WorkflowAgentProgress {
  // existing fields stay
  state: "queued" | "running" | "done" | "failed" | "stopped";
  queuedAt: number;
  startedAt?: number;
  lastProgressAt?: number;
  durationMs?: number;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;

  // new compact live fields
  activityState?: WorkflowAgentActivityState;
  activityLabel?: string;
  lastEventAt?: number;
  lastEventType?: string;
  lastEventLabel?: string;
  currentToolName?: string;
  currentToolCallId?: string;
  turnCount?: number;
  messageUpdateCount?: number;
  observedLiveEvents?: number;
  telemetryAvailable?: boolean;
  recentActivity?: WorkflowAgentActivitySummary[];
}

interface WorkflowAgentActivitySummary {
  at: number;
  label: string;
  detail?: string;
  toolName?: string;
  isError?: boolean;
}
```

Caps:

- `recentActivity` in `manifest.json` MUST be capped to the latest 3-5 entries per
  agent.
- `label` SHOULD be <= 80 visible columns before rendering truncation.
- `detail` SHOULD be <= 200 characters and must not include huge tool outputs.
- Full assistant text deltas MUST NOT be stored in `manifest.json`.

## Storage requirements

### Manifest remains the overview read model

`manifest.json` remains sufficient for:

- chooser rows,
- header counts,
- phase list,
- agent overview rows,
- compact detail status,
- recent activity digest.

The overview MUST NOT require reading journals, output files, or transcripts.

### Optional activity log

A later implementation may add:

```text
.pi/workflows/<runId>/activity.jsonl
```

or per-agent files under:

```text
.pi/workflows/<runId>/transcripts/
```

This log may contain fuller event history for deep debugging. It must be treated
as a drill-down artifact, not as a dependency for overview rendering.

### Write policy

Live events can be frequent. Persistence must be throttled:

- Queue/start/done/failed/stopped transitions: persist immediately.
- Tool start/end: persist immediately or within 250 ms.
- Message update/streaming deltas: coalesce and persist at most once per second
  per run.
- Render requests may be faster than manifest writes when an in-memory UI handle
  is available.
- Terminal output and journal semantics are unchanged.

## Runtime API shape

Introduce an internal event callback from scheduler to runner or from runner back
to scheduler. One possible shape:

```ts
interface WorkflowAgentRunRequest {
  agentId: string;
  journalKey?: WorkflowJournalKey;
  prompt: string;
  options: AgentOptions;
  signal: AbortSignal;
  onEvent?: (event: WorkflowAgentLiveEvent) => void;
}

type WorkflowAgentLiveEvent =
  | { type: "sidechain_starting"; at: number }
  | { type: "agent_event"; at: number; eventType: string; label: string }
  | { type: "tool_start"; at: number; toolCallId: string; toolName: string; summary?: string }
  | { type: "tool_update"; at: number; toolCallId: string; toolName: string; summary?: string }
  | { type: "tool_end"; at: number; toolCallId: string; toolName: string; summary?: string; isError: boolean }
  | { type: "message_update"; at: number; summary?: string }
  | { type: "usage_update"; at: number; tokens?: number; toolCalls?: number };
```

The scheduler remains the owner of `WorkflowAgentProgress`. Runners report live
events; the scheduler applies bounded patches and emits `onProgress`.

## UI requirements

### Overview header

Header should include:

```text
workflow-name                                           8/13 agents · 6m22s
Description text
```

Optional when useful:

```text
2 running · 1 failed · last update 4s ago
```

### Phase rows

Phase rows should show stable counts:

```text
› 1 Scout review areas          5/6 done · 1 failed
  2 Adversarial verification    3/5 done · 2 running
  3 Synthesize recommendations  waiting
```

Rules:

- Deduplicate repeated phase entries by phase title for display.
- Preserve first-seen order.
- If metadata declares planned agents, use metadata for totals.
- If runtime adds agents beyond metadata, totals expand to include real agents.
- Failed agents count separately from done agents.

### Agent overview rows

Examples:

```text
○ scout:docs-spec        queued 12s
◐ scout:architecture     starting sidechain 1s
● scout:runtime          thinking 2m14s · turn 1
◒ scout:tui              using read 4s · 7 tools
● scout:tests            running 2m27s · no live events
✓ scout:build-dx         done 2m48s · 14 tools
! scout:tests-quality    failed 2m44s · missing structured_output
```

Rules:

- Never show `idle` before a live event has been observed.
- If `activityState` is absent for a running agent, derive `no_telemetry`.
- Prefer current tool over generic thinking when a tool is active.
- Right-align metrics only when width permits.
- Truncate long labels safely with ANSI-aware width helpers.

### Agent detail panel

Detail should show structured sections:

```text
verify:workflow-runtime
● Running · openai-codex/gpt-5.4-mini · thinking medium
running 3m11s · no live events yet

Timing
  queued +2m42s · started +2m42s · last event +2m42s

Activity
  No live subagent events observed yet. The sidechain may still be thinking or
  this Pi runner may not expose streaming telemetry.

Prompt · 17 lines · Enter expand
  You are the skeptical verifier for focus area...

Outcome
  Still running...
```

When activity exists:

```text
Activity · last 5 events
  10:03:12 turn 2 started
  10:03:16 using read src/workflows/script/runtime.ts
  10:03:19 read finished
  10:03:22 using bash rg "phase\(" src test
  10:03:26 bash finished
```

### Footer/statusline

The passive footer statusline from ADR 0013 should stay compact but use the same
activity vocabulary:

```text
○ in-depth-project-code-review  8/13 · 6m22s · Verify · verify-runtime thinking
```

If telemetry is missing:

```text
○ in-depth-project-code-review  5/13 · 4m02s · Scout · running/no telemetry
```

## Idle and staleness rules

Define thresholds centrally so tests and UI agree.

Recommended defaults:

- `noTelemetryThresholdMs`: 0 ms after start when no live events have ever arrived.
- `idleThresholdMs`: 60_000 ms since `lastEventAt`, only after `observedLiveEvents > 0`.
- `staleManifestThresholdMs`: 15_000 ms since manifest mtime or last state observer event.

Derived behavior:

- Running + no live event: `running Ns · no live events`.
- Running + live event within idle threshold: show current activity.
- Running + live event older than idle threshold: `idle Ns · last: <activity>`.
- Running + manifest stale: add subdued `last update Ns ago` in detail/header, but do
  not mark the agent failed or stopped.

## Performance requirements

- Scheduling a row and persisting initial running state should remain effectively
  immediate; target under 250 ms excluding filesystem variance.
- UI should render elapsed time at least once per second for active workflows.
- Message-update events should not cause more than one manifest write per second
  per run.
- Manifest size growth from live feedback must be bounded by caps on recent events
  and summary lengths.
- Rendering must obey Pi TUI's `render(width)` contract for every line.

## Accessibility and visual language

Use both glyph and text; do not rely on color alone.

Recommended glyphs:

| State | Glyph |
|---|---|
| queued | `○` |
| starting | `◐` |
| running/thinking | `●` |
| using tool | `◒` |
| done | `✓` |
| failed | `!` |
| stopped | `■` |

Color is secondary:

- running/thinking: accent
- tool: accent or warning depending on theme
- done: success/muted label
- failed: error
- no telemetry: dim/warning, not error
- idle: warning

## Acceptance criteria

### Feature: truthful running state

```gherkin
Scenario: Running agent without telemetry is not labeled idle
  Given an agent is running
  And its startedAt is 120 seconds ago
  And no live subagent event has been observed
  When /workflows renders the agent row
  Then the row says "running 2m" or "no live events"
  And the row does not say "idle"
```

```gherkin
Scenario: Running agent with stale live events can be labeled idle
  Given an agent is running
  And it observed a tool event 90 seconds ago
  And the idle threshold is 60 seconds
  When /workflows renders the agent row
  Then the row says "idle 1m 30s"
  And the row includes the last known activity summary
```

### Feature: live subagent activity

```gherkin
Scenario: Tool start updates the agent row
  Given an agent is running
  When the Pi sidechain emits tool_execution_start for tool "read"
  Then the workflow progress row records currentToolName "read"
  And /workflows shows "using read"
```

```gherkin
Scenario: Tool end records a recent activity summary
  Given an agent is using tool "bash"
  When the Pi sidechain emits tool_execution_end successfully
  Then currentToolName is cleared
  And recentActivity includes a bounded "bash finished" summary
  And toolCalls increments or stays consistent with the session event count
```

```gherkin
Scenario: Message updates refresh last progress time without bloating manifest
  Given an agent is streaming assistant message updates
  When ten message_update events arrive within one second
  Then the in-memory row updates activity promptly
  And manifest persistence is coalesced to at most one write for that second
```

### Feature: stable phases and counts

```gherkin
Scenario: Repeated phase calls do not duplicate visible phase rows
  Given workflowProgress contains multiple workflow_phase entries with title "Verify"
  And agents for phase "Verify"
  When /workflows renders the phase list
  Then only one "Verify" phase row is shown
  And each agent appears once
```

```gherkin
Scenario: Failed agents are counted distinctly
  Given a planned phase has 6 agents
  And 5 agents are done
  And 1 agent failed
  When /workflows renders the phase row
  Then the phase row shows "5/6 done · 1 failed"
```

### Feature: detail diagnosis

```gherkin
Scenario: Detail explains missing telemetry
  Given an agent is running with no live events
  When the user opens agent detail
  Then the Activity section says no live subagent events have been observed
  And it explains the agent may still be thinking or telemetry may be unavailable
```

```gherkin
Scenario: Detail shows recent activity timeline
  Given an agent has five recent activity summaries
  When the user opens agent detail
  Then the Activity section lists those summaries newest or chronological by spec choice
  And no summary exceeds the pane width
```

## Test plan

### Pure projection tests

Owners: `src/workflows/view/projector.ts`, `test/workflows/view/projector.test.ts`.

Add tests for:

- running with no telemetry => no `idle`, shows `no live events`;
- running with recent tool event => `using <tool>`;
- running with old live event => `idle`;
- done/failed rows prefer terminal state over activity state;
- duplicated phase entries are collapsed in view projection;
- failed counts appear in phase rows;
- recent activity caps are respected.

### TUI render tests

Owners: `src/extension/tui/workflows-component.ts`, TUI snapshots/tests.

Add tests for:

- overview row labels for queued/starting/thinking/tool/no-telemetry/idle;
- detail panel missing-telemetry explanation;
- detail panel recent activity timeline;
- narrow width truncation;
- no line exceeds `render(width)` width.

### Scheduler/runner tests

Owners: `src/workflows/agent/scheduler.ts`, `src/workflows/agent/pi-runner.ts`.

Add fake-session tests for:

- `session.subscribe()` events map to live workflow events;
- live events patch scheduler-owned progress;
- abort/dispose still cleans up subscriptions;
- structured-output missing tool call still fails with a clear preview;
- message update coalescing does not swallow terminal done/failed transitions.

### Persistence tests

Owners: `src/workflows/launch/launcher.ts`, `src/workflows/run/store.ts`.

Add tests for:

- immediate persistence on queue/start/done/failed;
- throttled persistence for repeated live message updates;
- bounded manifest size for recent activity;
- `/workflows` overview still reads only manifest files.

## Suggested implementation slices

### Slice A: Honest labels only

- Rename current `idle` projection for no-telemetry running agents.
- Add projection tests.
- No runner changes.

### Slice B: Phase and agent display dedupe

Implemented.

- Collapse duplicate phase entries by title in view projection.
- Ensure selected phase agents are unique by stable `agentId`/`index` identity.
- Count failed phase agents separately from done agents.
- Add tests using repeated `phase()` entries from a pipeline.

### Slice C: Live event plumbing with fake runner

Implemented.

- Add internal `WorkflowAgentLiveEvent` callback shape.
- Let scheduler apply live-event patches.
- Test without Pi.

### Slice D: Pi `AgentSession.subscribe()` adapter

- Subscribe in `pi-runner.ts`.
- Map session events to workflow live events.
- Add fake Pi session tests.

### Slice E: Throttled persistence and UI render cadence

- Coalesce high-frequency updates.
- Keep immediate writes for meaningful transitions.
- Add manifest-size and write-count tests.

### Slice F: Activity timeline in detail UI

- Render recent activity summaries in agent detail.
- Add narrow/wide snapshot tests.

## Open questions

1. Should activity logs use a new `activity.jsonl`, the existing journal, or future
   transcript files? Product preference: use a separate activity log if full
   timeline persistence is needed, because the journal is for resume/cache.
2. Should `message_update` map to `thinking` or `streaming` by default? Product
   preference: use `thinking` unless we can reliably detect user-visible text deltas.
3. Should the detail timeline be newest-first or chronological? Product preference:
   chronological for the last 5 events, because it reads like a mini story.
4. What is the idle threshold? Product default: 60 seconds after at least one live
   event, configurable later if needed.
5. Should prompt text eventually move out of `manifest.json`? Product preference:
   yes, but that is separate from this live-feedback slice.

## Done means

- A newly started workflow shows running agents immediately.
- A running agent with no live event telemetry is not labeled `idle`.
- When Pi sidechain tool events are available, `/workflows` shows the current or
  most recent tool.
- Agent detail explains missing telemetry and shows recent activity when present.
- Duplicate phase entries do not inflate visible phase/agent counts. (Implemented in Slice B.)
- Manifest writes remain bounded and overview rendering stays manifest-only.
- Pure projection, TUI render, scheduler, runner, and persistence tests cover the
  behavior without requiring live model calls.
