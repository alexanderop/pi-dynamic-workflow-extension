import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTHORING_INSTRUCTIONS } from "#src/extension/ultracode/workflow-authoring-prompt.ts";

describe("WORKFLOW_AUTHORING_INSTRUCTIONS", () => {
  it("should instruct ultracode to use simple object schemas for structured agent output", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Which calls need structured output");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("With `opts.schema`");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("plain JSON object schema");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).not.toContain("Do not pass schema yet");
  });

  it("should teach soft model routing for cheap fan-out and heavy synthesis", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Use cheaper/faster models for fan-out");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Use stronger models for final synthesis");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain(
      "exact model id from the available Pi models list",
    );
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain(
      "invalid or unavailable model/thinking hints fall back",
    );
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("openai-codex/gpt-5.4-mini");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("openai-codex/gpt-5.5");
  });
});
