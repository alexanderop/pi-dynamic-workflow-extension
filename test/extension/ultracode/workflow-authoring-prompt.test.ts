import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTHORING_INSTRUCTIONS } from "#src/extension/ultracode/workflow-authoring-prompt.ts";

describe("WORKFLOW_AUTHORING_INSTRUCTIONS", () => {
  it("should explain the orchestrator mental model and when workflows are warranted", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("custom task harness/orchestrator");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("The script is the conductor");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("separate context windows");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("agentic laziness");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("self-preferential bias");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("goal drift");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("trivial answer or one-line edit");
  });

  it("should require orchestrator planning and context discovery before launch", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("orchestrator planning, do not skip");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Do not launch immediately");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("AGENTS.md");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("spec.md");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("brain/contracts/spec-coverage.md");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).not.toContain(".claude/workflows/");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Why workflow: task class");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Context read: which docs/files");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Agent prompts: what each class");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Verification and synthesis");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Stop condition and budget");
  });

  it("should include concrete reusable workflow shapes without repo-specific filenames", () => {
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Example workflow shapes to adapt");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Review/audit with adversarial verification");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain(
      "Scope/search/fetch/verify/synthesize research",
    );
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("reviewPrompt(d)");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).not.toContain(
      ".claude/workflows/saved-command-review.js",
    );
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).not.toContain("deep-research2.js");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Root-cause or flaky-test investigation");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Tournament/generate-and-filter");
    expect(WORKFLOW_AUTHORING_INSTRUCTIONS).toContain("Classify-and-act / triage");
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
