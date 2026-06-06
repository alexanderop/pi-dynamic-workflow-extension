import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { showWorkflowsTui } from "../tui/workflows-view.ts";
import { getWorkflowRunControl } from "../../workflows/run/control-registry.ts";
import { WorkflowRunController } from "../../workflows/run/controller.ts";
import type { WorkflowRunState } from "../../workflows/run/model.ts";
import { WorkflowRunStore } from "../../workflows/run/store.ts";
import { listSavedWorkflows } from "../../workflows/saved/list.ts";
import { formatDuration } from "../../workflows/view/projector.ts";
import { personalSavedWorkflowDir } from "../../workflows/saved/resolver.ts";
import type {
  WorkflowSavedWorkflow,
  WorkflowSavedWorkflowLocations,
} from "../../workflows/saved/resolver.ts";

type WorkflowCommandOutputType = "info" | "error";
type WorkflowCommandMode = "tui" | "rpc" | "json" | "print";
type WorkflowCommandContext = ExtensionCommandContext & {
  mode?: WorkflowCommandMode;
  savedWorkflowDirs?: WorkflowSavedWorkflowLocations;
};

export function registerWorkflowsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows", {
    description: "Show dynamic workflow runs",
    handler: async (_args, ctx) => {
      const commandCtx = ctx as WorkflowCommandContext;
      const rootDir = join(commandCtx.cwd, ".pi", "workflows");
      const store = new WorkflowRunStore({ rootDir });
      const runs = await store.listRuns();

      if (runs.status === "error") {
        emitWorkflowCommandOutput(
          commandCtx,
          `Could not read workflow runs: ${runs.error.message}`,
          "error",
        );
        return;
      }

      const savedWorkflows = await listSavedWorkflows(
        commandCtx.savedWorkflowDirs ?? {
          projectDir: rootDir,
          personalDir: personalSavedWorkflowDir(),
        },
      );

      if (savedWorkflows.status === "error") {
        emitWorkflowCommandOutput(
          commandCtx,
          `Could not read saved workflows: ${savedWorkflows.error.message}`,
          "error",
        );
        return;
      }

      if (shouldUseWorkflowsTui(commandCtx)) {
        await showWorkflowsTui(commandCtx, {
          runs: runs.value,
          savedWorkflowCount: savedWorkflows.value.length,
          loadRuns: () => store.listRuns(),
          onPauseRun: (runId) => {
            void controlWorkflowRun(commandCtx, store, runId, "pause");
          },
          onResumeRun: (runId) => {
            void controlWorkflowRun(commandCtx, store, runId, "resume");
          },
        });
        return;
      }

      emitWorkflowCommandOutput(
        commandCtx,
        formatWorkflowsOverview(runs.value, savedWorkflows.value),
        "info",
      );
    },
  });
}

async function controlWorkflowRun(
  ctx: WorkflowCommandContext,
  store: WorkflowRunStore,
  runId: string,
  operation: "pause" | "resume",
): Promise<void> {
  const control = getWorkflowRunControl(runId);
  if (control === undefined) {
    ctx.ui.notify(
      `Could not ${operation} workflow run '${runId}': no live runtime control is available.`,
      "warning",
    );
    return;
  }

  const controller = new WorkflowRunController({ store, control });
  const result = await controller[operation](runId);
  if (result.status === "error") {
    ctx.ui.notify(result.error.message, "error");
  }
}

function shouldUseWorkflowsTui(ctx: WorkflowCommandContext): boolean {
  return (
    (ctx.mode ?? (ctx.hasUI ? "tui" : "print")) === "tui" && typeof ctx.ui.custom === "function"
  );
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

function formatWorkflowsOverview(
  runs: WorkflowRunState[],
  savedWorkflows: WorkflowSavedWorkflow[],
): string {
  if (runs.length === 0 && savedWorkflows.length === 0) {
    return "No workflow runs or saved workflows found in .pi/workflows.";
  }

  return [formatWorkflowRuns(runs), formatSavedWorkflows(savedWorkflows)]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}

function formatWorkflowRuns(runs: WorkflowRunState[]): string | undefined {
  if (runs.length === 0) return undefined;

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

function formatSavedWorkflows(savedWorkflows: WorkflowSavedWorkflow[]): string | undefined {
  if (savedWorkflows.length === 0) return undefined;

  return [
    "Saved workflows",
    "",
    ...savedWorkflows
      .map((workflow) => formatSavedWorkflow(workflow))
      .join("\n\n")
      .split("\n"),
  ].join("\n");
}

function formatSavedWorkflow(workflow: WorkflowSavedWorkflow): string {
  return [
    workflow.name,
    `  Scope: ${workflow.scope}`,
    workflow.meta.description === undefined
      ? undefined
      : `  Description: ${workflow.meta.description}`,
    workflow.meta.whenToUse === undefined ? undefined : `  When to use: ${workflow.meta.whenToUse}`,
    `  Path: ${workflow.path}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
