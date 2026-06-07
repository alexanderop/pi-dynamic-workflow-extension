# Workflow Plans — Status Ledger

Single source of truth for "what's implemented / what's next." This replaces
the old backlog and project status docs.

Status verified against `src/` and `test/` on 2026-06-07. Re-verify a row
against code before trusting it; drift is the failure mode this ledger exists
to prevent.

## Next Up

| # | Project | Status | The remaining gap | Spec |
|---|---|---|---|---|
| 1 | [test-page-objects](./workflows/test-page-objects/) | partial | `restartAgent` screen actions + spies, saved-workflow-scenario, journal assertions | [spec](./workflows/test-page-objects/spec.md) |
| 2 | [live-feedback](./workflows/live-feedback/) | partial | honest no-telemetry labels, phase/agent display dedupe, fake-runner live event plumbing, and Pi `AgentSession.subscribe()` adapter landed; remaining: throttled persistence and detail activity timeline | [spec](./workflows/live-feedback/spec.md) |
| 3 | [workflows-monitor](./workflows/workflows-monitor/) | in progress | spec §24 four-state TUI rebuild | [plan](./workflows/workflows-monitor/plan.md) · [ticket](./workflows/workflows-monitor/ticket.md) |
| 4 | [saved-workflow-scopes](./workflows/saved-workflow-scopes/) | **blocked** | re-introduce user scope — **requires revisiting ADR 0009** (commit `51e10ce7` deliberately dropped it) | [spec](./workflows/saved-workflow-scopes/spec.md) |

## Ongoing Infra Work

These are agent-ready chunks that can be picked up alongside the numbered
projects above.

- [structured-output-retry](./workflows/structured-output-retry/) — bounded two-nudge correction loop for structured output.
- [atomic-manifest-writes](./workflows/atomic-manifest-writes/) — single-writer / CAS policy for `manifest.json`.
- [sidechain-transcripts](./workflows/sidechain-transcripts/spec.md) — Pi-native sidechain session persistence and raw transcript replay; keep overview/detail manifest-only.
- [align-with-pi](./workflows/align-with-pi/) — pi-author convention alignment workstreams (W1-W6).

## Done

- **feature-flags** — feature flag registry/resolver, `/workflows features`, user/project/session/env/CLI controls, manifest persistence, and default-off `experimental-model-routing` model inheritance are implemented and covered by tests. Spec remains in [workflows/feature-flags/spec.md](./workflows/feature-flags/spec.md).
- **agent-mock-boundary** — MSW-style fake-agent fixture now includes
  `setupDefaultAgentTestServer(...)` for shared default mocks and
  `agents.boundary(...)` scoped runtime overrides with nested and concurrent
  boundary coverage. Spec remains in
  [workflows/agent-mock-boundary/spec.md](./workflows/agent-mock-boundary/spec.md).
- **ultracode-trigger-and-real-agent** — trigger detection, model-facing launch
  tool, and real Pi subagent runner are wired and tested. The archived planning
  spec was removed when docs moved under `brain/`; the remaining follow-up is
  per-agent transcript persistence, tracked as infra work.

## How To Use This Folder

- Each workflow project is a folder under `brain/plans/workflows/` holding its
  `spec.md`, `plan.md`, or `chunk.md`.
- When behavior lands, update [spec-coverage.md](../contracts/spec-coverage.md)
  alongside this ledger.
