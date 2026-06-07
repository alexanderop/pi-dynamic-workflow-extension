import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiWorkflowAgentRunnerOptions } from "#src/workflows/agent/pi-runner.ts";
import { showWorkflowsTui } from "#src/extension/tui/workflows-view.ts";
import { getWorkflowRunControl } from "#src/workflows/run/control-registry.ts";
import {
  WorkflowRunController,
  type WorkflowRunControllerError,
} from "#src/workflows/run/controller.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { Result } from "#src/workflows/result.ts";
import { workflowRootDirForCwd } from "#src/workflows/run/root-dir.ts";
import {
  launchWorkflow,
  type WorkflowLaunch,
  type WorkflowLaunchError,
  type WorkflowLaunchOptions,
  type WorkflowLaunchRequest,
} from "#src/workflows/launch/launcher.ts";
import {
  buildWorkflowLaunchOptions,
  currentSessionId,
} from "#src/extension/workflow-launch-options.ts";
import { prepareWorkflowNotification } from "#src/extension/workflow-notifications.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { listSavedWorkflows } from "#src/workflows/saved/list.ts";
import { formatDuration } from "#src/workflows/view/layout.ts";
import type {
  WorkflowSavedWorkflow,
  WorkflowSavedWorkflowLocations,
} from "#src/workflows/saved/resolver.ts";

type WorkflowCommandOutputType = "info" | "error";
type WorkflowCommandMode = "tui" | "rpc" | "json" | "print";
type WorkflowCommandContext = ExtensionCommandContext & {
  mode?: WorkflowCommandMode;
  savedWorkflowDirs?: WorkflowSavedWorkflowLocations;
  model?: PiWorkflowAgentRunnerOptions["model"];
  modelRegistry?: PiWorkflowAgentRunnerOptions["modelRegistry"] & {
    getAvailable?: () =>
      | Promise<WorkflowLaunchOptions["availableModels"]>
      | WorkflowLaunchOptions["availableModels"];
  };
};

export interface RegisterWorkflowsCommandOptions {
  readonly launchWorkflow?: (
    request: WorkflowLaunchRequest,
    options: WorkflowLaunchOptions,
  ) => Promise<Result<WorkflowLaunch, WorkflowLaunchError>>;
}

type RegisterWorkflowsCommandPi = Pick<ExtensionAPI, "registerCommand"> &
  Partial<Pick<ExtensionAPI, "sendMessage" | "getThinkingLevel">>;

export function registerWorkflowsCommand(
  pi: RegisterWorkflowsCommandPi,
  options: RegisterWorkflowsCommandOptions = {},
): void {
  pi.registerCommand("workflows", {
    description: "Show dynamic workflow runs",
    handler: async (_args, ctx) => {
      const commandCtx = ctx as WorkflowCommandContext;
      const rootDir = workflowRootDirForCwd(commandCtx.cwd);
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
      const visibleRuns = filterRunsForCurrentSession(runs.value, commandCtx);

      const savedWorkflows = await listSavedWorkflows(
        commandCtx.savedWorkflowDirs ?? {
          projectDir: rootDir,
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
          runs: visibleRuns,
          savedWorkflowCount: savedWorkflows.value.length,
          loadRuns: async () => {
            const latest = await store.listRuns();
            if (latest.status === "error") return latest;
            return { status: "ok", value: filterRunsForCurrentSession(latest.value, commandCtx) };
          },
          onPauseRun: (runId) => {
            void controlWorkflow(commandCtx, store, runId, `pause workflow run '${runId}'`, (c) =>
              c.pause(runId),
            );
          },
          onResumeRun: (runId) => {
            void controlWorkflow(commandCtx, store, runId, `resume workflow run '${runId}'`, (c) =>
              c.resume(runId),
            );
          },
          onResumeStoppedRun: async (runId) => {
            await resumeStoppedWorkflow(commandCtx, pi, store, rootDir, runId, options);
          },
          onStopRun: (runId) => {
            void controlWorkflow(commandCtx, store, runId, `stop workflow run '${runId}'`, (c) =>
              c.stopRun(runId),
            );
          },
          onStopAgent: (runId, agentId) => {
            void controlWorkflow(
              commandCtx,
              store,
              runId,
              `stop workflow agent '${agentId}' in run '${runId}'`,
              (c) => c.stopAgent(runId, agentId),
            );
          },
        });
        return;
      }

      emitWorkflowCommandOutput(
        commandCtx,
        formatWorkflowsOverview(visibleRuns, savedWorkflows.value),
        "info",
      );
    },
  });
}

function filterRunsForCurrentSession(
  runs: WorkflowRunState[],
  ctx: WorkflowCommandContext,
): WorkflowRunState[] {
  const sessionId = currentSessionId(ctx);
  if (sessionId === undefined) return runs;
  return runs.filter((run) => run.sessionId === sessionId);
}

async function resumeStoppedWorkflow(
  ctx: WorkflowCommandContext,
  pi: RegisterWorkflowsCommandPi,
  store: WorkflowRunStore,
  rootDir: string,
  runId: string,
  options: RegisterWorkflowsCommandOptions,
): Promise<void> {
  const current = await store.readRun(runId);
  if (current.status === "error") {
    ctx.ui.notify(current.error.message, "error");
    return;
  }

  if (current.value.status !== "stopped") {
    ctx.ui.notify(`Only stopped workflow runs can be resumed this way.`, "warning");
    return;
  }

  const launch = await (options.launchWorkflow ?? launchWorkflow)(
    {
      scriptPath: current.value.scriptPath,
      resumeFromRunId: current.value.runId,
      args: current.value.args,
    },
    await resumeStoppedLaunchOptions(ctx, pi, rootDir),
  );

  if (launch.status === "error") {
    ctx.ui.notify(launch.error.message, "error");
    return;
  }

  ctx.ui.notify(
    `Resumed workflow '${current.value.workflowName}' as ${launch.value.runId}.`,
    "info",
  );
}

function resumeStoppedLaunchOptions(
  ctx: WorkflowCommandContext,
  pi: RegisterWorkflowsCommandPi,
  rootDir: string,
): Promise<WorkflowLaunchOptions> {
  return buildWorkflowLaunchOptions(ctx, pi, {
    rootDir,
    triggerSource: "manual",
    notifyTerminal:
      pi.sendMessage === undefined
        ? undefined
        : async (notification) => {
            const { message, delivery } = prepareWorkflowNotification(notification);
            await pi.sendMessage?.(message, delivery);
          },
  });
}

async function controlWorkflow(
  ctx: WorkflowCommandContext,
  store: WorkflowRunStore,
  runId: string,
  action: string,
  invoke: (
    controller: WorkflowRunController,
  ) => Promise<Result<WorkflowRunState, WorkflowRunControllerError>>,
): Promise<void> {
  const control = getWorkflowRunControl(runId);
  if (control === undefined) {
    ctx.ui.notify(`Could not ${action}: no live runtime control is available.`, "warning");
    return;
  }

  const result = await invoke(new WorkflowRunController({ store, control }));
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
