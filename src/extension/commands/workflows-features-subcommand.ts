// The `/workflows features` subcommand: parsing, scope handling, mutation, and
// formatting of workflow feature flags. Fully self-contained; the main
// `/workflows` handler only routes here via isFeatureCommand/handleFeatureCommand.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowCommandHandlerContext } from "#src/extension/commands/context.ts";
import { emitWorkflowCommandOutput as emitCommandOutput } from "#src/extension/commands/command-output.ts";
import {
  defaultProjectWorkflowFeatureConfigPath,
  defaultUserWorkflowFeatureConfigPath,
  writeWorkflowFeatureConfig,
} from "#src/extension/features/config.ts";
import {
  WORKFLOW_FEATURE_SESSION_ENTRY_TYPE,
  resolveWorkflowFeatures,
  workflowFeatureSessionEntryData,
  type ResolvedWorkflowFeatures,
} from "#src/extension/features/resolve.ts";
import {
  WORKFLOW_FEATURE_DEFINITIONS,
  cliFlagNameForWorkflowFeature,
  featureKeyFromPublicName,
  publicNameForWorkflowFeature,
  type WorkflowFeatureKey,
} from "#src/workflows/features/registry.ts";
import { currentSessionId } from "#src/extension/workflow-launch-options.ts";
import type { WorkflowCommandOutputType } from "#src/extension/commands/command-output.ts";

/** The host-API slice the features subcommand actually touches. */
export type WorkflowFeaturesCommandPi = Partial<
  Pick<ExtensionAPI, "appendEntry" | "getFlag" | "events">
>;

export function isFeatureCommand(args: string): boolean {
  return args.trim() === "features" || args.trim().startsWith("features ");
}

export async function handleFeatureCommand(
  args: string,
  ctx: WorkflowCommandHandlerContext,
  pi: WorkflowFeaturesCommandPi,
  rootDir: string,
): Promise<void> {
  const parsed = parseFeatureCommand(args);
  if (parsed.status === "error") {
    emitOutput(ctx, parsed.message, "error");
    return;
  }

  if (parsed.action === "show") {
    const resolved = await resolveFeaturesForCommand(ctx, pi, rootDir);
    emitOutput(ctx, formatWorkflowFeatures(resolved), "info");
    return;
  }

  if (parsed.scope === "session") {
    if (pi.appendEntry === undefined) {
      emitOutput(
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
    emitOutput(ctx, featureMutationMessage(parsed), "info");
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
    emitOutput(ctx, result.error.message, "error");
    return;
  }
  emitOutput(ctx, featureMutationMessage(parsed), "info");
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
  ctx: WorkflowCommandHandlerContext,
  pi: WorkflowFeaturesCommandPi,
  rootDir: string,
): Promise<ResolvedWorkflowFeatures> {
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

function cliFlagsForFeatures(pi: WorkflowFeaturesCommandPi): Record<string, boolean | undefined> {
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
  ctx: WorkflowCommandHandlerContext,
): readonly { readonly type?: unknown; readonly customType?: unknown; readonly data?: unknown }[] {
  try {
    return ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function formatWorkflowFeatures(resolved: ResolvedWorkflowFeatures): string {
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

function emitOutput(
  ctx: WorkflowCommandHandlerContext,
  message: string,
  type: WorkflowCommandOutputType,
): void {
  emitCommandOutput(ctx, "workflows", message, type);
}
