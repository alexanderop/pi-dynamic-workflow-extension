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

The tool bundle must:

- use object-shaped workflow schemas directly as Pi tool parameter schemas;
- wrap non-object workflow schemas as `{ result: <schema> }` because Pi tool
  parameters must be object-shaped, then unwrap the returned value for `agent()`;
- capture the first validated `structured_output` params passed into `execute()`;
- return the captured tool arguments in `details`;
- return `terminate: true` for the first successful `structured_output` call;
- also expose a terminating `give_up` tool that captures a non-empty reason and
  fails the workflow agent with `WorkflowAgentSchemaError`.

The subagent prompt must put structured-output instructions after the assigned
work so the result-tool protocol is the final instruction. If the session
completes without `structured_output` or `give_up`, the runner sends up to two
same-session nudges before final schema failure.

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

Current implementation status: the Pi runner registers the terminating
`structured_output`/`give_up` bundle, wraps non-object schemas, captures and
unwraps successful output, emits live retry events, and sends exactly two
same-session nudges before final schema failure.

## Consequences

- The workflow API maps to Pi's existing tool system instead of inventing a
  parallel structured-response transport.
- Structured-output results are auditable as normal Pi tool calls and tool
  results.
- Plain JavaScript workflow schemas remain usable without TypeBox imports, including array and scalar result schemas through an envelope.
- Pi's argument validation owns the exact validation/coercion behavior for tool
  parameters. If the extension needs stricter launch-time schema validation, that
  should be added explicitly before session creation.
- Missing or invalid structured output is not considered a successful agent
  result and must not enter the resume cache.
- The implementation is intentionally partial until the two-nudge correction
  loop is wired into the Pi runner and covered by tests.
