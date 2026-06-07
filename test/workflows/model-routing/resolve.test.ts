import { describe, expect, it } from "vitest";
import {
  resolveWorkflowModelHint,
  type WorkflowModelRoutingModel,
} from "#src/workflows/model-routing/resolve.ts";

describe("resolveWorkflowModelHint", () => {
  it("should use an exact requested model and supported thinking level", () => {
    const current = model({ provider: "openai-codex", id: "gpt-5.4-mini" });
    const heavy = model({ provider: "openai-codex", id: "gpt-5.5" });

    const resolved = resolveWorkflowModelHint({
      requestedModel: "openai-codex/gpt-5.5",
      requestedThinkingLevel: "high",
      availableModels: [current, heavy],
      currentModel: current,
      currentThinkingLevel: "low",
    });

    expect(resolved).toMatchObject({
      model: heavy,
      modelReference: "openai-codex/gpt-5.5",
      thinkingLevel: "high",
      warnings: [],
    });
  });

  it("should resolve a unique short model id", () => {
    const current = model({ provider: "openai-codex", id: "gpt-5.4-mini" });
    const spark = model({ provider: "openai-codex", id: "gpt-5.3-codex-spark" });

    const resolved = resolveWorkflowModelHint({
      requestedModel: "gpt-5.3-codex-spark",
      availableModels: [current, spark],
      currentModel: current,
    });

    expect(resolved).toMatchObject({
      model: spark,
      modelReference: "openai-codex/gpt-5.3-codex-spark",
      warnings: [],
    });
  });

  it("should fall back to the current model when the requested model has a typo", () => {
    const current = model({ provider: "openai-codex", id: "gpt-5.5" });

    const resolved = resolveWorkflowModelHint({
      requestedModel: "openai-codex/gpt-5.55",
      requestedThinkingLevel: "high",
      availableModels: [current],
      currentModel: current,
      currentThinkingLevel: "medium",
    });

    expect(resolved).toMatchObject({
      model: current,
      modelReference: "openai-codex/gpt-5.5",
      thinkingLevel: "high",
      warnings: [
        {
          kind: "model-fallback",
          requested: "openai-codex/gpt-5.55",
          effective: "openai-codex/gpt-5.5",
        },
      ],
    });
  });

  it("should fall back to the current model when the requested short id is ambiguous", () => {
    const current = model({ provider: "openai-codex", id: "gpt-5.5" });
    const first = model({ provider: "provider-a", id: "same-id" });
    const second = model({ provider: "provider-b", id: "same-id" });

    const resolved = resolveWorkflowModelHint({
      requestedModel: "same-id",
      availableModels: [current, first, second],
      currentModel: current,
    });

    expect(resolved).toMatchObject({
      model: current,
      modelReference: "openai-codex/gpt-5.5",
      warnings: [
        {
          kind: "model-fallback",
          requested: "same-id",
          effective: "openai-codex/gpt-5.5",
        },
      ],
    });
  });

  it("should fall back to the current thinking level when a requested thinking level is unsupported", () => {
    const current = model({ provider: "openai-codex", id: "gpt-5.4-mini", reasoning: false });

    const resolved = resolveWorkflowModelHint({
      requestedThinkingLevel: "xhigh",
      availableModels: [current],
      currentModel: current,
      currentThinkingLevel: "low",
    });

    expect(resolved).toMatchObject({
      model: current,
      thinkingLevel: "low",
      warnings: [
        {
          kind: "thinking-fallback",
          requested: "xhigh",
          effective: "low",
        },
      ],
    });
  });

  it("should deduplicate repeated fallback warnings by requested and effective value", () => {
    const current = model({ provider: "openai-codex", id: "gpt-5.5" });

    const first = resolveWorkflowModelHint({
      requestedModel: "openai-codex/gpt-5.55",
      availableModels: [current],
      currentModel: current,
      previousWarnings: [],
    });
    const second = resolveWorkflowModelHint({
      requestedModel: "openai-codex/gpt-5.55",
      availableModels: [current],
      currentModel: current,
      previousWarnings: first.warnings,
    });

    expect(first.warnings).toHaveLength(1);
    expect(second.warnings).toEqual([]);
  });
});

function model(overrides: Partial<WorkflowModelRoutingModel> = {}): WorkflowModelRoutingModel {
  return {
    id: "gpt-5.5",
    provider: "openai-codex",
    reasoning: true,
    ...overrides,
  };
}
