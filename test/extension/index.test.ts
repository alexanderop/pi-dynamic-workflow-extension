import { describe, expect, it, vi } from "vitest";
import dynamicWorkflowExtension from "../../src/extension/index.ts";

describe("dynamicWorkflowExtension", () => {
  it("should register the workflows command when extension loads", () => {
    const registerCommand = vi.fn();

    dynamicWorkflowExtension({
      registerCommand,
    } as any);

    expect(registerCommand).toHaveBeenCalledWith(
      "workflows",
      expect.objectContaining({
        description: "Show dynamic workflow runs",
        handler: expect.any(Function),
      }),
    );
  });
});
