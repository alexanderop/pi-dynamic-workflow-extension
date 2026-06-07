# Workflow Model Policy Direction

- User preference/direction: simplify workflow subagents to inherit the currently selected Pi model, following `Michaelliv/pi-dynamic-workflows`, instead of letting workflow scripts route per-agent models by default.
- External reference behavior observed from `https://github.com/Michaelliv/pi-dynamic-workflows.git`:
  - `src/workflow-tool.ts` passes `ctx.modelRegistry` and `ctx.model` into the workflow runner session options.
  - `src/agent.ts` spreads those session options into `createAgentSession(...)`, so subagents use the parent Pi model.
  - `src/workflow.ts` accepts `agent({ model })`, but only renders it as prompt guidance (`Requested model: ...`); it does not switch model sessions.
  - The reference implementation has no `thinkingLevel` support.
- Preferred local direction: make selected-Pi-model inheritance the simple/default path; keep the current richer model-routing implementation only behind a future experimental feature-flag mechanism if we preserve it.
- When implementing, update authoring prompts/tool descriptions so workflows vary effort with `thinkingLevel`, not provider/model IDs, unless the experimental routing flag is explicitly enabled.
