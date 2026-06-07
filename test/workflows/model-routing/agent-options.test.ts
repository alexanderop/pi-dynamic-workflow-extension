import { describe, expect, it } from "vitest";
import { resolveEffectiveAgentOptions } from "#src/workflows/model-routing/agent-options.ts";
import type { WorkflowMeta } from "#src/workflows/script/model.ts";

const baseMeta: WorkflowMeta = {
  name: "routing",
  description: "Route model and thinking hints",
};

describe("resolveEffectiveAgentOptions", () => {
  it("should let phase model and thinking hints override workflow defaults", () => {
    const resolved = resolveEffectiveAgentOptions(
      { label: "synthesis", phase: "Synthesize" },
      {
        meta: {
          ...baseMeta,
          model: "openai-codex/gpt-5.4-mini",
          thinkingLevel: "low",
          phases: [
            { title: "Scout", model: "openai-codex/gpt-5.4-mini", thinkingLevel: "low" },
            { title: "Synthesize", model: "openai-codex/gpt-5.5", thinkingLevel: "high" },
          ],
        },
        features: { experimentalModelRouting: true },
      },
    );

    expect(resolved).toEqual({
      options: {
        label: "synthesis",
        phase: "Synthesize",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "high",
      },
      warnings: [],
      ignoredModelHint: false,
    });
  });

  it("should let explicit agent model and thinking hints override phase hints", () => {
    const resolved = resolveEffectiveAgentOptions(
      {
        label: "override",
        phase: "Review",
        model: "openai-codex/gpt-5.3-codex-spark",
        thinkingLevel: "minimal",
      },
      {
        meta: {
          ...baseMeta,
          model: "openai-codex/gpt-5.4-mini",
          thinkingLevel: "low",
          phases: [{ title: "Review", model: "openai-codex/gpt-5.5", thinkingLevel: "high" }],
        },
        features: { experimentalModelRouting: true },
      },
    );

    expect(resolved).toEqual({
      options: {
        label: "override",
        phase: "Review",
        model: "openai-codex/gpt-5.3-codex-spark",
        thinkingLevel: "minimal",
      },
      warnings: [],
      ignoredModelHint: false,
    });
  });

  it("should use current Pi defaults when soft hints cannot be resolved", () => {
    const resolved = resolveEffectiveAgentOptions(
      { label: "scan", model: "openai-codex/gpt-5.55", thinkingLevel: "hihg" },
      {
        meta: baseMeta,
        availableModels: [{ provider: "openai-codex", id: "gpt-5.5" }],
        currentModelReference: "openai-codex/gpt-5.5",
        currentThinkingLevel: "high",
        features: { experimentalModelRouting: true },
      },
    );

    expect(resolved).toEqual({
      options: {
        label: "scan",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "high",
      },
      warnings: [
        {
          kind: "model-fallback",
          requested: "openai-codex/gpt-5.55",
          effective: "openai-codex/gpt-5.5",
        },
        { kind: "thinking-fallback", requested: "hihg", effective: "high" },
      ],
      ignoredModelHint: false,
    });
  });
});
