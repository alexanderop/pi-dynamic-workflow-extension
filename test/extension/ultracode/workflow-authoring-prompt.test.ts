import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTHORING_INSTRUCTIONS } from "#src/extension/ultracode/workflow-authoring-prompt.ts";

describe("WORKFLOW_AUTHORING_INSTRUCTIONS", () => {
  it("should instruct ultracode to use simple object schemas for structured agent output", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Which calls need structured output");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("With `opts.schema`");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("plain JSON object schema");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).not.toContain("Do not pass schema yet");
  });
});
