# Active Projects — Status Ledger

Single source of truth for "what's implemented / what's next." This supersedes
the old `backlog.md`, the status column of `spec-coverage.md`, and the
`reviews/` triage docs (all now in [`../archive/`](../archive/)).

Status verified against `src/` and `test/` on 2026-06-07. Re-verify a row
against code before trusting it — drift is the failure mode this ledger exists
to prevent.

## Next up (priority order)

| # | Project | Status | The remaining gap | Spec |
|---|---|---|---|---|
| 1 | [agent-mock-boundary](./agent-mock-boundary/)       | ~95%        | `agents.boundary()` scoped runtime override (everything else implemented) | [spec](./agent-mock-boundary/spec.md) |
| 2 | [child-workflow-global](./child-workflow-global/)   | partial     | runtime global `workflow(nameOrRef, args?)` — parity item 13 (items 1–12, 14–18 done) | [spec](./child-workflow-global/spec.md) |
| 3 | [test-page-objects](./test-page-objects/)           | partial     | `saveRun`/`restartAgent` screen actions + spies, saved-workflow-scenario, journal assertions | [spec](./test-page-objects/spec.md) |
| 4 | [live-feedback](./live-feedback/)                   | not started | live per-agent activity states (queued/thinking/using-tool/…) wired scheduler → projector → TUI | [spec](./live-feedback/spec.md) |
| 5 | [workflows-monitor](./workflows-monitor/)           | in progress | spec §24 four-state TUI rebuild | [plan](./workflows-monitor/plan.md) · [ticket](./workflows-monitor/ticket.md) |
| 6 | [saved-workflow-scopes](./saved-workflow-scopes/)   | **blocked** | re-introduce user scope — **requires revisiting ADR 0009** (commit `51e10ce7` deliberately dropped it) | [spec](./saved-workflow-scopes/spec.md) |

## Ongoing infra work (no single finish line)

These are agent-ready chunks pulled from the old backlog; pick them up alongside
the numbered projects above.

- [structured-output-retry](./structured-output-retry/) — bounded two-nudge correction loop for structured output.
- [atomic-manifest-writes](./atomic-manifest-writes/) — single-writer / CAS policy for `manifest.json`.
- [align-with-pi](./align-with-pi/) — pi-author convention alignment workstreams (W1–W6).

## Done → archived

- **ultracode-trigger-and-real-agent** — trigger detection, model-facing launch
  tool, and real Pi subagent runner are wired and tested. Spec lives in
  [`../archive/ultracode-trigger-and-real-agent-spec.md`](../archive/ultracode-trigger-and-real-agent-spec.md).
  (Only follow-up: per-agent transcript persistence, tracked as infra work.)

## How to use this folder

- Each project is a folder holding its `spec.md` / `plan.md` / `chunk.md`.
- When you finish a project: move its folder to `../archive/` and change its row
  here to a "Done → archived" bullet.
- When behavior lands, also update [`../areas/spec-coverage.md`](../areas/spec-coverage.md)
  (the spec.md → code map) — that's the living contract; this is the to-do list.
