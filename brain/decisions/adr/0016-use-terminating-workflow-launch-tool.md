# ADR 0016: Use Terminating Workflow Launch Tool

Status: accepted

## Context

Pi custom tools normally feed their result back into the model and then allow the assistant turn to continue. For `Workflow`, that makes the orchestrator keep doing local work immediately after launching a background run, even though the workflow is meant to own the delegated work until it finishes or the user gives another instruction.

Pi supports `terminate: true` tool results, which skip the automatic follow-up model call when every tool in the current batch terminates.

## Decision

The model-facing `Workflow` tool returns `terminate: true` after a successful launch.

The launch confirmation remains visible to the user and includes the task id, run id, script path, transcript directory, and `/workflows` hint. The terminating result only controls the current assistant turn: the background runtime continues independently, and terminal workflow notifications are still delivered through the notification policy.

Workflow authoring instructions also tell the orchestrator to make the `Workflow` call the last action of the turn and not perform fallback local work while the background run is active.

## Consequences

- After launching a workflow, the orchestrator stops instead of spending more tokens on duplicate local work.
- The user can watch `/workflows` or send a new instruction while the run proceeds.
- If the assistant batches `Workflow` with other non-terminating tool calls, Pi may still continue because termination only skips follow-up when every finalized tool in the batch is terminating. The prompt therefore keeps steering the model to call `Workflow` as the final action.
- Completion notifications remain a separate policy from launch-turn termination.
