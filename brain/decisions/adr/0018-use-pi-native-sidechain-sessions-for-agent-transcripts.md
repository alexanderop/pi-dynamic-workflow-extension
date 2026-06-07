# ADR 0018: Use Pi-Native Sidechain Sessions For Agent Transcripts

Status: proposed

## Context

`/workflows` can show compact manifest-backed agent detail, but users need a deeper view that replays everything a workflow subagent did: prompt, thinking, assistant text, tool calls, tool results, structured output, and errors.

Pi already has a public `SessionManager` JSONL format and `AgentSession` event model. Recording terminal frames would be brittle, and duplicating the session schema would create another persistence format to maintain.

## Decision

Persist each real Pi workflow subagent as a Pi-native sidechain session under the run transcript directory:

```text
.pi/workflows/<runId>/transcripts/sessions/<pi-session>.jsonl
.pi/workflows/<runId>/transcripts/agent-<agentId>.meta.json
```

The workflow agent progress row may store optional transcript pointers such as `transcriptPath` and `transcriptFormat: "pi-session-v3"`.

The future raw `/workflows` transcript view will lazy-read this Pi session file and project it into stable transcript blocks. The renderer may use Pi's exported public TUI message/tool components where safe, but tests should target project-local projection behavior and width-safe labels rather than private Pi formatting.

## Consequences

- Full transcript replay becomes possible without bloating `manifest.json`.
- Overview and structured detail remain manifest-only and cheap.
- Old runs without transcript pointers need an honest missing-transcript state.
- Transcript capture failures should fall back to in-memory subagent execution and must not fail the workflow by themselves.
- The implementation must thread `transcriptDir` from launcher to runtime to scheduler to runner, because the runner currently does not know the allocated `runId`.
