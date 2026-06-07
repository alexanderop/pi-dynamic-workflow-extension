# Structured Output Retry Reference

- If a schema-backed workflow subagent finishes after ordinary prose or another tool without calling `structured_output`, there is no validated object to return. Do not return the schema itself as a fallback; the schema is only the contract.
- Flue's structured-result pattern is a useful implementation reference: inject `finish` and `give_up` tools, tell the model that plain text does not count, convert the schema to tool parameters, capture validated `finish` args, nudge again when no result tool is called, and throw a tool error on validation failure so the model can self-correct.
- Flue also wraps non-object result schemas as `{ result: ... }` because provider tool arguments must be top-level objects.
- This repo's implemented policy is [[decisions/adr/0014-use-terminating-pi-tool-for-structured-output]]: use the Pi `structured_output`/`give_up` tool bundle and at most two in-session nudges before schema failure, not Flue's larger retry ceiling.
- Relevant implementation surface: `src/workflows/agent/pi-runner.ts`, `src/workflows/agent/structured-output-tool.ts`, `test/workflows/agent/pi-runner.test.ts`, and `test/workflows/agent/structured-output-tool.test.ts`.
- External evidence from the transcript: Flue commit `b2d680314e53ff6f41352799441c0d2c82e803e8`, especially `packages/runtime/src/result.ts` for result tools and `packages/runtime/src/session.ts` for the follow-up loop.
