---
title: Workflow Plans Status Ledger
status: active
priority: P0
last_audited: 2026-06-07
implementation: "Audit ledger for workflow plan implementation state and priority order."
next: "Update this file whenever a plan frontmatter status changes."
---

# Workflow Plans — Status Ledger

Single source of truth for "what's implemented / what's next." This replaces
the old backlog and project status docs.

Status verified against `src/` and `test/` on 2026-06-07. Re-verify a row
against code before trusting it; drift is the failure mode this ledger exists
to prevent.

## Priority Order

| Priority | Project | Status | Implemented audit | Next action | Spec |
|---|---|---|---|---|---|
| P0 | [root workflow spec](../../spec.md) | partial | Core runtime, saved workflows, journal resume, notifications, feature flags, structured output retry, and monitor foundations exist. | Use this ledger plus [spec-coverage](../contracts/spec-coverage.md) to choose the next slice. | [spec](../../spec.md) |
| P1 | [saved-workflow-slash-commands](./workflows/saved-workflow-slash-commands/) | implemented | `src/extension/commands/saved-workflow-commands.ts` registers a generic `/workflow <name> [args]` command and, on `session_start`, direct `/<meta.name>` commands for command-safe saved workflows; `/workflows` save registers the command and reports registered/skipped status. | Optional: surface skipped-registration diagnostics in `/workflows`; revisit completions when Pi gives `getArgumentCompletions` a ctx. | [spec](./workflows/saved-workflow-slash-commands/spec.md) |
| P1 | [test-page-objects](./workflows/test-page-objects/) | partial | Builders, `workflowScenario` (+ `scenario.journal`), `workflowsCommandPage`, `workflowsScreen` (+ save-run), `savedWorkflowScenario`, `journal-assertions`, and their page-object tests exist. No production restart-agent TUI callback, so `restartAgent` is intentionally unwired. | Slice 6: opportunistically migrate remaining noisy launcher/component tests onto the harnesses. | [spec](./workflows/test-page-objects/spec.md) |
| P2 | [live-feedback](./workflows/live-feedback/) | partial | Honest no-telemetry labels, phase/agent display dedupe, fake-runner live event plumbing, and Pi `AgentSession.subscribe()` mapping exist. | Add throttled live manifest persistence and a detail activity timeline. | [spec](./workflows/live-feedback/spec.md) |
| P2 | [workflows-monitor](./workflows/workflows-monitor/) | partial | Projection, layout, navigation, command page objects, TUI adapter tests, save-run, and stopped-run resume affordance exist. | Finish the spec §24 four-state monitor rebuild. | [plan](./workflows/workflows-monitor/plan.md) · [ticket](./workflows/workflows-monitor/ticket.md) |
| P3 | [sidechain-transcripts](./workflows/sidechain-transcripts/) | proposed | ADR 0018 is proposed; runner still uses in-memory Pi sessions. | Persist Pi-native sidechain sessions and add raw transcript drill-down. | [spec](./workflows/sidechain-transcripts/spec.md) |
| P4 | [atomic-manifest-writes](./workflows/atomic-manifest-writes/) | partial | Manifest writes are atomic via temp-file and rename. | Make journal replay tolerate partial trailing JSONL fragments and cover it with filesystem tests. | [chunk](./workflows/atomic-manifest-writes/chunk.md) |
| P5 | [flue-harness-improvements](./workflows/flue-harness-improvements/) | proposed | Not implemented beyond the completed structured-output retry sibling project. | Pick W1-W6 slices after higher-priority monitor, live-feedback, and persistence gaps. | [spec](./workflows/flue-harness-improvements/spec.md) |
| P6 | [structured-output-retry](./workflows/structured-output-retry/) | implemented | `structured_output`/`give_up`, two-nudge retry, schema envelopes, live retry events, and journal safety are implemented and tested. | No active work. | [spec](./workflows/structured-output-retry/spec.md) · [chunk](./workflows/structured-output-retry/chunk.md) |
| P6 | [feature-flags](./workflows/feature-flags/) | implemented | Registry/resolver, `/workflows features`, user/project/session/env/CLI controls, manifest persistence, and default-off model inheritance are implemented. | No active gap beyond the known Pi explicit-CLI-false limitation. | [spec](./workflows/feature-flags/spec.md) |
| P6 | [agent-mock-boundary](./workflows/agent-mock-boundary/) | implemented | `setupDefaultAgentTestServer(...)` and scoped `agents.boundary(...)` runtime overrides are implemented and covered. | No active work. | [spec](./workflows/agent-mock-boundary/spec.md) |
| P7 | [align-with-pi](./workflows/align-with-pi/) | partial | W1 (docs/process), W2 (parser `any` removal), W3 (dotted-infix test renames), and the W5 harness kernel (`test/suite/` tmpdir helper + `FakePiSession` lift) are done. | Continue W4 (domain-encode source filenames) and W6 (TUI color extraction) only when convention alignment becomes active. | [plan](./workflows/align-with-pi/plan.md) |
| P8 | [saved-workflow-scopes](./workflows/saved-workflow-scopes/) | blocked | Not implemented; ADR 0009 intentionally keeps saved workflows project/workspace-local only. | Revisit ADR 0009 before adding user-home saved workflow scope. | [spec](./workflows/saved-workflow-scopes/spec.md) |

## Ongoing Infra Work

These are agent-ready chunks that can be picked up alongside the priority table
above.

- [atomic-manifest-writes](./workflows/atomic-manifest-writes/) — finish partial-trailing-line journal recovery.
- [sidechain-transcripts](./workflows/sidechain-transcripts/spec.md) — Pi-native sidechain session persistence and raw transcript replay; keep overview/detail manifest-only.
- [align-with-pi](./workflows/align-with-pi/) — pi-author convention alignment workstreams W4 and W6 (W1-W3 and the W5 harness kernel are done).

## Done

- **readability-review-2026-06-09** — all five themes landed (god-file splits with ADR 0019, shared `guards.ts` dedup, const-array union guards with an inverted restart transition, module role headers, and the camp-site cleanups); behavior-preserving, suite green. Checked-off review remains in [readability-review-2026-06-09.md](./readability-review-2026-06-09.md).
- **structured-output-retry** — Flue-inspired `structured_output`/`give_up` bundle, two-nudge same-session retry loop, retry live events, schema-failure journal safety, and non-object schema envelopes are implemented and covered by fake Pi-session tests. Spec remains in [workflows/structured-output-retry/spec.md](./workflows/structured-output-retry/spec.md).
- **feature-flags** — feature flag registry/resolver, `/workflows features`, user/project/session/env/CLI controls, manifest persistence, and default-off `experimental-model-routing` model inheritance are implemented and covered by tests. Spec remains in [workflows/feature-flags/spec.md](./workflows/feature-flags/spec.md).
- **agent-mock-boundary** — MSW-style fake-agent fixture now includes `setupDefaultAgentTestServer(...)` for shared default mocks and `agents.boundary(...)` scoped runtime overrides with nested and concurrent boundary coverage. Spec remains in [workflows/agent-mock-boundary/spec.md](./workflows/agent-mock-boundary/spec.md).
- **ultracode-trigger-and-real-agent** — trigger detection, model-facing launch
  tool, and real Pi subagent runner are wired and tested. The archived planning
  spec was removed when docs moved under `brain/`; the remaining follow-up is
  per-agent transcript persistence, tracked as infra work.

## How To Use This Folder

- Each workflow project is a folder under `brain/plans/workflows/` holding its
  `spec.md`, `plan.md`, or `chunk.md`.
- When behavior lands, update [spec-coverage.md](../contracts/spec-coverage.md)
  alongside this ledger.
