import type { WorkflowFailure, WorkflowRunState } from "#src/workflows/run/model.ts";
import type {
  WorkflowTaskNotification,
  WorkflowTaskNotificationDetails,
  WorkflowTaskUsage,
  WorkflowTerminalOutput,
} from "./model.ts";

export function toTerminalOutput(
  state: WorkflowRunState,
  outputPath: string,
): WorkflowTerminalOutput {
  return {
    runId: state.runId,
    taskId: state.taskId,
    workflowName: state.workflowName,
    status: state.status,
    timestamp: state.timestamp,
    durationMs: state.durationMs,
    outputPath,
    result: state.result,
    failures: state.failures,
    usage: terminalUsage(state),
  };
}

export function toTaskNotification(
  state: WorkflowRunState,
  outputPath: string,
  summarySource: string,
  inlineResultMaxChars = 4000,
): WorkflowTaskNotification {
  const result = inlineResult(state.result, outputPath, inlineResultMaxChars);
  const details: WorkflowTaskNotificationDetails = {
    taskId: state.taskId,
    runId: state.runId,
    outputFile: outputPath,
    status: state.status,
    summary: `Dynamic workflow "${summarySource}" ${state.status}`,
    result,
    failures: state.failures?.map(formatFailure),
    usage: terminalUsage(state),
  };

  return {
    customType: "workflow-task-notification",
    display: true,
    content: taskNotificationXml(details),
    details,
  };
}

function terminalUsage(state: WorkflowRunState): WorkflowTaskUsage {
  return {
    agentCount: state.agentCount,
    subagentTokens: state.totalTokens,
    toolUses: state.totalToolCalls,
    durationMs: state.durationMs ?? 0,
  };
}

function inlineResult(result: unknown, outputPath: string, maxChars: number): string {
  const text = result === undefined ? "" : stringifyResult(result);
  if (text.length <= maxChars) return text;

  const suffix = `\n[truncated ${text.length - maxChars} chars, full result in ${outputPath}]`;
  if (suffix.length >= maxChars) return suffix.slice(0, maxChars);
  return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2) ?? "";
}

function taskNotificationXml(details: WorkflowTaskNotificationDetails): string {
  return [
    "<task-notification>",
    `  <task-id>${escapeXml(details.taskId)}</task-id>`,
    `  <output-file>${escapeXml(details.outputFile)}</output-file>`,
    `  <status>${escapeXml(details.status)}</status>`,
    `  <summary>${escapeXml(details.summary)}</summary>`,
    `  <result>${escapeXml(details.result)}</result>`,
    failuresXml(details.failures),
    "  <usage>",
    `    <agent_count>${details.usage.agentCount}</agent_count>`,
    `    <subagent_tokens>${details.usage.subagentTokens}</subagent_tokens>`,
    `    <tool_uses>${details.usage.toolUses}</tool_uses>`,
    `    <duration_ms>${details.usage.durationMs}</duration_ms>`,
    "  </usage>",
    "</task-notification>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function failuresXml(failures: string[] | undefined): string | undefined {
  if (failures === undefined || failures.length === 0) return undefined;
  return [
    "  <failures>",
    ...failures.map((failure) => `    <failure>${escapeXml(failure)}</failure>`),
    "  </failures>",
  ].join("\n");
}

function formatFailure(failure: WorkflowFailure): string {
  if (failure.scope === "agent" && failure.agentId !== undefined)
    return `agent ${failure.agentId} failed: ${failure.message}`;
  if (failure.scope === "pipeline" && failure.pipelineIndex !== undefined)
    return `pipeline[${failure.pipelineIndex}] failed: ${failure.message}`;
  return `${failure.scope} failed: ${failure.message}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
