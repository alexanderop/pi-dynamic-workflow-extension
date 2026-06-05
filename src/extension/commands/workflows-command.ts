import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { WorkflowRunStore } from "../../workflows/run/store.ts";
import type { WorkflowRunState } from "../../workflows/run/model.ts";

type WorkflowCommandOutputType = "info" | "error";
type WorkflowCommandMode = "tui" | "rpc" | "json" | "print";
type WorkflowCommandContext = ExtensionCommandContext & { mode?: WorkflowCommandMode };

export function registerWorkflowsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows", {
    description: "Show dynamic workflow runs",
    handler: async (_args, ctx) => {
      const store = new WorkflowRunStore({ rootDir: join(ctx.cwd, ".pi", "workflows") });
      const result = await store.listRuns();

      if (result.status === "error") {
        emitWorkflowCommandOutput(
          ctx,
          `Could not read workflow runs: ${result.error.message}`,
          "error",
        );
        return;
      }

      emitWorkflowCommandOutput(ctx, formatWorkflowRuns(result.value), "info");
    },
  });
}

function emitWorkflowCommandOutput(
  ctx: WorkflowCommandContext,
  message: string,
  type: WorkflowCommandOutputType,
): void {
  const mode = ctx.mode ?? (ctx.hasUI ? "tui" : "print");

  if (mode !== "json" && mode !== "print") {
    ctx.ui.notify(message, type);
    return;
  }

  if (mode === "json") {
    const stream = type === "error" ? process.stderr : process.stdout;
    stream.write(
      `${JSON.stringify({ type: "workflow_command_output", command: "workflows", severity: type, message })}\n`,
    );
    return;
  }

  const stream = type === "error" ? process.stderr : process.stdout;
  stream.write(`${message}\n`);
}

function formatWorkflowRuns(runs: WorkflowRunState[]): string {
  if (runs.length === 0) return "No workflow runs found in .pi/workflows.";

  return [
    "Workflow runs",
    "",
    ...runs
      .map((run) => formatWorkflowRun(run))
      .join("\n\n")
      .split("\n"),
  ].join("\n");
}

function formatWorkflowRun(run: WorkflowRunState): string {
  return [
    run.runId,
    `  Status: ${run.status}`,
    `  Workflow: ${run.workflowName}`,
    `  Agents: ${run.agentCount}`,
    run.durationMs === undefined ? undefined : `  Duration: ${formatDuration(run.durationMs)}`,
    run.outputPath === undefined ? undefined : `  Output: ${run.outputPath}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m ${seconds}s`;

  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}
