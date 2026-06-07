import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export function registerSessionModelAvailability(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI === false) return;
    const message = formatSessionModelAvailability({
      models: ctx.modelRegistry.getAvailable(),
      currentModel: ctx.model,
      currentThinkingLevel: pi.getThinkingLevel(),
      loadError: ctx.modelRegistry.getError(),
    });
    ctx.ui.notify(message, "info");
  });
}

export interface SessionModelAvailabilitySummary {
  readonly models: readonly Model<any>[];
  readonly currentModel?: Model<any>;
  readonly currentThinkingLevel?: ModelThinkingLevel;
  readonly loadError?: string;
}

export function formatSessionModelAvailability(summary: SessionModelAvailabilitySummary): string {
  const lines: string[] = [];

  if (summary.loadError) {
    lines.push(`Warning: errors loading models.json: ${summary.loadError}`);
  }

  if (summary.models.length === 0) {
    lines.push(
      "No Pi models with configured auth are available. Use /login or configure ~/.pi/agent/models.json.",
    );
    return lines.join("\n");
  }

  lines.push(`Available Pi models (${summary.models.length} auth-configured):`);

  const currentModel = summary.currentModel;
  if (currentModel !== undefined) {
    lines.push(
      `Current: ${formatModelReference(currentModel)}${formatCurrentThinking(summary.currentThinkingLevel)}`,
    );
  }

  const sorted = summary.models.toSorted(compareModels);
  for (const model of sorted) {
    lines.push(`- ${formatModelReference(model)} — thinking: ${formatThinkingModes(model)}`);
  }

  return lines.join("\n");
}

function formatCurrentThinking(level: ModelThinkingLevel | undefined): string {
  if (level === undefined) return "";
  return ` · current thinking: ${level}`;
}

function formatModelReference(model: Model<any>): string {
  const reference = `${model.provider}/${model.id}`;
  if (model.name === model.id || model.name.length === 0) return reference;
  return `${reference} (${model.name})`;
}

function formatThinkingModes(model: Model<any>): string {
  return getSupportedThinkingLevels(model).join(", ");
}

function compareModels(left: Model<any>, right: Model<any>): number {
  const provider = left.provider.localeCompare(right.provider);
  if (provider !== 0) return provider;
  return left.id.localeCompare(right.id);
}
