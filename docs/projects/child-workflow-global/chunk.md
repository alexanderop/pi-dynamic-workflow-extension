# Chunk: Child Workflow Runtime

## Goal

Implement the runtime `workflow(nameOrRef, args)` global so a workflow can run one child workflow inline and receive its return value. The child must reuse the parent run context for scheduler, total-agent counter, abort signal, and budget, and must reject attempts to nest deeper than one child level.

## Non-goals

- Do not introduce a separate child run id, child manifest, or child journal.
- Do not change saved-workflow lookup precedence unless new evidence requires it.
- Do not implement controller-driven resume of existing runs.
- Do not change `parallel()` or `pipeline()` semantics except where needed to share the same scheduler path.

## Spec sections

- `spec.md` §7 Runtime API: `workflow(nameOrRef, args)` contract.
- `spec.md` §10 Scheduling: child workflows share the run-wide concurrency and total-agent caps.
- `spec.md` §14 Resume Semantics: child `agent()` calls must still use stable journal cache behavior.
- `spec.md` §15 Saved workflows: saved workflow files are orchestration only.
- `spec.md` §21 Acceptance Criterion 22.

## ADR dependencies

- Read `docs/areas/adr/0002-use-acorn-and-node-vm-for-first-workflow-runtime.md`.
- Read `docs/areas/adr/0007-organize-workflows-as-domain-modules.md`.
- Read `docs/areas/adr/0008-use-v2-stable-agent-keys-and-jsonl-journals.md`.
- Read `docs/areas/adr/0009-use-pi-saved-workflow-script-locations.md`.
- Add a new ADR only if implementation needs a durable policy not already covered by those ADRs.

## Production files

- `src/workflows/script/runtime.ts`
- `src/workflows/saved/resolver.ts`
- `src/workflows/launch/launcher.ts`
- `src/workflows/launch/model.ts`
- `src/workflows/script/model.ts`

## Tests

- `test/workflows/script/runtime.test.ts`
- `test/workflows/launch/launcher.test.ts`
- `test/workflows/saved/resolver.test.ts` only if child saved-name resolution needs additional coverage.
- Consider a focused scenario in `test/workflows/launch/workflow-scenario.test.ts` if runtime-only tests cannot prove shared journal/cache behavior.

## Acceptance criteria

- A parent script can call `await workflow("saved-name", childArgs)` and receive the child's returned value.
- A parent script can call `await workflow({ scriptPath }, childArgs)` and receive the child's returned value.
- Child `agent()` calls pass through the same scheduler and count toward the same total-agent cap.
- Child execution uses the same budget surface as the parent.
- `workflow()` called from inside a child workflow throws a predictable error.
- Child `agent()` calls participate in the existing journal cache; unchanged child calls should replay from cached `result` events.
- Child logs, phases, and agent progress update the parent run manifest rather than creating a second run.

## Verification

- Run `pnpm run check`.
- Run `pnpm test -- test/workflows/script/runtime.test.ts test/workflows/launch/launcher.test.ts`.
- Run `pnpm run verify` before marking the implementation complete, unless an unrelated existing formatter or lint failure is documented.

## Notes for agents

- Base this on the open backlog slice `5.3 Child workflow()`.
- Prefer extending the existing runtime/launcher seams over adding a new orchestration layer.
- Keep saved workflow resolution behavior aligned with `docs/areas/spec-coverage.md` row §15 and ADR 0009.
- Do not let child execution bypass deterministic-script guards or stable journal key generation.
