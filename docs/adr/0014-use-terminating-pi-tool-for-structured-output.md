# ADR 0014: Use Terminating Pi Tool For Structured Output

Status: accepted

## Context

`spec.md` defines `agent(prompt, { schema })` as a workflow boundary that resolves
to a validated structured object instead of final assistant prose. Observed
Claude-like workflow behavior also shows that missing structured output should
fail predictably after bounded nudges or retries.

Pi does not expose a separate `createAgentSession()` response-format option for
JSON-schema output. The Pi-native mechanism is custom tools:

- SDK sessions accept `customTools`.
- Pi validates tool arguments against the tool parameter schema before
  `execute()` receives them.
- Pi supports `terminate: true` tool results so an agent can end on a final tool
  call without an automatic follow-up model turn.
- Pi's own structured-output extension example uses a `structured_output` tool
  with schema parameters, result `details`, and `terminate: true`.

Workflow scripts pass plain JSON object schemas, not TypeBox objects, because
saved workflows are plain JavaScript and should not import extension runtime
packages.

## Decision

For every real Pi workflow subagent with `options.schema`, register a per-agent
custom tool named `structured_output`.

The tool must:

- use the workflow schema as its Pi tool parameter schema;
- reject non-object top-level schemas before session launch, because Pi tool
  parameters must be object-shaped;
- capture the validated `params` passed into `execute()`;
- return the captured object in `details`;
- return `terminate: true`.

The subagent prompt must state that structured output is required and that the
final action must be a `structured_output` tool call. If the session completes
without a captured tool call, the workflow agent fails with a schema error.

The accepted long-term policy is bounded correction before final failure:

1. If the model responds with prose instead of calling `structured_output`, issue
   an in-session nudge that repeats the schema and requires the tool call.
2. If Pi rejects a malformed tool call or schema-mismatched arguments, treat that
   as an invalid structured-output attempt and issue the same kind of nudge when
   possible.
3. Allow at most two nudges for a single workflow agent attempt.
4. After the final failed attempt, reject the agent with a schema error and mark
   the workflow agent/run failure through the normal scheduler and run-state
   paths.

Journal behavior follows ADR 0008:

- append `started` before the real Pi subagent begins;
- append `result` only after structured output has been captured and accepted;
- append `failed` for missing or invalid structured output after the bounded
  correction policy is exhausted;
- never cache prose fallback output for an `agent({ schema })` call.

Current implementation status: the Pi runner already registers and captures the
terminating `structured_output` tool and fails if the tool is missing. The bounded
nudge policy is accepted here but remains a follow-up implementation slice.

## Consequences

- The workflow API maps to Pi's existing tool system instead of inventing a
  parallel structured-response transport.
- Structured-output results are auditable as normal Pi tool calls and tool
  results.
- Plain JavaScript workflow schemas remain usable without TypeBox imports.
- Pi's argument validation owns the exact validation/coercion behavior for tool
  parameters. If the extension needs stricter launch-time schema validation, that
  should be added explicitly before session creation.
- Missing or invalid structured output is not considered a successful agent
  result and must not enter the resume cache.
- The implementation is intentionally partial until the two-nudge correction
  loop is wired into the Pi runner and covered by tests.
