// Translates raw Pi session events into the workflow scheduler's
// WorkflowAgentLiveEvent vocabulary. Pure mapping with no session lifecycle;
// the runner in pi-runner.ts subscribes and forwards.
import { isRecord } from "#src/workflows/guards.ts";
import type { WorkflowAgentLiveEvent } from "#src/workflows/agent/scheduler.ts";
import type { WorkflowAgentActivityState } from "#src/workflows/agent/model.ts";

const AGENT_EVENT_ACTIVITY: Record<
  string,
  { readonly label: string; readonly activityState: WorkflowAgentActivityState }
> = {
  agent_start: { label: "agent started", activityState: "starting" },
  turn_start: { label: "waiting for model", activityState: "waiting_for_model" },
  turn_end: { label: "turn completed", activityState: "finalizing" },
  agent_end: { label: "agent finished", activityState: "finalizing" },
};

export function piSessionEventToWorkflowLiveEvent(
  event: unknown,
): WorkflowAgentLiveEvent | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  const at = Date.now();
  const agentActivity = AGENT_EVENT_ACTIVITY[event.type];
  if (agentActivity !== undefined) {
    return { type: "agent_event", at, eventType: event.type, ...agentActivity };
  }
  switch (event.type) {
    case "message_update":
      return { type: "message_update", at, summary: messageUpdateSummary(event) };
    case "tool_execution_start":
      return {
        type: "tool_start",
        at,
        toolCallId: stringField(event, "toolCallId") ?? "unknown",
        toolName: stringField(event, "toolName") ?? "tool",
        summary: summarizeUnknown(event.args),
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        at,
        toolCallId: stringField(event, "toolCallId") ?? "unknown",
        toolName: stringField(event, "toolName") ?? "tool",
        summary: summarizeUnknown(event.partialResult),
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        at,
        toolCallId: stringField(event, "toolCallId") ?? "unknown",
        toolName: stringField(event, "toolName") ?? "tool",
        summary: summarizeUnknown(event.result),
        isError: event.isError === true,
      };
    default:
      return undefined;
  }
}

function messageUpdateSummary(event: Record<string, unknown>): string | undefined {
  const assistantEvent = event.assistantMessageEvent;
  if (isRecord(assistantEvent)) {
    const text = stringField(assistantEvent, "text") ?? stringField(assistantEvent, "delta");
    if (text !== undefined) return truncateSummary(text);
    if (typeof assistantEvent.type === "string") return assistantEvent.type;
  }
  return undefined;
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return truncateSummary(value);
  try {
    return truncateSummary(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function truncateSummary(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}…`;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}
