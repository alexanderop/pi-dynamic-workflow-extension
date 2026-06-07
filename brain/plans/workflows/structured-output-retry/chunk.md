# Chunk: Structured Output Retry ADR

## Goal

Decide and document the Pi extension policy for `agent({ schema })` failures before implementing structured-output validation. The ADR should define how many retries or in-conversation nudges are attempted, what counts as missing or invalid structured output, and how the final failure is surfaced in run state, journal behavior, and notifications.

## Non-goals

- Do not implement schema validation or retry behavior in this chunk.
- Do not change the Pi agent runner or runtime API.
- Do not decide the full `agentType` to Pi mapping; that needs a separate ADR.
- Do not add live model tests.

## Spec sections

- `spec.md` §7 Runtime API: `agent()` resolves to a validated object when `schema` is supplied.
- `spec.md` §9 Subagent Contract: invalid or missing structured output should trigger bounded retries or nudges, then reject on final failure.
- `spec.md` §13 Journal Model: result events are append-only cache entries.
- `spec.md` §17 Notification Contract: failed structured output should appear in workflow failures.
- `spec.md` §21 Acceptance Criteria 6, 7, and 20.

## ADR dependencies

- Read `brain/decisions/adr/0001-use-adrs-for-workflow-architecture.md`.
- Read `brain/decisions/adr/0007-organize-workflows-as-domain-modules.md`.
- Read `brain/decisions/adr/0008-use-v2-stable-agent-keys-and-jsonl-journals.md`.
- Add a new ADR under `brain/decisions/adr/` for the structured-output retry/nudge policy.
- Update `brain/decisions/adr/README.md` only if that index is the current ADR convention.

## Production files

- Likely future implementation owners: `src/workflows/agent/pi-runner.ts`, `src/workflows/script/runtime.ts`, `src/workflows/journal/store.ts`, `src/workflows/journal/model.ts`, `src/workflows/run/model.ts`.
- This chunk should only add or update ADR documentation.

## Tests

- No code tests are required for the ADR chunk.
- The ADR should name the tests expected in the later implementation chunk, likely `test/workflows/agent/pi-runner.test.ts`, `test/workflows/script/runtime.test.ts`, and journal/run-state tests if result writing or failures change.

## Acceptance criteria

- A new ADR states the bounded retry or nudge count.
- The ADR defines whether invalid structured output, missing tool calls, invalid JSON, and schema mismatches are handled the same way.
- The ADR states that journal `result` events are appended only after validation succeeds.
- The ADR states how final schema failure becomes a run or agent failure.
- The ADR explicitly separates observed Claude-like behavior from Pi implementation choices.

## Verification

- Run `pnpm run fmt:check` only if the ADR format is included in the formatter target; otherwise perform docs review.
- Do not run live Pi or model tests for this chunk.

## Notes for agents

- Base the decision on the open backlog slice `7.2 Structured Output Validation`.
- Keep the ADR narrow enough that implementation can happen in a follow-up chunk.
- The spec records an observed failure message with "after 2 in-conversation nudges"; do not claim exact private internals beyond that evidence.
