import { describe, expect, it } from "vitest";
import { piSessionEventToWorkflowLiveEvent } from "#src/extension/agent/pi-live-events.ts";

describe("piSessionEventToWorkflowLiveEvent message_end", () => {
  it("should map an assistant message_end with usage.totalTokens to a usage_update", () => {
    const event = piSessionEventToWorkflowLiveEvent({
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          input: 100,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 140,
          cost: {},
        },
      },
    });

    expect(event).toMatchObject({ type: "usage_update", tokens: 140 });
  });

  it("should ignore a message_end whose message is not an assistant message", () => {
    const event = piSessionEventToWorkflowLiveEvent({
      type: "message_end",
      message: { role: "user", usage: { totalTokens: 140 } },
    });

    expect(event).toBeUndefined();
  });

  it("should ignore an assistant message_end with no usage", () => {
    const event = piSessionEventToWorkflowLiveEvent({
      type: "message_end",
      message: { role: "assistant" },
    });

    expect(event).toBeUndefined();
  });
});
