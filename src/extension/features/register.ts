import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_FEATURE_DEFINITIONS, cliFlagNameForWorkflowFeature } from "./registry.ts";

export type RegisterWorkflowFeatureFlagsPi = Partial<Pick<ExtensionAPI, "registerFlag">>;

export function registerWorkflowFeatureFlags(pi: RegisterWorkflowFeatureFlagsPi): void {
  if (pi.registerFlag === undefined) return;
  for (const definition of WORKFLOW_FEATURE_DEFINITIONS) {
    pi.registerFlag(cliFlagNameForWorkflowFeature(definition.key), {
      description: cliFlagDescription(definition.key),
      type: "boolean",
      default: definition.defaultValue,
    });
  }
}

function cliFlagDescription(key: string): string {
  if (key === "experimentalModelRouting") {
    return "Enable experimental per-agent workflow model routing";
  }
  return "Enable a dynamic workflow feature";
}
