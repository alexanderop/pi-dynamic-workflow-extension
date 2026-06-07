import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { createPiWorkflowAgentRunner } from "#src/workflows/agent/pi-runner.ts";
import {
  WORKFLOW_FEATURE_DEFINITIONS,
  cliFlagNameForWorkflowFeature,
} from "#src/extension/features/registry.ts";
import { resolveWorkflowFeatures } from "#src/extension/features/resolve.ts";
import type { WorkflowLaunchOptions } from "#src/workflows/launch/launcher.ts";
import type { WorkflowRunTriggerSource } from "#src/workflows/run/model.ts";

type AvailableModels = WorkflowLaunchOptions["availableModels"];

/** The host-context fields workflow launch options are derived from. */
export interface WorkflowLaunchContext {
  readonly cwd: string;
  readonly model?: CreateAgentSessionOptions["model"];
  readonly modelRegistry?: CreateAgentSessionOptions["modelRegistry"] & {
    readonly getAvailable?: () => Promise<AvailableModels> | AvailableModels;
  };
  readonly sessionManager?: {
    readonly getSessionId?: () => string | undefined;
    readonly getEntries?: () => readonly {
      readonly type?: unknown;
      readonly customType?: unknown;
      readonly data?: unknown;
    }[];
  };
  readonly featureConfigPaths?: {
    readonly userConfigPath?: string;
    readonly projectConfigPath?: string;
  };
  readonly env?: Record<string, string | undefined>;
}

/** The host-API slice that reports the active thinking level, when available. */
export interface WorkflowThinkingProvider {
  readonly getThinkingLevel?: () => WorkflowLaunchOptions["defaultThinkingLevel"];
  readonly getFlag?: (name: string) => unknown;
  readonly events?: Parameters<typeof resolveWorkflowFeatures>[0]["events"];
}

/** Per-launch values that differ between the tool, command, and resume paths. */
export interface WorkflowLaunchOverrides {
  readonly rootDir: string;
  readonly triggerSource: WorkflowRunTriggerSource;
  readonly operations?: WorkflowLaunchOptions["operations"];
  readonly notifyTerminal?: WorkflowLaunchOptions["notifyTerminal"];
  readonly features?: WorkflowLaunchOptions["features"];
}

/**
 * Build {@link WorkflowLaunchOptions} from the host context. Shared by every
 * launch site so model/thinking/session/scheduler derivation stays in one place;
 * callers only supply what genuinely varies via {@link WorkflowLaunchOverrides}.
 */
export async function buildWorkflowLaunchOptions(
  ctx: WorkflowLaunchContext,
  pi: WorkflowThinkingProvider,
  overrides: WorkflowLaunchOverrides,
): Promise<WorkflowLaunchOptions> {
  const thinkingLevel = currentThinkingLevel(pi);
  const resolvedFeatures = await resolveWorkflowFeatures({
    cwd: ctx.cwd,
    workflowRoot: overrides.rootDir,
    sessionId: currentSessionId(ctx),
    userConfigPath: ctx.featureConfigPaths?.userConfigPath,
    projectConfigPath: ctx.featureConfigPaths?.projectConfigPath,
    env: ctx.env,
    cliFlags: currentCliFlags(pi),
    sessionEntries: currentSessionEntries(ctx),
    overrides: overrides.features,
    events: pi.events,
  });
  return {
    rootDir: overrides.rootDir,
    operations: overrides.operations,
    sessionId: currentSessionId(ctx),
    triggerSource: overrides.triggerSource,
    cwd: ctx.cwd,
    defaultModel: currentModelReference(ctx.model),
    defaultThinkingLevel: thinkingLevel,
    availableModels: await currentAvailableModels(ctx),
    features: resolvedFeatures.features,
    featureDecisions: resolvedFeatures.decisions,
    schedulerRunner: createPiWorkflowAgentRunner({
      cwd: ctx.cwd,
      model: ctx.model,
      thinkingLevel,
      modelRegistry: ctx.modelRegistry,
    }),
    notifyTerminal: overrides.notifyTerminal,
  };
}

export function currentSessionId(ctx: {
  readonly sessionManager?: { readonly getSessionId?: () => string | undefined };
}): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

export function currentThinkingLevel(
  pi: WorkflowThinkingProvider,
): WorkflowLaunchOptions["defaultThinkingLevel"] {
  try {
    return pi.getThinkingLevel?.();
  } catch {
    return undefined;
  }
}

export async function currentAvailableModels(ctx: {
  readonly modelRegistry?: {
    readonly getAvailable?: () => Promise<AvailableModels> | AvailableModels;
  };
}): Promise<AvailableModels> {
  try {
    return await Promise.resolve(ctx.modelRegistry?.getAvailable?.());
  } catch {
    return undefined;
  }
}

function currentSessionEntries(ctx: WorkflowLaunchContext): readonly {
  readonly type?: unknown;
  readonly customType?: unknown;
  readonly data?: unknown;
}[] {
  try {
    return ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function currentCliFlags(pi: WorkflowThinkingProvider): Record<string, boolean | undefined> {
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

export function currentModelReference(model: unknown): string | undefined {
  if (typeof model !== "object" || model === null) return undefined;
  const candidate = model as { readonly provider?: unknown; readonly id?: unknown };
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return undefined;
  if (typeof candidate.provider !== "string" || candidate.provider.length === 0)
    return candidate.id;
  return `${candidate.provider}/${candidate.id}`;
}
