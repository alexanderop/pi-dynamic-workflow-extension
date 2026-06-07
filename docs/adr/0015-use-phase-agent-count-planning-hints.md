# ADR 0015: Use Phase Planning Hints

Status: accepted

## Context

The `/workflows` monitor can render actual agent labels only after the workflow script has queued `agent()` calls. During early execution, a phase may have a known planned fan-out even though the individual agent rows do not exist yet. Showing `0/0` makes the phase look empty and hides useful progress context.

Static inference from arbitrary workflow JavaScript is not reliable because loops, `pipeline()` stages, and result-dependent fan-out can change the number of future agents.

## Decision

Allow workflow scripts to declare optional planning metadata on each `meta.phases[]` entry when the phase fan-out is known up front:

- `detail`: short human explanation of the phase.
- `model`: planned/default model for the phase.
- `agentCount`: non-negative integer planned total.
- `agents`: planned agent rows with `{ label, model?, agentType? }`.

The launcher persists these hints in the run manifest. The `/workflows` monitor uses the larger of the planned count, planned agent rows, and actual queued agent rows for phase totals. It still distinguishes real runtime agent rows from planned placeholders; matching labels disappear from placeholders once the real agent row is queued.

## Consequences

- The TUI can show phase totals such as `0/6`, phase details, planned models, and known agent labels before runtime rows exist.
- Workflow authors and ultracode prompts should include planning hints for fixed fan-out phases and omit them for open-ended or result-dependent phases.
- This is a Pi extension metadata hint, not an observed Claude Code field.
- We avoid brittle static JavaScript analysis and keep the manifest as the cheap read model for `/workflows`.
