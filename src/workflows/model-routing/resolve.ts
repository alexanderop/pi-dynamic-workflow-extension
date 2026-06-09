import type { WorkflowThinkingLevel } from "#src/workflows/agent/model.ts";

export interface WorkflowModelRoutingModel {
  readonly id: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Partial<Record<WorkflowThinkingLevel, string | null>>;
}

export type WorkflowModelRoutingWarning =
  | {
      readonly kind: "model-fallback";
      readonly requested: string;
      readonly effective: string;
    }
  | {
      readonly kind: "thinking-fallback";
      readonly requested: string;
      readonly effective: string;
    };

export interface WorkflowModelHintResolutionOptions<TModel extends WorkflowModelRoutingModel> {
  readonly requestedModel?: string;
  readonly requestedThinkingLevel?: string;
  readonly availableModels?: readonly TModel[];
  readonly currentModel?: TModel;
  readonly currentModelReference?: string;
  readonly currentThinkingLevel?: string;
  readonly previousWarnings?: readonly WorkflowModelRoutingWarning[];
}

export interface WorkflowModelHintResolution<TModel extends WorkflowModelRoutingModel> {
  readonly model?: TModel;
  readonly modelReference?: string;
  readonly thinkingLevel?: WorkflowThinkingLevel;
  readonly warnings: WorkflowModelRoutingWarning[];
}

export function resolveWorkflowModelHint<TModel extends WorkflowModelRoutingModel>(
  options: WorkflowModelHintResolutionOptions<TModel>,
): WorkflowModelHintResolution<TModel> {
  const modelResolution = resolveModel(options);
  const thinkingResolution = resolveThinkingLevel({
    requestedThinkingLevel: options.requestedThinkingLevel,
    currentThinkingLevel: options.currentThinkingLevel,
    model: modelResolution.model,
  });
  const warnings = dedupeWarnings(
    [...modelResolution.warnings, ...thinkingResolution.warnings],
    options.previousWarnings ?? [],
  );

  return {
    model: modelResolution.model,
    modelReference: modelResolution.modelReference,
    thinkingLevel: thinkingResolution.thinkingLevel,
    warnings,
  };
}

function resolveModel<TModel extends WorkflowModelRoutingModel>(
  options: WorkflowModelHintResolutionOptions<TModel>,
): {
  readonly model?: TModel;
  readonly modelReference?: string;
  readonly warnings: WorkflowModelRoutingWarning[];
} {
  const currentReference =
    options.currentModelReference ??
    modelReference(options.currentModel) ??
    normalizeReference(options.requestedModel);
  if (options.requestedModel === undefined || isDefaultModelPlaceholder(options.requestedModel)) {
    return { model: options.currentModel, modelReference: currentReference, warnings: [] };
  }

  const requested = options.requestedModel;
  const available = options.availableModels;
  if (available === undefined || available.length === 0) {
    return {
      model: options.currentModel,
      modelReference: normalizeReference(requested),
      warnings: [],
    };
  }

  const exact = available.find((model) => sameReference(requested, modelReference(model)));
  if (exact !== undefined)
    return { model: exact, modelReference: modelReference(exact), warnings: [] };

  const shortMatches = available.filter((model) => sameReference(requested, model.id));
  if (shortMatches.length === 1) {
    const model = shortMatches[0]!;
    return { model, modelReference: modelReference(model), warnings: [] };
  }

  return {
    model: options.currentModel,
    modelReference: currentReference,
    warnings:
      currentReference === undefined
        ? []
        : [{ kind: "model-fallback", requested, effective: currentReference }],
  };
}

function resolveThinkingLevel<TModel extends WorkflowModelRoutingModel>({
  requestedThinkingLevel,
  currentThinkingLevel,
  model,
}: {
  readonly requestedThinkingLevel?: string;
  readonly currentThinkingLevel?: string;
  readonly model?: TModel;
}): {
  readonly thinkingLevel?: WorkflowThinkingLevel;
  readonly warnings: WorkflowModelRoutingWarning[];
} {
  if (requestedThinkingLevel === undefined) {
    return {
      thinkingLevel: isWorkflowThinkingLevel(currentThinkingLevel)
        ? currentThinkingLevel
        : undefined,
      warnings: [],
    };
  }

  if (
    isWorkflowThinkingLevel(requestedThinkingLevel) &&
    supportsThinkingLevel(model, requestedThinkingLevel)
  ) {
    return { thinkingLevel: requestedThinkingLevel, warnings: [] };
  }

  const fallback = isWorkflowThinkingLevel(currentThinkingLevel) ? currentThinkingLevel : undefined;
  return {
    thinkingLevel: fallback,
    warnings:
      fallback === undefined
        ? []
        : [{ kind: "thinking-fallback", requested: requestedThinkingLevel, effective: fallback }],
  };
}

function supportsThinkingLevel(
  model: WorkflowModelRoutingModel | undefined,
  level: WorkflowThinkingLevel,
): boolean {
  if (model === undefined) return true;
  if (model.reasoning === false) return level === "off";
  return model.thinkingLevelMap?.[level] !== null;
}

function dedupeWarnings(
  next: readonly WorkflowModelRoutingWarning[],
  previous: readonly WorkflowModelRoutingWarning[],
): WorkflowModelRoutingWarning[] {
  const seen = new Set(previous.map(warningKey));
  return next.filter((warning) => {
    const key = warningKey(warning);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function warningKey(warning: WorkflowModelRoutingWarning): string {
  return `${warning.kind}:${warning.requested}:${warning.effective}`;
}

export function modelReference(
  model: Pick<WorkflowModelRoutingModel, "provider" | "id"> | undefined,
): string | undefined {
  if (model === undefined) return undefined;
  return `${model.provider}/${model.id}`;
}

export function isWorkflowThinkingLevel(value: unknown): value is WorkflowThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function sameReference(left: string | undefined, right: string | undefined): boolean {
  return normalizeReference(left) === normalizeReference(right);
}

function normalizeReference(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "" ? undefined : normalized;
}

function isDefaultModelPlaceholder(model: string): boolean {
  return model.trim().toLowerCase() === "default";
}
