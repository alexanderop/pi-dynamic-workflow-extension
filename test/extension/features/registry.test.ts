import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_FEATURES,
  WORKFLOW_FEATURE_DEFINITIONS,
  envVarNameForWorkflowFeature,
  featureKeyFromPublicName,
  publicNameForWorkflowFeature,
  cliFlagNameForWorkflowFeature,
} from "#src/extension/features/registry.ts";

describe("workflow feature registry", () => {
  it("should expose the experimental model routing flag with shared public names", () => {
    expect(DEFAULT_WORKFLOW_FEATURES).toEqual({ experimentalModelRouting: false });
    expect(WORKFLOW_FEATURE_DEFINITIONS).toEqual([
      {
        key: "experimentalModelRouting",
        publicName: "experimental-model-routing",
        defaultValue: false,
        stage: "experimental",
        description: "Allow workflow scripts to route subagents to explicit model hints.",
      },
    ]);
    expect(publicNameForWorkflowFeature("experimentalModelRouting")).toBe(
      "experimental-model-routing",
    );
    expect(featureKeyFromPublicName("experimental-model-routing")).toBe("experimentalModelRouting");
    expect(envVarNameForWorkflowFeature("experimentalModelRouting")).toBe(
      "PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING",
    );
    expect(cliFlagNameForWorkflowFeature("experimentalModelRouting")).toBe(
      "workflow-experimental-model-routing",
    );
  });
});
