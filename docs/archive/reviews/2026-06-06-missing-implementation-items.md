# Missing Implementation Items from 2026-06-06 Audits

Status: audit snapshot — re-verify against current code before marking any item done.

## Source and scope

This file extracts implementation follow-ups from two 2026-06-06 reviews:

- [`docs/archive/reviews/2026-06-06-in-depth-review.md`](./2026-06-06-in-depth-review.md) — in-depth source review with Pi source cross-reference.
- Workflow audit `wf_ae207822a33d02a0` — full output at `/Users/alexanderopalic/Projects/.pi/workflows/wf_ae207822a33d02a0/output.json`.

This is an actionable triage/checklist document. It does **not** replace:

- [`spec.md`](../../../spec.md) — current workflow behavior specification.
- [`docs/archive/backlog.md`](../backlog.md) — canonical implementation backlog.
- [`docs/areas/spec-coverage.md`](../../areas/spec-coverage.md) — spec-to-code ownership map.
- [`docs/projects/`](../../projects/) — agent-ready implementation chunks now live inside their owning project folders (see the [status ledger](../../projects/README.md)).
- [`docs/areas/adr/`](../../areas/adr) — durable implementation decisions.

## Priority summary

| Severity | Area | Item | Recommended disposition | Likely owners | References | Status |
|---|---|---|---|---|---|---|
| Critical | Runtime/security | `node:vm` sandbox is escapable and over-claimed | Decide trust-boundary ADR/update, then either harden or document non-sandbox status | `src/workflows/script/runtime.ts`, `docs/areas/adr/*`, `spec.md` | Review §1, spec §20 | Open |
| High | Runtime contract | Missing child `workflow(nameOrRef, args)` global | Implement shared scheduler/budget child execution and one-level nesting guard | `src/workflows/script/runtime.ts`, `src/workflows/launch/launcher.ts`, `src/workflows/saved/resolver.ts` | spec §7, backlog 5.3, chunk 002 | Open |
| High | Agent isolation | `isolation: "worktree"` is advertised but no-op | Implement git worktree setup/cleanup or remove from prompts/docs until supported | `src/workflows/agent/pi-runner.ts`, script model/prompts/docs | spec §7/§9, backlog 7.3 | Open |
| High | Structured output | Missing bounded two-nudge correction loop | Implement missing/invalid/schema-mismatch nudges and failure behavior | `src/workflows/agent/pi-runner.ts`, `src/workflows/agent/structured-output-tool.ts` | spec §9/§17, ADR 0014, backlog 7.2, chunk 001 | Partial |
| High | Transcripts | Per-agent transcript/meta artifacts are not written into run transcripts dir | Define and persist `agent-*.jsonl` and `agent-*.meta.json` | `src/workflows/agent/pi-runner.ts`, run storage | spec §9/§18 | Open |
| High | Restart | Restart-agent invalidation is not wired controller → TUI | Add controller method, append invalidation, rerun via replay, wire UI | `src/workflows/run/controller.ts`, journal, TUI | spec §16, backlog 4.3 | Partial |
| High | Persistence | `manifest.json` has competing writers / possible clobbering | Add single-writer or CAS/revision policy | `src/workflows/run/store.ts`, launcher/controller/status updates | Review §top priorities | Open |
| High | Agent failures | Pi sidechain errors can be swallowed or lose real cause | Inspect terminal `stopReason`/`errorMessage`; propagate true error | `src/workflows/agent/pi-runner.ts` | Review §2 | Open |
| High | Ultracode | Ultracode policy lacks primary launch-tool actuator | Register model-facing launch tool and wire `launchUltracodeWorkflow` into primary input path | `src/extension/ultracode/*`, extension entrypoint | spec §19 | Partial |
| High | Budget | `budget.total` hard ceiling / real usage accounting incomplete | Enforce before scheduling; later integrate actual Pi token/tool telemetry | `src/workflows/script/runtime.ts`, Pi runner telemetry | spec §7/§21, backlog 8.1 | Partial |
| Medium | Runtime contract | `parallel()`/`pipeline()` fan-out cap missing or needs verification | Enforce 4096 cap per call with tests | `src/workflows/script/runtime.ts` | spec §7/§21 | Open/verify |
| Medium | Runtime contract | `pipeline()` first stage should receive item as previous value | Seed `previous` with `item` and test | `src/workflows/script/runtime.ts` | spec §11/§21 | Open/verify |
| Medium | Runtime cancellation | `vm` timeout only bounds sync code and may mislead | Remove or document; rely on abort signal | `src/workflows/script/runtime.ts` | Review §1 | Open |
| Medium | UI/controller | Save action exists as helper but not wired through `/workflows` UI/controller | Add callbacks, prompts, confirmation, tests | `src/workflows/saved/save-run-script.ts`, controller/TUI | spec §15/§16 | Partial |
| Medium | Phases | Phase metadata validation and `phaseIndex` assignment missing | Validate against `meta.phases`; assign indexes | parser/runtime/scheduler/run model | spec §6/§12 | Open |
| Medium | Resume/journal | Resume preconditions and journal tolerance incomplete | Enforce same-session/stopped preconditions; ignore one partial trailing line; audit cache hits | launcher/journal/store | spec §13/§14, backlog 8.2, chunk 003 | Partial |
| Medium | Agent policy | `agentType` is metadata only; no Pi mapping decision | Add ADR and implement chosen mapping or document non-mapping | Pi runner, extension docs, ADR | spec §9/open questions | Open |
| Medium | Pi integration | Host model/modelRegistry and rich progress/usage not plumbed | Reuse host Pi context where available; harvest token/tool progress | `src/extension/ultracode/*`, `src/workflows/agent/pi-runner.ts` | Review §2, spec §17 | Open |
| Medium | Notifications | Notifications lack tool-use id and ultracode continuation instruction | Thread tool-use id; add continuation wrapper for ultracode-triggered runs | launcher, notification adapter, ultracode | spec §17/§19 | Partial |
| Medium | View | Hand-rolled ANSI wrapping/truncation duplicates/corrupts styled text | Reuse Pi TUI helpers (`wrapTextWithAnsi`, truncation helpers) | `src/workflows/view/*`, TUI adapter | Review §top priorities | Open |
| Medium | Lifecycle | Runner abort/dispose and extension cleanup need hardening | Await abort before dispose; clean status/pollers/session resources | Pi runner, statusline/extension lifecycle | Review §2/Pi integration | Open |
| Medium | Validation | Run id/path validation and manifest ownership should be hardened | Validate identifiers and paths before file access | run store/controller/commands | Review correctness/safety | Open |
| Medium | Docs | User-facing docs/prompts over-advertise planned behavior | Split Current/Planned/Deferred, update prompts and keymaps | README, AGENTS, backlog, spec coverage, prompts | Audit gap | Open |
| Low | Quality gates | Documented lint/format scope mismatches package scripts | Update scripts or docs | `package.json`, `AGENTS.md` | Audit gap | Open |
| Low | Smoke tests | No live Pi/model smoke coverage | Add optional/manual smoke plan after mocked tests are stable | docs/testing, scripts/manual checks | Audit gap | Open |

## Contract gaps vs `spec.md`

These items are direct divergences from the current specification and should either be implemented or the spec should be deliberately revised.

### Child `workflow()`

- **Expected:** `workflow(nameOrRef, args)` runs a saved/script-path child workflow inline, shares parent concurrency cap, total-agent counter, abort signal, and token budget, and throws when nested more than one level deep.
- **Observed gap:** Runtime does not expose a `workflow` global.
- **Disposition:** Implement. Existing chunk: [`docs/projects/child-workflow-global/chunk.md`](../../projects/child-workflow-global/chunk.md).

### Budget enforcement and telemetry

- **Expected:** `budget.total` is a hard ceiling; `agent()` throws once spent tokens reach total. Notifications include meaningful token/tool usage.
- **Observed gap:** Local token estimates exist, but enforcement/real Pi usage plumbing are incomplete or require re-verification.
- **Disposition:** Enforce local hard ceiling first; then add real usage telemetry when Pi APIs make it available.

### Fan-out caps for `parallel()` and `pipeline()`

- **Expected:** one `parallel()` or `pipeline()` call accepts at most 4096 items.
- **Observed gap:** In-depth review found no cap.
- **Disposition:** Add shared `MAX_FAN_OUT = 4096` guard and tests.

### Structured-output retry policy

- **Expected:** schema agents must validate structured output; missing/invalid output gets bounded correction nudges; final failure rejects and is surfaced.
- **Observed gap:** terminating tool capture foundation exists, but the two-nudge correction loop is incomplete.
- **Disposition:** Implement ADR 0014. Existing chunk: [`docs/projects/structured-output-retry/chunk.md`](../../projects/structured-output-retry/chunk.md).

### Worktree isolation

- **Expected:** `agent({ isolation: "worktree" })` runs subagents in fresh git worktrees with cleanup policy.
- **Observed gap:** Option is documented/advertised, but the runner does not create worktrees.
- **Disposition:** Either implement with explicit preservation/cleanup policy, or remove/defer the advertised option.

### Phase validation

- **Expected:** `meta.phases[].title` matches calls to `phase(title)` and `agent({ phase })`; run state can carry `phaseIndex`.
- **Observed gap:** Runtime accepts arbitrary phase titles and may not assign indexes.
- **Disposition:** Validate at runtime/launch and add negative tests.

### Agent type and model policy

- **Expected:** subagents receive selected `agentType` and model/default model in a predictable way.
- **Observed gap:** `agentType` appears to be progress/prompt metadata only; mapping to Pi specialized-agent behavior lacks an ADR. Host `model`/`modelRegistry` plumbing may also be incomplete.
- **Disposition:** Add ADR before changing behavior.

## Correctness and safety gaps

### Sandbox honesty / isolation decision

`node:vm` should not be described as a security boundary if scripts can escape through constructors. Decide whether workflow scripts are trusted extension code or lower-trust model-authored code:

- **Trusted path:** document Pi-style trust boundary and stop promising filesystem/shell isolation from the runtime itself.
- **Hardened path:** move to a real isolate/process boundary and add escape regression tests.

This decision should update `spec.md`, runtime tests, and an ADR.

### Manifest write ownership

Pause/stop/controller writes and live progress persistence should not race. Choose one:

- single writer owns all `manifest.json` writes, or
- compare-and-swap / monotonic revision prevents stale writes from clobbering user control actions.

### Subagent terminal error propagation

Pi sessions can finish with terminal assistant entries carrying `stopReason`/`errorMessage`. The runner should inspect the last message first and surface auth/rate-limit/abort causes instead of returning empty text or generic failures.

### Restart and journal invalidation

Pure state-machine/journal concepts exist, but end-to-end restart needs controller/TUI wiring and replay semantics that ignore invalidated cached results without deleting old transcript history.

### Resume and journal durability

Journal replay should tolerate one partial trailing JSONL line from interrupted writes, reject unsafe resume contexts, and leave auditable evidence when cache hits are reused.

### Run id and path validation

Controller/command/store entrypoints should validate run ids and avoid path traversal or ambiguous file access before reading/writing run artifacts.

## Pi integration gaps

### Ultracode launch actuator

The policy tells the main agent to launch workflows, but the primary model-facing actuator must be registered and wired to `launchUltracodeWorkflow`. Notifications should use Pi continuation behavior for ultracode-launched runs.

### Host model and registry reuse

Live subagents should reuse host model/model-registry context when possible instead of re-resolving from disk per subagent.

### Pi TUI helper reuse

Replace local ANSI wrapping/truncation helpers that corrupt styled text with Pi-provided helpers where available.

### Lifecycle cleanup

Await asynchronous aborts before dispose, clear footer status/pollers reliably, and test extension/session shutdown paths.

### Usage and progress telemetry

Harvest token counts, tool-call counts, last tool name/summary, and recent activity from Pi sessions when APIs expose it, then propagate to manifests and notifications.

## Quick wins vs design-decision work

### Quick wins

- Update README/prompts/keymaps to stop advertising unimplemented `worktree`, save, restart, and structured-output retry behavior as complete.
- Add 4096 fan-out guards and tests.
- Fix `pipeline()` first-stage previous value if still incorrect.
- Improve subagent terminal error extraction from Pi session messages.
- Await `session.abort()` before `dispose()`.
- Add journal partial-tail tolerance tests.
- Correct AGENTS/package script lint/format scope mismatch.

### Requires ADR or spec clarification

- Sandbox trust boundary vs real isolation.
- Worktree preservation/cleanup policy.
- `agentType` → Pi behavior mapping.
- Manifest single-writer vs CAS/revision persistence policy.
- Save-run availability semantics for non-completed runs.
- Exact live Pi transcript ownership/copying behavior.
- Real token/tool usage accounting source of truth.

## Chunk candidates

Existing chunks that already cover part of this list:

- [`001-structured-output-retry-adr.md`](../../projects/structured-output-retry/chunk.md) — structured-output retry policy.
- [`002-child-workflow-runtime.md`](../../projects/child-workflow-global/chunk.md) — child `workflow()` runtime.
- [`003-atomic-manifest-writes.md`](../../projects/atomic-manifest-writes/chunk.md) — atomic manifest persistence.

Good new chunk candidates:

1. `004-sandbox-trust-boundary.md` — choose/document/harden sandbox strategy.
2. `005-worktree-isolation.md` — implement or explicitly defer `isolation: "worktree"`.
3. `006-agent-transcript-artifacts.md` — persist per-agent transcript/meta files in run directory.
4. `007-restart-agent-controller-ui.md` — controller and TUI restart invalidation flow.
5. `008-save-workflow-ui-action.md` — save action from `/workflows` UI/controller.
6. `009-budget-and-usage-accounting.md` — hard ceiling plus telemetry plan.
7. `010-agenttype-pi-mapping-adr.md` — ADR and tests for agent type/model policy.
8. `011-ultracode-launch-tool-and-notification.md` — model-facing launch actuator and continuation notification.
9. `012-pi-runner-failure-lifecycle.md` — terminal error propagation and abort/dispose cleanup.
10. `013-phase-validation.md` — metadata phase validation and `phaseIndex` assignment.

## Update protocol

When an item is implemented or deliberately deferred:

1. Re-verify against current code and tests.
2. Update this file's table status (`Open`, `Partial`, `Implemented`, `Deferred`) with a short evidence note if useful.
3. Update [`docs/archive/backlog.md`](../backlog.md) slice status and next bounded step.
4. Update [`docs/areas/spec-coverage.md`](../../areas/spec-coverage.md) owner/status/gap row.
5. Update [`spec.md`](../../../spec.md) if behavior or reverse-engineered understanding changed.
6. Add or update an ADR for durable policy decisions.
7. Prefer `pnpm run verify` before marking implementation complete.
