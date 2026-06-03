# Spec: schema-enforced subagent output for workflow `agent()`

## Status

Draft for review.

## Problem

Workflow scripts want to write code like this:

```js
const findings = await agent('Inspect src/workflow.ts and return findings', {
  label: 'review:runtime',
  phase: 'Review',
  schema: FINDINGS_SCHEMA,
})
```

The desired behavior is not merely “ask the subagent to output JSON”. The parent workflow needs a real JavaScript value that conforms to the schema so later orchestration code can safely do:

```js
findings.items.map(...)
```

The important requirement: when `agent()` receives `opts.schema`, Pi should enforce that the subagent returns a schema-shaped value.

## Core idea

Pi already has the mechanism we need: tools can declare `parameters` as a TypeBox/JSON-schema-like schema. The model can be forced into a final tool call by exposing a dedicated terminating tool to the subagent:

```ts
defineTool({
  name: 'structured_output',
  parameters: schema,
  async execute(_toolCallId, params) {
    capture.value = params
    return {
      content: [{ type: 'text', text: 'Structured output received.' }],
      details: params,
      terminate: true,
    }
  },
})
```

So `agent(prompt, { schema })` should dynamically inject a `structured_output` tool into that subagent session. The tool schema is the requested output schema. The final value returned by `agent()` is the validated tool arguments captured by `structured_output`.

## Goals

1. `agent(prompt, { schema })` returns a parsed JavaScript value, not markdown or JSON text.
2. The schema is enforced through Pi tool parameter validation.
3. The subagent is instructed that its final action must be `structured_output`.
4. The structured output tool terminates the subagent turn to avoid an unnecessary follow-up LLM call.
5. If the subagent finishes without calling `structured_output`, `agent()` fails clearly.
6. Invalid tool arguments should be rejected by Pi’s tool validation path, giving the subagent a chance to repair if Pi’s normal agent loop supports that.
7. The parent workflow receives only schema-shaped data or an error.

## Non-goals

- Do not parse arbitrary JSON from assistant prose as the primary enforcement mechanism.
- Do not add a global `structured_output` tool to the main session.
- Do not require workflow authors to manually create tools.
- Do not implement provider-native JSON mode as the first version.
- Do not support arbitrary `$ref` resolution unless Pi’s tool schema path already supports it.

## Current implementation shape

The repo already has most of the skeleton:

- `src/structured-output.ts` creates a terminating `structured_output` tool.
- `src/agent.ts` injects that tool when `options.schema` exists.
- `src/workflow.ts` normalizes `agent()` options and passes `schema` to the subagent runner.

Target behavior should be formalized, tested, and made more robust.

## Proposed API

Workflow author API:

```js
const result = await agent(prompt, {
  label: 'scan:runtime',
  phase: 'Scan',
  schema: RESULT_SCHEMA,
})
```

`RESULT_SCHEMA` is a JSON-schema-like object compatible with Pi tool parameters / TypeBox:

```js
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'evidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
}
```

Return value:

```js
{
  summary: '...',
  findings: [
    { title: '...', severity: 'medium', evidence: '...' }
  ]
}
```

## Runtime design

### 1. Workflow script calls `agent()`

`src/workflow.ts` already accepts:

```ts
agent(prompt, {
  label?: string
  phase?: string
  schema?: unknown
  instructions?: string
  agentType?: string
  model?: string
  isolation?: string
})
```

When `schema` is present, `runWorkflow()` passes it to `WorkflowAgent.run()`.

### 2. `WorkflowAgent.run()` creates capture state

```ts
const capture = { called: false, value: undefined }
```

If `options.schema` exists, append the generated structured output tool to the subagent’s custom tools.

### 3. Dynamic tool schema

The generated tool uses the requested schema as its `parameters`:

```ts
createStructuredOutputTool({ schema: options.schema, capture })
```

Pi’s tool system should expose that schema to the provider and validate tool call arguments before `execute()` receives `params`.

### 4. Prompt contract

The subagent prompt must include direct instructions:

```text
Your final action MUST be a call to structured_output with data matching its schema. Do not finish with plain prose.
```

We should strengthen this with explanation:

```text
You are being run by a parent workflow. The parent workflow cannot parse prose. It only receives the arguments you pass to structured_output. Use the tool exactly once as your final action.
```

### 5. Tool execution captures output

```ts
async execute(_toolCallId, params) {
  capture.called = true
  capture.value = params
  return {
    content: [{ type: 'text', text: 'Structured output received.' }],
    details: params,
    terminate: true,
  }
}
```

`terminate: true` is important: Pi can skip the automatic follow-up LLM turn when all tools in the batch terminate.

### 6. Agent returns captured value

After `session.prompt(...)` resolves:

```ts
if (options.schema) {
  if (!capture.called) {
    throw new Error('Subagent finished without calling structured_output')
  }
  return capture.value
}
```

If no schema was requested, keep returning the last assistant text.

## Error behavior

### Missing structured output call

If the subagent ends without calling the tool:

```text
Subagent finished without calling structured_output
```

The workflow agent call rejects. The parent workflow fails unless the workflow script catches the error.

### Invalid structured output call

Expected Pi behavior:

1. The model calls `structured_output` with invalid arguments.
2. Pi validates arguments against `parameters`.
3. Validation fails before `execute()`.
4. The tool result is surfaced as an error to the subagent.
5. The subagent may retry with corrected arguments in the same session if the Pi agent loop continues after tool errors.

If Pi does not automatically continue after validation errors, we should add an explicit repair loop later.

### Multiple structured output calls

Preferred behavior for v1:

- The first valid call captures the value and terminates.
- Because the tool returns `terminate: true`, multiple calls should be unlikely.

Optional stricter behavior:

- If `execute()` is called after `capture.called === true`, throw `structured_output was called more than once`.

## Schema compatibility

The workflow script can provide plain JSON Schema objects. Internally we treat them as Pi tool schemas:

```ts
function asToolSchema(schema: unknown): TSchema {
  if (schema && typeof schema === 'object') return schema as TSchema
  return Type.Any({ description: 'Final structured output value' })
}
```

Recommended constraints for workflow-authored schemas:

- Use `type: 'object'` for top-level outputs.
- Use `required` explicitly.
- Use `additionalProperties: false` where possible.
- Use `enum` for small sets of strings.
- Avoid `$ref` unless supported by Pi’s provider conversion path.
- Avoid unsupported JSON Schema features until tested with all providers.

## Prompting requirements

When the workflow author supplies `schema`, the prompt generated for the subagent should include:

```text
You are a fresh, isolated Pi subagent running inside a parent workflow.
The parent workflow requested structured output.
Your final action MUST be a call to structured_output with data matching its schema.
Do not finish with plain prose.
Do not wrap the result in markdown.
Do not call structured_output until you have completed the task.
```

A useful addition is to explain why:

```text
The parent workflow only receives the structured_output tool arguments, not your prose. If you do not call structured_output, the workflow fails.
```

## Example workflow usage

```js
export const meta = {
  name: 'schema_output_demo',
  description: 'Demonstrate schema-enforced subagent output',
  phases: [{ title: 'Inspect' }, { title: 'Synthesize' }],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'file', 'severity'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

phase('Inspect')
const result = await agent(
  `Repo root: ${cwd}\nInspect src/workflow.ts and report concrete findings.`,
  {
    label: 'inspect:runtime',
    phase: 'Inspect',
    schema: FINDINGS_SCHEMA,
  },
)

phase('Synthesize')
const report = await agent(
  `Write a concise summary of these structured findings:\n${JSON.stringify(result, null, 2)}`,
  { label: 'synthesize:report', phase: 'Synthesize' },
)

return {
  findingCount: result.findings.length,
  findings: result.findings,
  report,
}
```

## Acceptance criteria

### Runtime

- `agent(prompt, { schema })` injects exactly one `structured_output` tool into the subagent session.
- The injected tool uses the provided schema as `parameters`.
- A valid `structured_output` call returns its arguments as the `agent()` result.
- The tool result includes `terminate: true`.
- If the subagent does not call `structured_output`, `agent()` rejects with a clear error.
- If the schema is omitted, existing text-return behavior is unchanged.

### Workflow integration

- `runWorkflow()` passes `schema` from workflow script `agent()` options to the subagent runner.
- Structured results are included in journal cache keys so a schema change invalidates stale cached outputs.
- Structured results remain structured when persisted in the workflow journal.
- Workflow result cloning still rejects unresolved promises and non-cloneable values.

### UI/reporting

- The workflow dashboard should show the structured result preview.
- Full result details should remain available in agent details.
- Errors should distinguish:
  - missing structured output call,
  - schema validation/tool argument failure,
  - normal subagent execution failure.

## Test plan

### Unit tests for `createStructuredOutputTool`

1. Tool captures valid params.
2. Tool returns `terminate: true`.
3. Tool returns params in `details`.
4. Tool name defaults to `structured_output` and can be overridden.

### Unit tests for `WorkflowAgent.run()`

Use a fake `createAgentSession` or an injectable session factory.

1. When `schema` is present, custom tools include `structured_output`.
2. When the fake session calls the tool, `WorkflowAgent.run()` returns captured params.
3. When the fake session never calls the tool, `WorkflowAgent.run()` throws.
4. When no `schema` is present, `WorkflowAgent.run()` returns last assistant text.
5. The generated subagent prompt includes “final action MUST be a call to structured_output”.

### Runtime tests for `runWorkflow()`

1. `agent('x', { schema })` passes schema to `WorkflowAgentLike.run()`.
2. The schema participates in the workflow journal key.
3. Changing a schema causes the workflow not to reuse an old journaled result.
4. Structured values can be consumed by later workflow code.

### Integration-ish test

Create a test agent that asserts it receives a schema and returns:

```ts
{ summary: 'ok', findings: [] }
```

Then run:

```js
const result = await agent('inspect', { schema: FINDINGS_SCHEMA })
return { count: result.findings.length }
```

Expected result:

```json
{ "count": 0 }
```

## Open questions

1. Does Pi’s provider path validate dynamic `parameters` for all providers before `execute()`?
2. If validation fails, does the subagent automatically get another chance to call the tool correctly?
3. Do all supported providers accept the full TypeBox schema subset we want?
4. Should schemas be normalized or rejected early if they contain unsupported features?
5. Should `agent()` support a retry/repair count for missing or invalid structured output?

## Possible v2: explicit repair loop

If Pi does not reliably repair invalid/missing structured output, add an explicit loop:

1. Run subagent with `structured_output` tool.
2. If it ends without capture, send one repair prompt in the same subagent session:

```text
You did not call structured_output. The parent workflow cannot continue without it. Call structured_output now with the required schema-shaped result. Do not write prose.
```

3. If still missing, fail.

This should be bounded, e.g. `structuredOutputRetries = 1`, to avoid runaway loops.

## Recommendation

Implement v1 with Pi’s native tool-schema enforcement:

- dynamic `structured_output` tool,
- schema as tool `parameters`,
- terminating tool result,
- captured params as return value,
- clear missing-output error,
- tests around schema propagation and journal key invalidation.

Then decide whether a v2 repair loop is necessary based on real provider behavior.
