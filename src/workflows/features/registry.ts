// Workflow feature-flag registry: definitions, defaults, and name mappings.
// Layered precedence resolution lives in src/extension/features/resolve.ts.
export interface WorkflowFeatureFlags {
  /** Allow workflow scripts to route subagents to explicit model hints. */
  readonly experimentalModelRouting: boolean;
}

export type WorkflowFeatureKey = keyof WorkflowFeatureFlags;
export type WorkflowFeatureStage = "stable" | "experimental" | "deprecated";
// Single source of truth for the decision-source union: guards derive from this
// array via .includes(), so adding a source here updates type and guards together.
export const WORKFLOW_FEATURE_DECISION_SOURCES = [
  "default",
  "user",
  "project",
  "hook",
  "env",
  "cli",
  "session",
  "override",
] as const;

export type WorkflowFeatureDecisionSource = (typeof WORKFLOW_FEATURE_DECISION_SOURCES)[number];

export interface WorkflowFeatureDefinition<Key extends WorkflowFeatureKey = WorkflowFeatureKey> {
  readonly key: Key;
  readonly publicName: string;
  readonly defaultValue: WorkflowFeatureFlags[Key];
  readonly stage: WorkflowFeatureStage;
  readonly description: string;
}

export interface WorkflowFeatureDecision {
  readonly key: WorkflowFeatureKey;
  readonly value: boolean;
  readonly source: WorkflowFeatureDecisionSource;
  readonly detail?: string;
}

export const DEFAULT_WORKFLOW_FEATURES: WorkflowFeatureFlags = {
  experimentalModelRouting: false,
};

export const WORKFLOW_FEATURE_DEFINITIONS: readonly WorkflowFeatureDefinition[] = [
  {
    key: "experimentalModelRouting",
    publicName: "experimental-model-routing",
    defaultValue: false,
    stage: "experimental",
    description: "Allow workflow scripts to route subagents to explicit model hints.",
  },
];

const DEFINITIONS_BY_KEY = new Map(
  WORKFLOW_FEATURE_DEFINITIONS.map((definition) => [definition.key, definition]),
);
const DEFINITIONS_BY_PUBLIC_NAME = new Map(
  WORKFLOW_FEATURE_DEFINITIONS.map((definition) => [definition.publicName, definition]),
);

export function isWorkflowFeatureKey(value: unknown): value is WorkflowFeatureKey {
  return typeof value === "string" && DEFINITIONS_BY_KEY.has(value as WorkflowFeatureKey);
}

export function workflowFeatureDefinition(key: WorkflowFeatureKey): WorkflowFeatureDefinition {
  return DEFINITIONS_BY_KEY.get(key)!;
}

export function publicNameForWorkflowFeature(key: WorkflowFeatureKey): string {
  return workflowFeatureDefinition(key).publicName;
}

export function featureKeyFromPublicName(publicName: string): WorkflowFeatureKey | undefined {
  return DEFINITIONS_BY_PUBLIC_NAME.get(publicName)?.key;
}

export function envVarNameForWorkflowFeature(key: WorkflowFeatureKey): string {
  return `PI_DYNAMIC_WORKFLOWS_${publicNameForWorkflowFeature(key).replaceAll("-", "_").toUpperCase()}`;
}

export function cliFlagNameForWorkflowFeature(key: WorkflowFeatureKey): string {
  return `workflow-${publicNameForWorkflowFeature(key)}`;
}

export function workflowFeatureKeys(): WorkflowFeatureKey[] {
  return WORKFLOW_FEATURE_DEFINITIONS.map((definition) => definition.key);
}
