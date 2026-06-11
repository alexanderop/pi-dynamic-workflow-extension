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

  // Workflow synthesis lives at the END of the result, so keep both a head and a
  // tail with a middle gap marker. The marker length depends on the omitted-char
  // count, so estimate it first, derive the content budget, then recompute.
  const estimate = gapMarker(text.length, outputPath);
  if (estimate.length >= maxChars) {
    // Too small to fit head + marker + tail. Fall back to a head/marker slice,
    // mirroring the original guard.
    const suffix = `\n[truncated ${text.length - maxChars} chars, full result in ${outputPath}]`;
    if (suffix.length >= maxChars) return suffix.slice(0, maxChars);
    return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
  }

  // Bias toward the tail since synthesis lives at the end: ~60% tail, ~40% head.
  const contentBudget = maxChars - estimate.length;
  const headBudget = Math.floor(contentBudget * 0.4);
  const tailBudget = contentBudget - headBudget;

  const head = text.slice(0, headBudget);
  const tail = tailBudget > 0 ? text.slice(text.length - tailBudget) : "";

  const omitted = text.length - head.length - tail.length;
  const marker = gapMarker(omitted, outputPath);
  const inlined = `${head}${marker}${tail}`;

  // Recomputing the marker (with the exact omitted count) can shift the length
  // by a digit or two; clamp to the budget to keep the guarantee.
  return inlined.length <= maxChars ? inlined : inlined.slice(0, maxChars);
}

function gapMarker(omitted: number, outputPath: string): string {
  return `\n[… ${omitted} chars truncated; full result in ${outputPath} …]\n`;
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
  // The <result> payload is an XML text node, where only `&` and `<` strictly
  // need escaping. Quotes only matter inside attribute values, so leaving them
  // raw keeps the model-visible result compact and matches the reference
  // Claude Code notification. `&` must be replaced first. `>` is kept as a
  // harmless defensive escape.
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
