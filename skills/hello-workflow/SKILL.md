---
name: hello-workflow
description: Launches a tiny Pi dynamic-workflow demo to verify the extension is installed and can run a background subagent. Use when the user asks to try, demo, smoke-test, or verify dynamic workflows.
---

# Hello Workflow Demo

Use this skill only when the user wants a small dynamic-workflow smoke test.

## Run the demo

Call the `Workflow` tool with the bundled workflow script. Use an absolute path resolved from this skill directory; do not pass the relative path literally.

```json
{
  "scriptPath": "/absolute/path/to/skills/hello-workflow/workflows/hello-workflow.js",
  "args": "<optional user topic or empty string>"
}
```

Resolve `workflows/hello-workflow.js` relative to this `SKILL.md` file before invoking the tool.

After `Workflow` launches successfully, stop the current assistant turn. The workflow notification will report the result when the background run completes.

## What it does

The bundled script starts one minimal-thinking subagent and returns the greeting it writes. It does not require web, shell, or external tools.
