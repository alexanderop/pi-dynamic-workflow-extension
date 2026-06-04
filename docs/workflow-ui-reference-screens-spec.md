---
created: 2026-06-04
implemented: false
---

# Spec: Workflow UI Reference Screens

## Problem

The workflow UI should match the newer native Pi workflow monitor screenshots instead of showing a generic job browser. The monitor needs to feel like a live terminal dashboard:

- one active workflow opens directly into the workflow monitor,
- the first view is a phase/agent overview,
- arrow navigation can switch into a structured agent detail view,
- the detail view shows a compact summary, not the whole prompt/result dump,
- `enter` opens the selected agent's original prompt in a full prompt view,
- when multiple workflows are present/running in the session, `/workflows` starts with a workflow chooser list.

This spec is intentionally visual. The ASCII layouts below are the source of truth for the desired final shape.

## Visual style requirements

- Dark Pi terminal background.
- A thin accent line across the top of the monitor.
- Workflow name in bold accent/lavender.
- Workflow description in muted text directly below the name.
- Right-aligned status summary: `<done>/<total> agents · <elapsed>`.
- Bordered content area with single-line box drawing.
- Muted footer with keyboard shortcuts.
- Use compact glyphs consistently:
  - `›` selected row
  - `✓` done/success
  - `●` pending/running list bullet when spinner is not available
  - `↻` running workflow in chooser
  - `↵` enter/original prompt action
- Long names and prompt lines must truncate with `…`, never wrap through pane borders.
- Every rendered line must respect the TUI `render(width)` width contract.

## State A: one active workflow opens to the overview

When exactly one workflow is active in the session, `/workflows` should skip the workflow chooser and open this monitor directly.

```text
────────────────────────────────────────────────────────────────────────────────────────────────────────────
hardening_slice_and_author                                                       1/8 agents · 1m12s
Slice the workflow-correctness-hardening spec into TDD-ready implementation plans, and author a reusable spec-implementation pipeline workflow

┌ Phases ───────────────┬ Slice · 7 agents ────────────────────────────────────────────────────────────────┐
│ › 1 Slice   0/7       │ ● slice:P0.1-journal-keyi… Opus 4.8 (1M context)                   41.1k tok · 11 tools │
│   ✓ Author 1/1        │ ● slice:P0.2-fault-isolat… Opus 4.8 (1M context)                   33.4k tok · 17 tools │
│                       │ ● slice:P0.3-journal-clone Opus 4.8 (1M context)                   25.2k tok · 11 tools │
│                       │ ● slice:P1.1-model-thread… Opus 4.8 (1M context)                   34.3k tok · 17 tools │
│                       │ ● slice:P1.2-forced-struc… Opus 4.8 (1M context)                   42.2k tok · 20 tools │
│                       │ ● slice:P2.1-drain-on-abo…                                             idle 1m 12s │
│                       │ ● slice:P2.2-limiter-queue Opus 4.8 (1M context)                   29.1k tok · 12 tools │
│                       │                                                                            │
│                       │                                                                            │
│                       │                                                                            │
└───────────────────────┴────────────────────────────────────────────────────────────────────────────┘
↑↓ select · ← detail · x stop workflow · p pause · esc back · s save
```

### Overview behavior

- Left pane lists workflow phases.
- Right pane lists agents for the selected phase.
- The selected phase row owns the `›` cursor.
- Agent rows show, in order:
  1. status glyph,
  2. agent label,
  3. model/context when available,
  4. right-aligned token/tool metrics or idle duration.
- If no model/token/tool data exists, omit those fields rather than showing placeholders.
- `↑/↓` selects the phase in the left pane.
- `←` switches into the selected phase's agent detail view.
- `esc` returns to chat/previous Pi screen.

## State B: arrow-left switches to structured agent detail

From the overview, pressing `←` opens the selected phase's agent-focused view. This is not a raw dump. It is structured into list + detail panes.

```text
────────────────────────────────────────────────────────────────────────────────────────────────────────────
hardening_slice_and_author                                                       3/8 agents · 1m37s
Slice the workflow-correctness-hardening spec into TDD-ready implementation plans, and author a reusable spec-implementation pipeline workflow

┌ Slice · 7 agents ─────────────────┬ slice:P0.1-journal-keying ─────────────────────────────────────────┐
│ › ● slice:P0.1-journal-keying      │ ● Running · Opus 4.8 (1M context)                                  │
│   ● slice:P0.2-fault-isolation     │ 41.1k tok · 11 tool calls · idle 42s                               │
│   ✓ slice:P0.3-journal-clone       │                                                                    │
│   ✓ slice:P1.1-model-threading     │ Prompt · 17 lines · ↵ expand                                       │
│   ● slice:P1.2-forced-structu…     │   You are designing ONE fix from docs/workflow-correctness-         │
│   ● slice:P2.1-drain-on-abort      │   hardening-spec.md for this repo. Read the spec section AND        │
│   ● slice:P2.2-limiter-queue       │   … 15 more lines                                                   │
│                                    │                                                                    │
│                                    │ Activity · last 3 of 11 tool calls                                  │
│                                    │   Bash(grep -n "pipeline\|parallel" /Users/...)                    │
│                                    │   Read(/Users/alexanderopalic/Projects/mypiextension/tests/...)      │
│                                    │   Bash(cat > /tmp/repro.test.ts <<'EOF' import assert from "node:a…) │
│                                    │                                                                    │
│                                    │ Outcome                                                            │
│                                    │   Still running…                                                    │
└────────────────────────────────────┴────────────────────────────────────────────────────────────────────┘
↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save
```

### Structured detail behavior

- Left pane lists agents in the selected phase.
- Right pane title is the selected agent label.
- Detail pane sections must appear in this order:
  1. status/model line,
  2. metrics line,
  3. `Prompt` preview,
  4. `Activity` digest,
  5. `Outcome` preview.
- Prompt preview shows a small number of lines, then `… N more lines`.
- Activity shows only recent calls/events, e.g. last 3, with a count in the heading.
- Outcome is short and stateful: `Still running…`, result preview, error summary, or cancellation summary.
- `↑/↓` moves selected agent.
- `→` returns to the overview.
- `enter`/`↵` opens the original prompt view for the selected agent.
- `r restart`, `p pause`, and agent-level stop may be disabled until runtime support exists, but the UI contract should reserve these keys and footer slots.

## State C: enter opens the original prompt view

Pressing `enter` in the structured detail view opens a prompt-focused view for the selected agent. This view is allowed to show the original prompt text in full, with scrolling.

```text
┌ Prompt · 17 lines ───────────────────────────────────────────────────────────────────────────────────────┐
│ You are designing ONE fix from docs/workflow-correctness-hardening-spec.md for this repo. Read the spec  │
│ section AND the actual current code in: src/workflow.ts, src/agent.ts, src/prompts/workflow-agent.ts,     │
│ src/prompts/structured-output.ts, src/structured-output.ts. Also read the existing tests under tests/     │
│ (especially tests/workflow-journal.test.ts) and vitest.config.ts to match the test style and import paths │
│ exactly. Determine how tests are currently run.                                                          │
│                                                                                                          │
│ Produce a TDD-ready plan: (1) a complete failing test (RED) written in the repo's exact test style/imports│
│ that fails against CURRENT code and will pass after the fix, and (2) the precise implementation edits     │
│ (GREEN). Do NOT edit any files — design only. Quote real function names and line anchors. Be concrete     │
│ enough that an implementer can apply it without re-deriving anything.                                    │
│                                                                                                          │
│ FINDING P0.1 - Journal replay is non-deterministic under pipeline()/concurrency. The hash chain threads  │
│ a mutable global previousJournalKey synchronously at agent() call time, so concurrent re-runs change call │
│ ordering.                                                                                                │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
• x stop · r restart · p pause · esc back · s save                                      1-15 of 29 ↓
```

### Original prompt behavior

- This is a focused prompt reader, not the default detail pane.
- It shows all prompt lines through scrolling.
- Footer includes a right-aligned scroll indicator: `<first>-<last> of <total> ↓`.
- `j/k` and `↑/↓` scroll when inside this view.
- `esc` returns to the structured agent detail view.
- No prompt text should be lost; wrapping/truncation should preserve readability while respecting width.

## State D: multiple workflows use a chooser first

When more than one workflow exists in the current session, and especially when two or more workflows are running, `/workflows` should first show a chooser/list screen. Selecting a workflow with `enter` opens State A or State B for that workflow.

```text
› /workflows

────────────────────────────────────────────────────────────────────────────────────────────────────────────

  Dynamic workflows
  2 running · 0 completed

  › ↻ hardening_slice_and_author   8 agents · 266.1k tok · 5m 58s
    ↻ generate_joke                4 agents · 0s

  ↑/↓ to select · Enter to view · s to save · Esc to close
```

If the session has one running and one completed workflow, the same chooser shape applies with the accurate counts:

```text
  Dynamic workflows
  1 running · 1 completed

  › ✓ generate_joke                4 agents · 0s
    ↻ hardening_slice_and_author   8 agents · 266.1k tok · 5m 58s
```

### Chooser behavior

- Use the `/workflows` command line header style shown above.
- Show aggregate counts on the second line: `<running> running · <completed> completed`.
- Rows show:
  1. selection cursor,
  2. status glyph,
  3. workflow name,
  4. agent count,
  5. token total when available,
  6. elapsed duration.
- Default selection should prefer the newest running workflow.
- `↑/↓` changes selected workflow.
- `enter` opens the selected workflow monitor.
- `s` saves the selected workflow.
- `esc` closes the chooser.

## Navigation summary

```text
/workflows
  ├─ if 0 workflows: empty state
  ├─ if 1 active workflow: open State A directly
  └─ if multiple workflows in session: open State D chooser

State A overview
  ↑/↓ select phase
  ←   open State B structured agent detail
  esc close/back

State B structured agent detail
  ↑/↓ select agent
  →   return to State A overview
  ↵   open State C original prompt
  esc return/back

State C original prompt
  ↑/↓ or j/k scroll prompt
  esc return to State B
```

## Acceptance criteria

- `/workflows` with one active workflow opens directly to the overview monitor.
- The overview monitor matches State A: header, description, phases pane, agent pane, metrics, border, and footer.
- Arrow navigation can switch from overview to structured agent detail.
- Agent detail matches State B and never dumps the full prompt by default.
- `enter` opens a full original prompt reader matching State C.
- Multiple workflows in the session open a chooser matching State D before showing a monitor.
- All views preserve the line-width contract from Pi TUI components.
- Long labels, prompts, paths, and tool calls truncate or wrap inside their pane; they never break borders.
- Existing workflow lifecycle behavior is unchanged by this UI spec.

## Non-goals

- Implement runtime pause/restart/agent-stop if the workflow manager does not yet support them.
- Change workflow execution semantics.
- Change persisted workflow snapshot format unless required to expose data already shown in these screens.
- Add mouse support.
