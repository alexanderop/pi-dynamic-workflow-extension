import type { AgentOptions } from "#src/workflows/agent/model.ts";
import type { WorkflowFeatureFlags } from "#src/extension/features/registry.ts";
import type { WorkflowMeta } from "#src/workflows/script/model.ts";
import {
  modelReference,
  resolveWorkflowModelHint,
  type WorkflowModelRoutingModel,
  type WorkflowModelRoutingWarning,
} from "./resolve.ts";

export interface WorkflowAgentRoutingContext {
  readonly meta: WorkflowMeta;
  readonly availableModels?: readonly WorkflowModelRoutingModel[];
  readonly currentModelReference?: string;
  readonly currentThinkingLevel?: string;
  readonly previousWarnings?: readonly WorkflowModelRoutingWarning[];
  readonly features?: WorkflowFeatureFlags;
}

export interface EffectiveWorkflowAgentOptions {
  readonly options: AgentOptions;
  readonly warnings: WorkflowModelRoutingWarning[];
  readonly ignoredModelHint: boolean;
}

export function resolveEffectiveAgentOptions(
  agentOptions: AgentOptions,
  context: WorkflowAgentRoutingContext,
): EffectiveWorkflowAgentOptions {
  const phase = context.meta.phases?.find((candidate) => candidate.title === agentOptions.phase);
  const requestedModel = agentOptions.model ?? phase?.model ?? context.meta.model;
  const requestedThinkingLevel =
    agentOptions.thinkingLevel ?? phase?.thinkingLevel ?? context.meta.thinkingLevel;

  if (context.features?.experimentalModelRouting !== true) {
    const resolved = resolveWorkflowModelHint({
      requestedThinkingLevel,
      availableModels: context.availableModels,
      currentModel: findModelByReference(context.availableModels, context.currentModelReference),
      currentModelReference: context.currentModelReference,
      currentThinkingLevel: context.currentThinkingLevel,
      previousWarnings: context.previousWarnings,
    });
    const options: AgentOptions = { ...agentOptions };
    delete options.model;
    if (resolved.modelReference !== undefined) options.model = resolved.modelReference;
    if (resolved.thinkingLevel !== undefined) options.thinkingLevel = resolved.thinkingLevel;
    return {
      options,
      warnings: resolved.warnings,
      ignoredModelHint: isNonDefaultModelHint(requestedModel),
    };
  }

  const resolved = resolveWorkflowModelHint({
    requestedModel,
    requestedThinkingLevel,
    availableModels: context.availableModels,
    currentModel: findModelByReference(context.availableModels, context.currentModelReference),
    currentModelReference: context.currentModelReference,
    currentThinkingLevel: context.currentThinkingLevel,
    previousWarnings: context.previousWarnings,
  });
  const options: AgentOptions = { ...agentOptions };
  if (resolved.modelReference !== undefined) options.model = resolved.modelReference;
  if (resolved.thinkingLevel !== undefined) options.thinkingLevel = resolved.thinkingLevel;
  return { options, warnings: resolved.warnings, ignoredModelHint: false };
}

export function isNonDefaultModelHint(model: string | undefined): boolean {
  return model !== undefined && model.trim().length > 0 && model.trim().toLowerCase() !== "default";
}

function findModelByReference<TModel extends WorkflowModelRoutingModel>(
  models: readonly TModel[] | undefined,
  reference: string | undefined,
): TModel | undefined {
  if (models === undefined || reference === undefined) return undefined;
  return models.find((model) => referencesEqual(reference, modelReference(model)));
}

function referencesEqual(left: string | undefined, right: string | undefined): boolean {
  return left?.trim().toLowerCase() === right?.trim().toLowerCase();
}
