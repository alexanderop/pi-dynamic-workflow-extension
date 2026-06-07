---
title: Flue-Inspired Structured Output Retry
status: implemented
priority: P6
last_audited: 2026-06-07
implementation: "Implemented with structured_output/give_up tools, non-object schema envelopes, two same-session nudges, retry live events, and schema-failure journal safety."
next: "No active implementation gap; extend only if new structured-output behavior is added to spec.md."
---

# Spec: Flue-Inspired Structured Output Retry

## Status

Implemented on 2026-06-07.

This spec replaces the old one-shot `agent({ schema })` behavior with a bounded, Flue-inspired result-tool protocol for Pi workflow subagents. It keeps the current `structured_output` tool contract but adds prompt ordering, retry nudges, a `give_up` escape hatch, and optional schema envelopes for non-object schemas.

## Triggering observation

Workflow run `wf_e50ffcd8c5ef1b6f` completed overall but one verification agent failed:

```text
verify:runtime-model-routing
WorkflowAgentSchemaError: Pi workflow subagent finished without calling structured_output.
```

The agent did useful verification work and ended after normal tool calls, but it never called the temporary `structured_output` tool. Our runner then failed immediately because `hasStructuredOutput` was still false.

The failure was not that the schema could not be cloned. The schema is only the contract. There is no result object to clone until the model calls the tool with arguments.

## External reference: Flue

Flue handles structured results with the same base idea plus a stronger loop:

- appends final-result instructions after the user task;
- injects two tools, `finish` and `give_up`;
- validates `finish` arguments and captures parsed output;
- wraps non-object schemas in `{ result: ... }` because tool parameters must be object-shaped;
- sends follow-up prompts when the model ends without either result tool;
- throws a typed error when the model gives up or exhausts retries.

Evidence from `withastro/flue` commit `b2d680314e53ff6f41352799441c0d2c82e803e8`:

- result footer and missing-result follow-up: https://github.com/withastro/flue/blob/b2d680314e53ff6f41352799441c0d2c82e803e8/packages/runtime/src/result.ts#L15-L31
- `finish` / `give_up` tool bundle and capture: https://github.com/withastro/flue/blob/b2d680314e53ff6f41352799441c0d2c82e803e8/packages/runtime/src/result.ts#L142-L258
- retry loop around prompt calls: https://github.com/withastro/flue/blob/b2d680314e53ff6f41352799441c0d2c82e803e8/packages/runtime/src/session.ts#L2177-L2223
- structured-result tests: https://github.com/withastro/flue/blob/b2d680314e53ff6f41352799441c0d2c82e803e8/packages/runtime/test/structured-results.test.ts#L54-L210

## Goals

- Make schema-backed workflow agents resilient when the model answers in prose or stops after ordinary tools.
- Preserve the model-facing contract: `agent(prompt, { schema })` resolves only after validated structured output.
- Preserve journal safety: append `result` only after structured output succeeds.
- Keep the solution Pi-native by using custom tools and in-session follow-up prompts.
- Keep retries bounded and auditable in `/workflows` live activity.
- Support plain JavaScript workflow schemas without requiring workflow authors to import TypeBox or Valibot.

## Non-goals

- Do not parse freeform prose as a fallback structured result.
- Do not add live model tests.
- Do not change non-schema `agent()` behavior.
- Do not change scheduler concurrency, `parallel()`, `pipeline()`, or resume semantics.
- Do not introduce a new workflow-level result transport outside Pi tools.
- Do not implement full Valibot semantics; workflow schemas are plain JSON Schema.

## User-facing behavior

### Successful schema agent

A schema agent succeeds when the model calls `structured_output` with arguments accepted by Pi tool validation. The `agent()` promise resolves with the captured arguments, or with the unwrapped value if the schema used an envelope.

### Missing structured output

If a prompt turn ends without `structured_output` or `give_up`, the runner sends an in-session follow-up prompt:

```text
You ended your turn without calling `structured_output` or `give_up`.
Either call `structured_output` with your final answer, or call `give_up` with a reason if you cannot produce valid structured output.
Plain text does not count as a result.
```

The runner allows two nudges after the initial attempt, for three total prompt attempts.

### Give up

If the model calls `give_up`, the agent fails with `WorkflowAgentSchemaError` and the supplied reason. The failure is not cached as a journal result.

### Exhausted nudges

If no valid structured output is captured after the initial attempt plus two nudges, the agent fails with:

```text
Pi workflow subagent finished without calling structured_output after 2 nudges.
```

## Prompt protocol

Move structured-output instructions to the end of the prompt, after the assigned task. The result instruction should be the final thing the model reads. For enveloped schemas, show the Pi-facing envelope schema so the model knows to pass `{ result: ... }` as tool arguments.

Prompt shape:

```text
You are a dynamic-workflow subagent running in an isolated Pi sidechain.
Complete only the assigned task below and return the final result concisely.
Do not mention that you are a subagent unless it is relevant to the result.

Agent id: ...
Label: ...
Phase: ...
Agent type: ...

Assigned task:
...

Structured output is required.
When the task is complete, call `structured_output` with your final answer as its arguments.
The arguments are validated against the required schema; if validation fails you may receive an error and try again.
If you cannot complete the task or cannot produce valid structured output, call `give_up` with a clear reason.
Do not answer with prose instead of calling `structured_output`; plain text does not count.
The `structured_output` arguments must satisfy this JSON schema:
...
```

## Tool protocol

Create a per-agent tool bundle instead of a single tool:

```ts
type WorkflowStructuredOutputOutcome =
  | { type: "pending" }
  | { type: "finished"; value: unknown }
  | { type: "gave_up"; reason: string };
```

The bundle exposes:

- `tools`: `[structured_output, give_up]`
- `getOutcome()`: current outcome
- schema metadata: whether an envelope was used

### `structured_output`

- Name: `structured_output`.
- Parameters: object-shaped JSON Schema, possibly enveloped.
- On first successful call:
  - clone the accepted params;
  - unwrap `{ result }` if an envelope was used;
  - set outcome to `{ type: "finished", value }`;
  - return `terminate: true`.
- On duplicate calls after an outcome exists:
  - return a normal tool result explaining the result was already submitted;
  - do not overwrite the first outcome.

### `give_up`

- Name: `give_up`.
- Parameters:

```json
{
  "type": "object",
  "properties": {
    "reason": { "type": "string", "minLength": 1 }
  },
  "required": ["reason"],
  "additionalProperties": false
}
```

- On first valid call:
  - set outcome to `{ type: "gave_up", reason }`;
  - return `terminate: true`.
- On duplicate calls, keep the first outcome.

## Schema envelope support

Pi tool parameters must be top-level objects. The implementation adopts Flue's envelope pattern:

- If the workflow schema is object-shaped, use it directly.
- If the workflow schema is scalar, array, union, or otherwise non-object, expose tool parameters as:

```json
{
  "type": "object",
  "properties": {
    "result": <original-schema>
  },
  "required": ["result"],
  "additionalProperties": false
}
```

The returned `agent()` value is the unwrapped `result`, not the envelope object.

This expands the workflow API while preserving Pi's tool-parameter requirement.

## Runner loop

Schema agents run in a single Pi sidechain session. Retries are follow-up user prompts in that same session, not new workflow agents.

Algorithm:

1. Create the structured-output tool bundle.
2. Launch the Pi sidechain session with the bundle tools.
3. Prompt with the normal subagent prompt.
4. After `session.prompt(...)` returns, inspect `bundle.getOutcome()`.
5. If `finished`, return the captured value.
6. If `gave_up`, throw `WorkflowAgentSchemaError` with reason.
7. If `pending`, emit a compact live event and prompt with the follow-up nudge.
8. Repeat until two nudges have been sent.
9. If still pending, throw `WorkflowAgentSchemaError`.

The retry loop must respect `request.signal` before and after every prompt call. Abort must abort and dispose the sidechain session exactly once.

## Live progress behavior

On every missing-output nudge, emit a compact workflow live event so `/workflows` explains why the agent is still running:

```ts
{
  type: "agent_event",
  eventType: "structured_output_retry",
  label: "structured output missing; nudge 1/2",
  activityState: "waiting_for_model"
}
```

On `give_up`, the final agent failure should include the reason in `resultPreview` / failure detail.

## Journal and resume behavior

- The scheduler still appends one `started` event before the agent begins.
- Follow-up nudges are part of the same agent attempt and do not create new journal keys.
- Append `result` only after `structured_output` succeeds and the final value is captured.
- Append `failed` after `give_up` or exhausted nudges.
- Never cache assistant prose for a schema agent.
- Retry prompts must not affect stable journal keys; the key remains based on the original prompt, schema, label, phase, agent type, effective model, thinking level, and cwd.

## Error handling

Use `WorkflowAgentSchemaError` for all final schema-agent failures:

- missing `structured_output` after two nudges;
- model calls `give_up`;
- schema cannot be converted to Pi tool parameters;
- structured-output tool setup fails.

Invalid tool arguments should preferably surface to the model as a Pi tool error first. If Pi returns control to the runner without a successful outcome, the runner's follow-up nudge handles the next attempt.

## Implementation slices

### Slice 1: prompt footer and retry loop

- [x] Move structured-output instructions to the end of `buildPiSubagentPrompt(...)`.
- [x] Add `buildStructuredOutputFollowUpPrompt(...)`.
- [x] Add a two-nudge loop in `runPiWorkflowAgent(...)` for schema agents.
- [x] Keep compatibility for the old single `structured_output` helper while the runner uses the bundle.

### Slice 2: result-tool bundle and `give_up`

- [x] Replace `createWorkflowStructuredOutputTool(...)` with a bundle creator while preserving compatibility exports for tests.
- [x] Add `give_up` and outcome tracking.
- [x] Ensure first successful result wins.
- [x] Surface `give_up` reason as `WorkflowAgentSchemaError`.

### Slice 3: schema envelopes

- [x] Accept non-object JSON Schemas by wrapping them in `{ result: ... }`.
- [x] Return the unwrapped value from `agent()`.
- [x] Update tests and spec docs to remove the old object-only limitation.

### Slice 4: observability and docs

- [x] Add retry live events and activity label/state assertions.
- [x] Update `spec.md` §7/§9 after behavior landed.
- [x] Update `brain/contracts/spec-coverage.md` and `brain/plans/index.md`.
- [x] Update ADR 0014 for envelopes, `give_up`, and implemented two-nudge policy.

## Test plan

Use fake Pi sessions and fake model/tool behavior only.

### `test/workflows/agent/structured-output-tool.test.ts`

- Creates `structured_output` and `give_up` tools.
- Captures object-shaped schema output.
- Wraps and unwraps non-object schemas.
- `give_up` records a reason.
- First outcome wins; duplicate calls do not overwrite.
- Invalid tool setup throws `WorkflowAgentSchemaError`.

### `test/workflows/agent/pi-runner.test.ts`

- Schema agent succeeds on first `structured_output` call.
- First prompt misses structured output, first nudge succeeds.
- Two nudges are sent, then missing output fails with schema error.
- `give_up` fails with the model-supplied reason.
- Follow-up prompt uses `{ expandPromptTemplates: false, source: "extension" }`.
- Abort during a retry aborts and disposes the session once.
- Retry live events are emitted with nudge counts.

### Integration-level runtime tests

- `agent({ schema })` result is cached only after structured output succeeds.
- Failed schema agent produces a journal `failed` event, not a `result` event.
- `parallel()` and `pipeline()` still convert thrown agent failures to `null` according to existing semantics.

## Acceptance criteria

- A schema agent that forgets `structured_output` once can recover via in-session nudge.
- A schema agent that never calls `structured_output` fails after exactly two nudges.
- A schema agent can explicitly `give_up` with a reason.
- `structured_output` remains the successful result tool name shown in transcripts and activity.
- Non-object schemas work through an envelope and return unwrapped values.
- Journal `result` events remain validation-safe.
- `pnpm run verify` passes with no live model tests.

## Open questions

- Should the nudge count remain ADR 0014's two nudges, or should we allow a higher cap like Flue's defense-in-depth ceiling? Current recommendation: keep two for cost and predictability.
- Should `give_up` be exposed in `spec.md` as part of the workflow contract, or treated as runner-internal implementation detail? Current recommendation: document as Pi implementation detail.
- Should duplicate result-tool calls return `terminate: true` or a normal non-terminating tool result? Current recommendation: first success wins; duplicate behavior can follow the least surprising transcript behavior after tests confirm Pi's batch termination semantics.
