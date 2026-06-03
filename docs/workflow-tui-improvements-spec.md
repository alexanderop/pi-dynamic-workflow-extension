# Workflow TUI Improvements Spec

## Context

This Pi extension currently provides a workflow tool plus `/workflows` browser UI. A comparison against the temporary clone of `git@github.com:alexanderop/defineworkflow.git` showed that `defineworkflow` has a richer terminal workflow dashboard built around a three-pane model: phases, agents, and detail.

This spec captures the desired improvements for this extension so the workflow UI feels closer to `defineworkflow` while remaining compatible with Pi's TUI component API (`Component.render(width): string[]`) rather than Ink/React.

## Goals

- Make `/workflows` easier to navigate during multi-agent runs.
- Show workflow progress by phase, not only by job/agent list.
- Provide richer per-agent details: prompt, recent activity, outcome, timing, and metrics.
- Preserve Pi extension compatibility and keep each rendered line within terminal width.
- Avoid copying Ink/React directly; port behavior and layout into Pi TUI components.

## Non-goals

- Replace Pi's TUI stack with Ink/React.
- Implement a full standalone `defineworkflow` clone.
- Add unsafe/private workflow data to the UI.
- Require network access or new runtime dependencies for basic rendering.

## Current UI gaps

### 1. Missing three-pane layout

Current `/workflows` mainly shows a workflow strip, agent list, and selected details. It does not provide a phase-focused workflow view.

Desired layout:

```text
Workflow name                                      4/7 agents · 2m10s
Description or status line
┌──────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Phases               │ Agents                       │ Detail                       │
│ › ⠋ Research 1/4     │ › ⠋ #2 professional_presence │ Running · Sonnet             │
│   ✓ Guardrails 1/1   │   ✓ #1 guardrails            │ 3 tools · 1m20s              │
│   ○ Synthesis 0/2    │   ○ #3 technical_projects    │                              │
│                      │                              │ Prompt                       │
│                      │                              │   Research public...         │
└──────────────────────┴──────────────────────────────┴──────────────────────────────┘
↑↓ select · ←→ focus · enter expand · j/k scroll · c cancel · q close
```

### 2. Missing phase navigation

Desired keyboard model:

- `←` / `→`: move focus between phases, agents, and detail panes.
- `↑` / `↓`: select phase or agent depending on focused pane.
- `j` / `k`: scroll detail pane.
- `enter`: expand/collapse prompt or long result text.
- `c`: cancel running workflow.
- `q` / `esc`: close browser.

### 3. Weak per-agent rows

Current agent rows show status, id, label, and sometimes phase.

Desired agent row fields:

- status glyph/spinner
- agent id
- label
- model, when known
- token count, when known
- tool-call count
- elapsed time
- cached/replayed marker, if applicable later

Example:

```text
› ⠋ #2 professional_presence        Sonnet · 3 tools · 1m20s
  ✓ #1 guardrails                   0 tools · 12s
```

### 4. Weak detail pane

Current details include label, phase, status, prompt, recent activity, and short result preview.

Desired detail sections:

- Status line: running/done/error/cancelled plus model if known.
- Metrics: tools, tokens, elapsed time.
- Prompt preview with expand/collapse.
- Activity digest: recent text/tool/log events.
- Outcome: result text/preview or error.
- Workflow result when no agent is selected.

### 5. Missing elapsed timer / spinner refresh

`defineworkflow` advances spinner frames and elapsed timers even when no new workflow events arrive.

Desired behavior:

- While `/workflows` is open and at least one selected job is running, request periodic render updates.
- Use lightweight interval cleanup when component closes.
- Keep this scoped to the browser UI; do not create global background timers unless needed.

### 6. No end-of-run report

Current completion output is a compact textual summary plus final JSON.

Desired completed-run report:

- Workflow name and final status.
- Duration.
- Total agents, done/error/cancelled counts.
- Tool-call count.
- Per-phase table.
- Per-agent table with status and timings.
- Final result preview with pointer to `/workflows` for full details.

### 7. Missing advanced controls

Potential future controls inspired by `defineworkflow`:

- pause/resume run
- stop selected agent
- restart selected agent
- save selected workflow from inside UI
- human-in-the-loop question prompt

These require workflow-manager/runtime changes and should be later phases, not part of the first UI-only pass.

## Proposed implementation plan

### Phase 1: Data model enrichment

Extend `WorkflowAgentSnapshot` in `src/display.ts` with optional fields:

```ts
startedAt?: number;
endedAt?: number;
model?: string;
liveTokens?: number;
inputTokens?: number;
outputTokens?: number;
toolCount?: number;
resultText?: string;
cached?: boolean;
```

Also consider adding workflow-level derived counts:

```ts
toolCount?: number;
```

Update snapshot producers in:

- `src/workflow-manager.ts`
- `src/workflow-tool.ts`

Minimum viable fields for first pass:

- `startedAt`
- `endedAt`
- `toolCount` derived from activity events of type `tool`
- `resultText` or richer result preview

### Phase 2: Shared formatting helpers

Add a small formatting module, e.g. `src/workflow-ui-format.ts`, with:

- `statusGlyph(status, frame)`
- `formatDuration(ms)`
- `formatTokens(n)`
- `singleLine(text)`
- `cell(text, width)`
- `windowAround(items, selected, size)`

Use Pi TUI utilities:

- `truncateToWidth`
- `visibleWidth`

### Phase 3: Navigation state

Refactor `WorkflowBrowser` to track:

```ts
type FocusPane = "phases" | "agents" | "detail";

interface BrowserNavState {
  selectedJobIndex: number;
  selectedPhaseIndex: number;
  selectedAgentIndex: number;
  focus: FocusPane;
  detailScroll: number;
  expanded: boolean;
}
```

Selection behavior:

- Selecting a phase resets selected agent to first agent in that phase.
- Selecting a different job resets phase/agent/detail state.
- Detail pane stays attached to the selected agent.

### Phase 4: Three-pane rendering

Replace current `renderWide()` with:

- `renderHeader(job, width)`
- `renderJobStrip(jobs, width)`
- `renderPhasesPane(job, width, height)`
- `renderAgentsPane(job, selectedPhase, width, height)`
- `renderDetailPane(job, selectedAgent, width, height)`
- `renderFooter(width)`

For narrow terminals, keep a fallback stacked layout.

Recommended width behavior:

- `< 70`: narrow stacked view.
- `70–110`: two-pane mode (phases/agents + detail summary).
- `> 110`: full three-pane mode.

### Phase 5: Prompt expansion and detail scrolling

Detail rows should be generated as a flat string array:

```ts
function detailRows(job, agent, expanded): string[]
```

Rules:

- Long prompts show first 2 lines by default.
- `enter` toggles prompt expansion.
- `j/k` scrolls detail content.
- Show scroll indicator like `3–14 of 28 ↓` when overflowing.

### Phase 6: Periodic render while open

Inside `WorkflowBrowser` constructor:

- Start an interval if any workflow is running.
- Increment a `frame` counter.
- Call `tui.requestRender()`.
- Clear interval in `close()`.

Avoid leaking timers by making `close()` idempotent.

### Phase 7: Completion report

Add report helpers that summarize a `WorkflowJob` / `WorkflowSnapshot`:

- `selectWorkflowReport(job)`
- `renderWorkflowReportText(report)`

Use in:

- workflow completion message formatting in `extensions/workflow.ts`
- completed job detail pane in `/workflows`

## Acceptance criteria

- `/workflows` shows phases, agents, and details in a wide terminal.
- Keyboard navigation supports phase and agent selection.
- Detail pane supports scroll and prompt expansion.
- Running workflows show an animated spinner and live elapsed time while `/workflows` is open.
- All rendered lines respect the `width` argument.
- Existing tests pass.
- Add/update unit tests for:
  - phase row derivation
  - agent filtering by phase
  - navigation state transitions
  - detail row expansion/scrolling
  - narrow fallback rendering

## Candidate files to modify

- `src/display.ts`
- `src/workflow-browser.ts`
- `src/workflow-dashboard.ts`
- `src/workflow-manager.ts`
- `src/workflow-tool.ts`
- `extensions/workflow.ts`
- `tests/workflow-display.test.ts`
- new: `src/workflow-ui-format.ts`
- new: `src/workflow-report.ts`
- new tests as needed

## Open questions

1. Can Pi subagent sessions expose reliable model/token usage events for workflow agents?
2. Should `/workflows` support agent-level cancellation, or only whole-workflow cancellation for now?
3. Should saved workflow commands be accessible from inside the browser UI via `s`?
4. Should completed workflow reports be rendered as custom message components, tool result components, or plain text?
5. Should phase metadata from `meta.phases` be preserved even if a phase was not reached?

## Suggested first implementation slice

Implement only the UI/layout improvements using currently available data:

- three-pane `/workflows`
- phase selection
- agents filtered by phase
- detail scroll
- prompt expand/collapse
- spinner/elapsed timer

Defer tokens, model names, pause/restart, and human questions until the runtime exposes the necessary data.
