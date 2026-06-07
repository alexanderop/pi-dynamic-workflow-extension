import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTHORING_INSTRUCTIONS } from "#src/extension/ultracode/workflow-authoring-prompt.ts";

describe("WORKFLOW_AUTHORING_INSTRUCTIONS", () => {
  it("should require orchestrator planning and context discovery before launch", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("orchestrator planning, do not skip");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Do not launch immediately");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("AGENTS.md");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("spec.md");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("brain/contracts/spec-coverage.md");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Context read: which docs/files");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Agent prompts: what each class");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Verification and synthesis");
  });

  it("should instruct ultracode to use simple object schemas for structured agent output", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Which calls need structured output");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("With `opts.schema`");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("plain JSON object schema");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).not.toContain("Do not pass schema yet");
  });

  it("should teach the default inherited-model behavior and guard model hints behind the experimental flag", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain(
      "Select the desired Pi model before launching the workflow",
    );
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Do not set `model` by default");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("use `thinkingLevel`");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("experimental-model-routing");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).not.toContain("Use cheaper/faster models for fan-out");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).not.toContain(
      "Use stronger models for final synthesis",
    );
  });
});
