import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { createPiWorkflowAgentRunner } from "#src/workflows/agent/pi-runner.ts";
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
  readonly sessionManager?: { readonly getSessionId?: () => string | undefined };
}

/** The host-API slice that reports the active thinking level, when available. */
export interface WorkflowThinkingProvider {
  readonly getThinkingLevel?: () => WorkflowLaunchOptions["defaultThinkingLevel"];
}

/** Per-launch values that differ between the tool, command, and resume paths. */
export interface WorkflowLaunchOverrides {
  readonly rootDir: string;
  readonly triggerSource: WorkflowRunTriggerSource;
  readonly operations?: WorkflowLaunchOptions["operations"];
  readonly notifyTerminal?: WorkflowLaunchOptions["notifyTerminal"];
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
  return {
    rootDir: overrides.rootDir,
    operations: overrides.operations,
    sessionId: currentSessionId(ctx),
    triggerSource: overrides.triggerSource,
    cwd: ctx.cwd,
    defaultModel: currentModelReference(ctx.model),
    defaultThinkingLevel: thinkingLevel,
    availableModels: await currentAvailableModels(ctx),
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

export function currentModelReference(model: unknown): string | undefined {
  if (typeof model !== "object" || model === null) return undefined;
  const candidate = model as { readonly provider?: unknown; readonly id?: unknown };
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return undefined;
  if (typeof candidate.provider !== "string" || candidate.provider.length === 0)
    return candidate.id;
  return `${candidate.provider}/${candidate.id}`;
}
