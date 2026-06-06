# Ticket: Make `/workflows` match the Claude Code workflow monitor

## Status

Planned

## Product owner summary

Users expect `/workflows` to feel like the real Claude Code dynamic-workflow monitor: a live terminal dashboard with phases, agents, compact detail, and prompt drill-down. The current exploratory UI still feels like a generic job browser. Replace it with the monitor shape defined in `spec.md` §23.

## User story

As a Pi user running dynamic workflows,
I want `/workflows` to open a Claude-Code-like workflow monitor,
so that I can quickly understand which phase is active, which agents are running, what each agent is doing, and inspect an agent's original prompt only when I explicitly ask for it.

## Source of truth

- Primary: `spec.md` §23 Workflow UI Reference Screens.
- This ticket translates that section into an implementation-ready product ticket.
- Existing workflow execution semantics must not change.

## Goals

- One active workflow opens directly into the monitor overview.
- Multiple workflows open a chooser first.
- Overview is a two-pane phase/agent dashboard.
- Agent detail is structured and compact, not a prompt/result dump.
- Enter opens a full original-prompt reader with scrolling.
- Every rendered line respects Pi TUI `render(width)`.

## Non-goals

- Do not implement runtime pause/restart/stop if controller support is not ready.
- Do not change workflow scheduling, journal, resume, or execution semantics.
- Do not add mouse support.
- Do not preserve the old generic `Runs / Progress / Agents / Details` browser layout.

## ASCII UI diagrams

### Flow

```text
/workflows
  │
  ├─ 0 workflows ───────────────► Empty state
  │
  ├─ 1 active workflow ─────────► State A: Overview monitor
  │                                  │
  │                                  ├─ ← ─► State B: Agent detail
  │                                  │          │
  │                                  │          ├─ Enter ─► State C: Prompt reader
  │                                  │          │              └─ Esc ─► State B
  │                                  │          └─ →/Esc ─► State A
  │                                  └─ Esc ─► close
  │
  └─ multiple workflows ────────► State D: Workflow chooser
                                     │
                                     ├─ ↑/↓ select
                                     ├─ Enter ─► State A
                                     └─ Esc ─► close
```

### State A: overview monitor

```text
────────────────────────────────────────────────────────────────────────────────────────────────────────────
hardening_slice_and_author                                                       1/8 agents · 1m12s
Slice the workflow-correctness-hardening spec into TDD-ready implementation plans, and author a reusable spec-implementation pipeline workflow

┌ Phases ───────────────┬ Slice · 7 agents ────────────────────────────────────────────────────────────────┐
│ › 1 Slice   0/7       │ ● slice:P0.1-journal-keyi… Opus 4.8 (1M context)                   41.1k tok · 11 tools │
│   ✓ Author 1/1        │ ● slice:P0.2-fault-isolat… Opus 4.8 (1M context)                   33.4k tok · 17 tools │
│                       │ ● slice:P0.3-journal-clone Opus 4.8 (1M context)                   25.2k tok · 11 tools │
│                       │ ● slice:P1.1-model-thread… Opus 4.8 (1M context)                   34.3k tok · 17 tools │
│                       │                                                                            │
└───────────────────────┴────────────────────────────────────────────────────────────────────────────┘
↑↓ select · ← detail · x stop workflow · p pause · esc back · s save
```

### State B: structured agent detail

```text
────────────────────────────────────────────────────────────────────────────────────────────────────────────
hardening_slice_and_author                                                       3/8 agents · 1m37s
Slice the workflow-correctness-hardening spec into TDD-ready implementation plans, and author a reusable spec-implementation pipeline workflow

┌ Slice · 7 agents ─────────────────┬ slice:P0.1-journal-keying ─────────────────────────────────────────┐
│ › ● slice:P0.1-journal-keying      │ ● Running · Opus 4.8 (1M context)                                  │
│   ● slice:P0.2-fault-isolation     │ 41.1k tok · 11 tool calls · idle 42s                               │
│   ✓ slice:P0.3-journal-clone       │                                                                    │
│                                    │ Prompt · 17 lines · ↵ expand                                       │
│                                    │   You are designing ONE fix from docs/workflow-correctness-         │
│                                    │   … 15 more lines                                                   │
│                                    │                                                                    │
│                                    │ Activity · last 3 of 11 tool calls                                  │
│                                    │   Bash(grep -n "pipeline\|parallel" /Users/...)                    │
│                                    │   Read(/Users/alexanderopalic/Projects/mypiextension/tests/...)      │
│                                    │                                                                    │
│                                    │ Outcome                                                            │
│                                    │   Still running…                                                    │
└────────────────────────────────────┴────────────────────────────────────────────────────────────────────┘
↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save
```

### State C: prompt reader

```text
┌ Prompt · 17 lines ───────────────────────────────────────────────────────────────────────────────────────┐
│ You are designing ONE fix from docs/workflow-correctness-hardening-spec.md for this repo. Read the spec  │
│ section AND the actual current code in: src/workflow.ts, src/agent.ts, src/prompts/workflow-agent.ts,     │
│ src/prompts/structured-output.ts, src/structured-output.ts. Also read the existing tests under tests/     │
│ exactly. Determine how tests are currently run.                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
• x stop · r restart · p pause · esc back · s save                                      1-4 of 17 ↓
```

### State D: workflow chooser

```text
› /workflows

────────────────────────────────────────────────────────────────────────────────────────────────────────────

  Dynamic workflows
  2 running · 0 completed

  › ↻ hardening_slice_and_author   8 agents · 266.1k tok · 5m 58s
    ↻ generate_joke                4 agents · 0s

  ↑/↓ to select · Enter to view · s to save · Esc to close
```

## Gherkin acceptance criteria

### Feature: `/workflows` monitor routing

```gherkin
Scenario: One active workflow opens directly to overview
  Given exactly one visible workflow run exists
  And the workflow status is running
  When the user runs /workflows
  Then the UI opens the overview monitor
  And no workflow chooser is shown
  And the header shows the workflow name, description, done/total agents, and elapsed time
```

```gherkin
Scenario: Multiple workflows open the chooser
  Given more than one visible workflow run exists
  When the user runs /workflows
  Then the UI opens the workflow chooser
  And the chooser shows running and completed counts
  And the default selection is the newest running workflow
```

```gherkin
Scenario: Zero workflows shows an empty state
  Given no workflow runs exist
  When the user runs /workflows
  Then the UI shows a concise empty state
  And the UI does not show the monitor panes
```

### Feature: Overview monitor

```gherkin
Scenario: Overview renders phases and selected phase agents
  Given a workflow has phases and agents
  When the overview monitor renders
  Then the left pane lists phases
  And the selected phase row has the › cursor
  And the right pane lists only agents for the selected phase
  And each agent row shows status glyph, label, optional model, and optional right-aligned metrics
```

```gherkin
Scenario: Overview phase navigation
  Given the overview monitor is open
  When the user presses Down
  Then the selected phase moves down
  And the right pane updates to that phase's agents
```

```gherkin
Scenario: Overview opens structured detail
  Given the overview monitor is open
  And the selected phase has agents
  When the user presses Left
  Then the UI opens structured agent detail for the selected phase
```

### Feature: Structured agent detail

```gherkin
Scenario: Detail view does not dump the full prompt
  Given structured agent detail is open
  When the selected agent has a long prompt
  Then the detail pane shows a short prompt preview
  And the preview includes a more-lines indicator
  And the full prompt is not dumped by default
```

```gherkin
Scenario: Detail view sections render in the required order
  Given structured agent detail is open
  When the detail pane renders
  Then it shows status and model first
  And it shows metrics second
  And it shows Prompt preview third
  And it shows Activity digest fourth
  And it shows Outcome fifth
```

```gherkin
Scenario: Detail agent navigation
  Given structured agent detail is open
  When the user presses Down
  Then the selected agent moves down
  And the right pane updates to the newly selected agent
```

```gherkin
Scenario: Detail opens prompt reader
  Given structured agent detail is open
  And an agent is selected
  When the user presses Enter
  Then the prompt reader opens for the selected agent's original prompt
```

### Feature: Prompt reader

```gherkin
Scenario: Prompt reader preserves the full prompt
  Given an agent has an original prompt with many lines
  When the prompt reader opens
  Then all prompt lines are available through scrolling
  And no prompt content is lost because of promptPreview truncation
```

```gherkin
Scenario: Prompt reader scrolls
  Given the prompt reader is open
  And the prompt has more lines than fit in the pane
  When the user presses j or Down
  Then the visible prompt window scrolls down
  And the footer scroll indicator updates
```

```gherkin
Scenario: Prompt reader returns to detail
  Given the prompt reader is open
  When the user presses Esc
  Then the UI returns to structured agent detail
```

### Feature: Width safety

```gherkin
Scenario Outline: All screens respect terminal width
  Given the <screen> screen has long workflow names, agent labels, paths, prompts, and tool calls
  When the screen renders at width <width>
  Then every rendered line has visible width less than or equal to <width>
  And no content crosses a pane border

  Examples:
    | screen       | width |
    | chooser      | 42    |
    | overview     | 42    |
    | overview     | 120   |
    | agentDetail  | 42    |
    | agentDetail  | 120   |
    | promptReader | 42    |
    | promptReader | 120   |
```

## Data/read-model requirements

To satisfy the UI without reading full transcripts for the overview:

- `WorkflowRunState` should expose optional `description` from workflow metadata.
- `WorkflowRunState` should expose total token/tool counts already present in the manifest.
- Agent rows may continue to use manifest data for overview and detail summaries.
- State C needs access to the selected agent's full original prompt. A truncated `promptPreview` alone is not enough.
- Activity digest needs recent event/tool summaries when available. If unavailable, render a compact empty state inside the detail pane.

## Implementation notes

- Keep pure projection/navigation in `src/workflows/view/`.
- Keep Pi TUI rendering in `src/extension/tui/`.
- Keep command mode routing in `src/extension/commands/workflows-command.ts`.
- Add reusable layout helpers for:
  - right-aligned header summaries,
  - bordered two-pane layouts,
  - ANSI-safe truncation with `…`,
  - fixed-width padding,
  - token/model/duration formatting.
- The monitor should omit missing fields instead of showing placeholders like `unknown`, `default`, `0`, or `No metrics yet`.

## Test plan

- Add golden-ish render tests for State A, B, C, and D.
- Add navigation tests for chooser → overview → detail → prompt reader → back.
- Add prompt-reader scroll tests for `j/k` and arrow keys.
- Add width-contract tests with `visibleWidth` for narrow and wide widths.
- Keep command tests proving non-TUI print/json fallbacks still work.

## Done means

- `/workflows` visually matches `spec.md` §23 at normal terminal widths.
- The old generic job-browser layout is gone from TUI mode.
- Prompt reader can show the full original prompt.
- All relevant tests pass with `pnpm run check` and `pnpm test`.
