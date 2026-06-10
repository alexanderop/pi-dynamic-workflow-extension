// Registers the `/workflows` command: routes the features subcommand, loads
// runs and saved workflows, and shows either the interactive TUI or the
// plain-text overview. Feature-flag handling lives in
// workflows-features-subcommand.ts; text formatting in workflows-overview-format.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowCommandHandlerContext } from "#src/extension/commands/context.ts";
import { showWorkflowsTui } from "#src/extension/tui/workflows-view.ts";
import { getWorkflowRunControl } from "#src/workflows/run/control-registry.ts";
import {
  WorkflowRunController,
  type WorkflowRunControllerError,
} from "#src/workflows/run/controller.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowRunStoreError } from "#src/workflows/run/store.ts";
import type { Result } from "#src/workflows/result.ts";
import { workflowRootDirForCwd } from "#src/workflows/run/root-dir.ts";
import {
  launchWorkflow,
  type WorkflowLauncher,
  type WorkflowLaunchOptions,
} from "#src/workflows/launch/launcher.ts";
import {
  buildWorkflowLaunchOptions,
  currentSessionId,
} from "#src/extension/workflow-launch-options.ts";
import { terminalNotifier } from "#src/extension/workflow-notifications.ts";
import {
  emitWorkflowCommandOutput as emitCommandOutput,
  resolveWorkflowCommandMode,
  type WorkflowCommandOutputType,
} from "#src/extension/commands/command-output.ts";
import {
  handleFeatureCommand,
  isFeatureCommand,
} from "#src/extension/commands/workflows-features-subcommand.ts";
import { formatWorkflowsOverview } from "#src/extension/commands/workflows-overview-format.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { listSavedWorkflows } from "#src/workflows/saved/list.ts";
import { saveRunScript } from "#src/workflows/saved/save-run-script.ts";
import {
  GENERIC_WORKFLOW_COMMAND_NAME,
  type SavedWorkflowCommandRegistration,
  type SavedWorkflowCommandRegistry,
} from "#src/extension/commands/saved-workflow-commands.ts";
import type { WorkflowSavedWorkflowLocations } from "#src/workflows/saved/resolver.ts";

type WorkflowCommandContext = WorkflowCommandHandlerContext & {
  readonly savedWorkflowDirs?: WorkflowSavedWorkflowLocations;
};

export interface RegisterWorkflowsCommandOptions {
  readonly launchWorkflow?: WorkflowLauncher;
  /**
   * Registry used to register a saved workflow as a slash command immediately
   * after `/workflows` saves a run. When provided, the save notification
   * reports whether the matching direct command was registered or skipped.
   */
  readonly savedCommandRegistry?: SavedWorkflowCommandRegistry;
}

type RegisterWorkflowsCommandPi = Pick<ExtensionAPI, "registerCommand"> &
  Partial<
    Pick<ExtensionAPI, "sendMessage" | "getThinkingLevel" | "appendEntry" | "getFlag" | "events">
  >;

export function registerWorkflowsCommand(
  pi: RegisterWorkflowsCommandPi,
  options: RegisterWorkflowsCommandOptions = {},
): void {
  pi.registerCommand("workflows", {
    description: "Show dynamic workflow runs",
    handler: async (args, ctx) => {
      const commandCtx = ctx as WorkflowCommandContext;
      const rootDir = workflowRootDirForCwd(commandCtx.cwd);

      if (isFeatureCommand(args)) {
        await handleFeatureCommand(args, commandCtx, pi, rootDir);
        return;
      }

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
          ...buildWorkflowsTuiCallbacks(commandCtx, pi, store, rootDir, options),
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

/**
 * Builds the `/workflows` TUI callback set. Pulled out of the handler so the
 * happy path reads route → load → show instead of seven inline closures.
 */
function buildWorkflowsTuiCallbacks(
  ctx: WorkflowCommandContext,
  pi: RegisterWorkflowsCommandPi,
  store: WorkflowRunStore,
  rootDir: string,
  options: RegisterWorkflowsCommandOptions,
): {
  loadRuns: () => Promise<Result<WorkflowRunState[], WorkflowRunStoreError>>;
  onPauseRun: (runId: string) => void;
  onResumeRun: (runId: string) => void;
  onResumeStoppedRun: (runId: string) => Promise<void>;
  onStopRun: (runId: string) => void;
  onStopAgent: (runId: string, agentId: string) => void;
  onSaveRun: (runId: string) => void;
} {
  return {
    loadRuns: async () => {
      const latest = await store.listRuns();
      if (latest.status === "error") return latest;
      return { status: "ok", value: filterRunsForCurrentSession(latest.value, ctx) };
    },
    onPauseRun: (runId) => {
      void controlWorkflow(ctx, store, runId, `pause workflow run '${runId}'`, (c) =>
        c.pause(runId),
      );
    },
    onResumeRun: (runId) => {
      void controlWorkflow(ctx, store, runId, `resume workflow run '${runId}'`, (c) =>
        c.resume(runId),
      );
    },
    onResumeStoppedRun: async (runId) => {
      await resumeStoppedWorkflow(ctx, pi, store, rootDir, runId, options);
    },
    onStopRun: (runId) => {
      void controlWorkflow(ctx, store, runId, `stop workflow run '${runId}'`, (c) =>
        c.stopRun(runId),
      );
    },
    onStopAgent: (runId, agentId) => {
      void controlWorkflow(
        ctx,
        store,
        runId,
        `stop workflow agent '${agentId}' in run '${runId}'`,
        (c) => c.stopAgent(runId, agentId),
      );
    },
    onSaveRun: (runId) => {
      void saveWorkflowRunScript(ctx, rootDir, runId, options);
    },
  };
}

function filterRunsForCurrentSession(
  runs: WorkflowRunState[],
  ctx: WorkflowCommandContext,
): WorkflowRunState[] {
  const sessionId = currentSessionId(ctx);
  if (sessionId === undefined) return runs;
  return runs.filter((run) => run.sessionId === sessionId);
}

async function saveWorkflowRunScript(
  ctx: WorkflowCommandContext,
  rootDir: string,
  runId: string,
  options: RegisterWorkflowsCommandOptions,
): Promise<void> {
  const result = await saveRunScript(
    { runId },
    { rootDir, savedWorkflowDirs: ctx.savedWorkflowDirs },
  );
  if (result.status === "error") {
    ctx.ui.notify(result.error.message, "error");
    return;
  }

  const registration = await registerSavedCommand(ctx, options.savedCommandRegistry, result.value);
  ctx.ui.notify(formatSaveNotification(result.value.name, result.value.path, registration), "info");
}

async function registerSavedCommand(
  ctx: WorkflowCommandContext,
  registry: SavedWorkflowCommandRegistry | undefined,
  saved: { readonly name: string },
): Promise<SavedWorkflowCommandRegistration | undefined> {
  if (registry === undefined) return undefined;
  return registry.registerSavedWorkflowByName(ctx, saved.name);
}

function formatSaveNotification(
  name: string,
  path: string,
  registration: SavedWorkflowCommandRegistration | undefined,
): string {
  if (registration?.status === "registered") {
    return `Saved workflow '${name}' to ${path} and registered /${name}.`;
  }
  if (registration?.reason !== undefined) {
    return `Saved workflow '${name}' to ${path}. ${registration.reason}`;
  }
  return `Saved workflow '${name}' to ${path}. Launch with /${GENERIC_WORKFLOW_COMMAND_NAME} ${name} <args> or Workflow({ name: "${name}" }).`;
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
    notifyTerminal: terminalNotifier(pi.sendMessage),
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
  return resolveWorkflowCommandMode(ctx) === "tui" && typeof ctx.ui.custom === "function";
}

function emitWorkflowCommandOutput(
  ctx: WorkflowCommandContext,
  message: string,
  type: WorkflowCommandOutputType,
): void {
  emitCommandOutput(ctx, "workflows", message, type);
}
