# Pi Tool API Gotchas

- To mark a Pi custom tool execution as failed, throw from `execute()`. Returning an error-shaped value does not set `isError`; Pi reports returned values as successful tool results.
- `terminate: true` is a batch-level hint. Pi skips the automatic follow-up model call only when every finalized tool result in the current batch is terminating.
- Use `StringEnum` from `@earendil-works/pi-ai` for string enums in tool schemas. `Type.Union`/`Type.Literal` string enums do not work with Google's API.
- `prepareArguments(args)` runs before schema validation and before `execute()`. Use it to adapt old stored tool-call arguments when resumed sessions contain an older input shape; keep the current `parameters` schema strict instead of adding deprecated compatibility fields.
- For workflow structured output, keep using a custom terminating tool as in [[decisions/adr/0014-use-terminating-pi-tool-for-structured-output]].
