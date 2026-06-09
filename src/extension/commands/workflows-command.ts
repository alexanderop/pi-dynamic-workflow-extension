import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiWorkflowAgentRunnerOptions } from "#src/extension/agent/pi-runner.ts";
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
import { terminalNotifier } from "#src/extension/workflow-notifications.ts";
import {
  emitWorkflowCommandOutput as emitCommandOutput,
  resolveWorkflowCommandMode,
  type WorkflowCommandMode,
  type WorkflowCommandOutputType,
} from "#src/extension/commands/command-output.ts";
import {
  defaultProjectWorkflowFeatureConfigPath,
  defaultUserWorkflowFeatureConfigPath,
  writeWorkflowFeatureConfig,
} from "#src/extension/features/config.ts";
import {
  WORKFLOW_FEATURE_DEFINITIONS,
  cliFlagNameForWorkflowFeature,
  featureKeyFromPublicName,
  publicNameForWorkflowFeature,
  type WorkflowFeatureKey,
} from "#src/workflows/features/registry.ts";
import {
  WORKFLOW_FEATURE_SESSION_ENTRY_TYPE,
  resolveWorkflowFeatures,
  workflowFeatureSessionEntryData,
} from "#src/extension/features/resolve.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { listSavedWorkflows } from "#src/workflows/saved/list.ts";
import { saveRunScript } from "#src/workflows/saved/save-run-script.ts";
import {
  GENERIC_WORKFLOW_COMMAND_NAME,
  type SavedWorkflowCommandRegistration,
  type SavedWorkflowCommandRegistry,
} from "#src/extension/commands/saved-workflow-commands.ts";
import { formatDuration } from "#src/workflows/view/layout.ts";
import type {
  WorkflowSavedWorkflow,
  WorkflowSavedWorkflowLocations,
} from "#src/workflows/saved/resolver.ts";

type WorkflowCommandContext = ExtensionCommandContext & {
  mode?: WorkflowCommandMode;
  savedWorkflowDirs?: WorkflowSavedWorkflowLocations;
  featureConfigPaths?: {
    readonly userConfigPath?: string;
    readonly projectConfigPath?: string;
  };
  env?: Record<string, string | undefined>;
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
          onSaveRun: (runId) => {
            void saveWorkflowRunScript(commandCtx, rootDir, runId, options);
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

function isFeatureCommand(args: string): boolean {
  return args.trim() === "features" || args.trim().startsWith("features ");
}

async function handleFeatureCommand(
  args: string,
  ctx: WorkflowCommandContext,
  pi: RegisterWorkflowsCommandPi,
  rootDir: string,
): Promise<void> {
  const parsed = parseFeatureCommand(args);
  if (parsed.status === "error") {
    emitWorkflowCommandOutput(ctx, parsed.message, "error");
    return;
  }

  if (parsed.action === "show") {
    const resolved = await resolveFeaturesForCommand(ctx, pi, rootDir);
    emitWorkflowCommandOutput(ctx, formatWorkflowFeatures(resolved), "info");
    return;
  }

  if (parsed.scope === "session") {
    if (pi.appendEntry === undefined) {
      emitWorkflowCommandOutput(
        ctx,
        "Cannot update session workflow features: Pi appendEntry is unavailable.",
        "error",
      );
      return;
    }
    pi.appendEntry(
      WORKFLOW_FEATURE_SESSION_ENTRY_TYPE,
      workflowFeatureSessionEntryData(parsed.key, parsed.action),
    );
    emitWorkflowCommandOutput(ctx, featureMutationMessage(parsed), "info");
    return;
  }

  const path =
    parsed.scope === "project"
      ? (ctx.featureConfigPaths?.projectConfigPath ??
        defaultProjectWorkflowFeatureConfigPath(rootDir))
      : (ctx.featureConfigPaths?.userConfigPath ?? defaultUserWorkflowFeatureConfigPath());
  const result = await writeWorkflowFeatureConfig(path, {
    [parsed.key]: parsed.action === "reset" ? undefined : parsed.action === "enable",
  });
  if (result.status === "error") {
    emitWorkflowCommandOutput(ctx, result.error.message, "error");
    return;
  }
  emitWorkflowCommandOutput(ctx, featureMutationMessage(parsed), "info");
}

type ParsedFeatureCommand =
  | { readonly status: "ok"; readonly action: "show"; readonly scope: "session" }
  | {
      readonly status: "ok";
      readonly action: "enable" | "disable" | "reset";
      readonly key: WorkflowFeatureKey;
      readonly scope: "session" | "project" | "user";
    };

type ParsedFeatureCommandResult =
  | ParsedFeatureCommand
  | { readonly status: "error"; readonly message: string };

function parseFeatureCommand(args: string): ParsedFeatureCommandResult {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== "features")
    return {
      status: "error",
      message:
        "Usage: /workflows features [enable|disable|reset] <feature> [--scope session|project|user]",
    };
  if (tokens.length === 1) return { status: "ok", action: "show", scope: "session" };

  const action = tokens[1];
  if (action !== "enable" && action !== "disable" && action !== "reset") {
    return { status: "error", message: `Unknown workflow features action '${action ?? ""}'.` };
  }

  const publicName = tokens[2];
  if (publicName === undefined) {
    return { status: "error", message: `Missing workflow feature name for '${action}'.` };
  }
  const key = featureKeyFromPublicName(publicName);
  if (key === undefined) {
    return { status: "error", message: `Unknown workflow feature '${publicName}'.` };
  }

  const scope = parseFeatureScope(tokens.slice(3));
  if (scope === undefined) {
    return {
      status: "error",
      message: "Unknown workflow feature scope. Use session, project, or user.",
    };
  }
  return { status: "ok", action, key, scope };
}

function parseFeatureScope(tokens: string[]): "session" | "project" | "user" | undefined {
  let scope: string | undefined = "session";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--scope") {
      scope = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith("--scope=")) {
      scope = token.slice("--scope=".length);
      continue;
    }
    return undefined;
  }
  return scope === "session" || scope === "project" || scope === "user" ? scope : undefined;
}

async function resolveFeaturesForCommand(
  ctx: WorkflowCommandContext,
  pi: RegisterWorkflowsCommandPi,
  rootDir: string,
): Promise<Awaited<ReturnType<typeof resolveWorkflowFeatures>>> {
  return await resolveWorkflowFeatures({
    cwd: ctx.cwd,
    workflowRoot: rootDir,
    sessionId: currentSessionId(ctx),
    userConfigPath: ctx.featureConfigPaths?.userConfigPath,
    projectConfigPath: ctx.featureConfigPaths?.projectConfigPath,
    env: ctx.env,
    cliFlags: cliFlagsForFeatures(pi),
    sessionEntries: safeSessionEntries(ctx),
    events: pi.events,
  });
}

function cliFlagsForFeatures(pi: RegisterWorkflowsCommandPi): Record<string, boolean | undefined> {
  const flags: Record<string, boolean | undefined> = {};
  for (const definition of WORKFLOW_FEATURE_DEFINITIONS) {
    const flagName = cliFlagNameForWorkflowFeature(definition.key);
    try {
      flags[flagName] = pi.getFlag?.(flagName) === true;
    } catch {
      flags[flagName] = undefined;
    }
  }
  return flags;
}

function safeSessionEntries(
  ctx: WorkflowCommandContext,
): readonly { readonly type?: unknown; readonly customType?: unknown; readonly data?: unknown }[] {
  try {
    return ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function formatWorkflowFeatures(
  resolved: Awaited<ReturnType<typeof resolveWorkflowFeatures>>,
): string {
  const decisionByKey = new Map(resolved.decisions.map((decision) => [decision.key, decision]));
  const lines = ["Workflow features"];
  for (const definition of WORKFLOW_FEATURE_DEFINITIONS) {
    const decision = decisionByKey.get(definition.key);
    const value = resolved.features[definition.key] ? "enabled" : "disabled";
    const source = decision?.source ?? "default";
    lines.push(`- ${definition.publicName}: ${value} (${source}, ${definition.stage})`);
    lines.push(`  ${definition.description}`);
  }
  if (resolved.warnings.length > 0) {
    lines.push("", "Warnings:", ...resolved.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

function featureMutationMessage(
  parsed: Extract<ParsedFeatureCommand, { readonly action: "enable" | "disable" | "reset" }>,
): string {
  const verb =
    parsed.action === "enable" ? "Enabled" : parsed.action === "disable" ? "Disabled" : "Reset";
  return `${verb} ${publicNameForWorkflowFeature(parsed.key)} for ${featureScopeLabel(parsed.scope)}.`;
}

function featureScopeLabel(scope: "session" | "project" | "user"): string {
  if (scope === "session") return "this session";
  if (scope === "project") return "project config";
  return "user config";
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
