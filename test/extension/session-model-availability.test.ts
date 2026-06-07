import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  formatSessionModelAvailability,
  registerSessionModelAvailability,
} from "#src/extension/session-model-availability.ts";
import { fakePi } from "../support.ts";

describe("session model availability", () => {
  it("should notify on session start with auth-configured models and thinking modes", () => {
    const on = vi.fn<(...args: unknown[]) => void>();
    const getThinkingLevel = vi.fn<() => "high">(() => "high");
    registerSessionModelAvailability(
      fakePi({
        on,
        getThinkingLevel,
      }),
    );

    const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1] as
      | ((event: unknown, ctx: unknown) => void)
      | undefined;
    expect(sessionStart).toBeDefined();

    const notify = vi.fn<(...args: unknown[]) => void>();
    const current = model({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
    });

    sessionStart?.(
      { type: "session_start", reason: "startup" },
      {
        hasUI: true,
        ui: { notify },
        model: current,
        modelRegistry: {
          getAvailable: () => [
            model({ provider: "openai", id: "gpt-4.1", reasoning: false }),
            current,
          ],
          getError: () => undefined,
        },
      },
    );

    const message = String(notify.mock.calls[0]?.[0]);
    expect(message).toContain("Available Pi models (2 auth-configured):");
    expect(message).toContain(
      "Current: anthropic/claude-sonnet-4-5 (Claude Sonnet 4.5) · current thinking: high",
    );
    expect(message).toContain(
      "- anthropic/claude-sonnet-4-5 (Claude Sonnet 4.5) — thinking: off, minimal, low, medium, high, xhigh",
    );
    expect(message).toContain("- openai/gpt-4.1 — thinking: off");
    expect(notify).toHaveBeenCalledWith(message, "info");
  });

  it("should format guidance when no auth-configured models are available", () => {
    expect(formatSessionModelAvailability({ models: [] })).toBe(
      "No Pi models with configured auth are available. Use /login or configure ~/.pi/agent/models.json.",
    );
  });

  it("should not notify in headless modes", () => {
    const on = vi.fn<(...args: unknown[]) => void>();
    registerSessionModelAvailability(
      fakePi({
        on,
      }),
    );
    const sessionStart = on.mock.calls.find(([event]) => event === "session_start")?.[1] as
      | ((event: unknown, ctx: unknown) => void)
      | undefined;
    const notify = vi.fn<(...args: unknown[]) => void>();

    sessionStart?.(
      { type: "session_start", reason: "startup" },
      {
        hasUI: false,
        ui: { notify },
        modelRegistry: { getAvailable: () => [model()], getError: () => undefined },
      },
    );

    expect(notify).not.toHaveBeenCalled();
  });
});

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  const id = overrides.id ?? "claude-test";
  return {
    id,
    name: overrides.name ?? id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32000,
    ...overrides,
  };
}
