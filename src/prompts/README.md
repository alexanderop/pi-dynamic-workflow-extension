# Prompt source files

This folder is the canonical home for model-facing prompt text used by the workflow extension.

- `workflow-tool.md` — readable Markdown source for workflow authoring guidance injected into the workflow tool prompt.
- `workflow-tool.ts` — workflow tool schema descriptions, prompt snippet, Markdown prompt loader, and background-start follow-up instruction.
- `workflow-trigger.ts` — native trigger prompt generated from `ultracode`, `quick workflow`, and `use workflow to ...` inputs.
- `workflow-agent.ts` — parent-workflow instructions passed into isolated subagents.
- `structured-output.ts` — structured-output tool prompt text and required final-action contract.
- `workflow-completion.ts` — workflow-completion message sent back to the main agent for summarization.

Keep short model-facing constants here. Put long prompt guidance in Markdown when readability matters, then load it through a small TypeScript wrapper for runtime use.
