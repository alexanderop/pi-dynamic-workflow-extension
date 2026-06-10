// Layered feature-flag resolution (default, then user, project, hook, env,
// cli, session, override). Model-hint resolution is separate in
// src/workflows/model-routing/resolve.ts.
import {
  defaultProjectWorkflowFeatureConfigPath,
  defaultUserWorkflowFeatureConfigPath,
  readWorkflowFeatureConfig,
} from "./config.ts";
import {
  DEFAULT_WORKFLOW_FEATURES,
  cliFlagNameForWorkflowFeature,
  envVarNameForWorkflowFeature,
  isWorkflowFeatureKey,
  workflowFeatureKeys,
  type WorkflowFeatureDecision,
  type WorkflowFeatureDecisionSource,
  type WorkflowFeatureFlags,
  type WorkflowFeatureKey,
} from "#src/workflows/features/registry.ts";

export const WORKFLOW_FEATURE_SESSION_ENTRY_TYPE = "dynamic-workflows:features";
export const WORKFLOW_FEATURE_RESOLVE_EVENT = "dynamic-workflows:features:resolve";

export interface WorkflowFeatureSessionEntryData {
  readonly key: WorkflowFeatureKey;
  readonly action: "enable" | "disable" | "reset";
}

export interface WorkflowFeatureSessionEntryLike {
  readonly type?: unknown;
  readonly customType?: unknown;
  readonly data?: unknown;
}

export interface WorkflowFeatureResolveEventBus {
  emit(event: string, payload: WorkflowFeatureResolveHookPayload): void;
}

export interface WorkflowFeatureResolveHookPayload {
  readonly cwd: string;
  readonly sessionId?: string;
  readonly workflowRoot: string;
  features: WorkflowFeatureFlags;
  decisions: WorkflowFeatureDecision[];
  set(key: WorkflowFeatureKey, value: boolean, source: string, reason?: string): void;
}

export interface ResolveWorkflowFeaturesOptions {
  readonly cwd: string;
  readonly workflowRoot: string;
  readonly sessionId?: string;
  readonly userConfigPath?: string;
  readonly projectConfigPath?: string;
  readonly env?: Record<string, string | undefined>;
  readonly cliFlags?: Record<string, boolean | undefined>;
  readonly sessionEntries?: readonly WorkflowFeatureSessionEntryLike[];
  readonly overrides?: Partial<WorkflowFeatureFlags>;
  readonly events?: WorkflowFeatureResolveEventBus;
}

export interface ResolvedWorkflowFeatures {
  readonly features: WorkflowFeatureFlags;
  readonly decisions: WorkflowFeatureDecision[];
  readonly warnings: string[];
}

interface MutableResolution {
  features: WorkflowFeatureFlags;
  decisions: Map<WorkflowFeatureKey, WorkflowFeatureDecision>;
  warnings: string[];
}

export async function resolveWorkflowFeatures(
  options: ResolveWorkflowFeaturesOptions,
): Promise<ResolvedWorkflowFeatures> {
  const state = initialResolution();
  const userConfigPath = options.userConfigPath ?? defaultUserWorkflowFeatureConfigPath();
  const projectConfigPath =
    options.projectConfigPath ?? defaultProjectWorkflowFeatureConfigPath(options.workflowRoot);

  const user = await readWorkflowFeatureConfig(userConfigPath, "user");
  state.warnings.push(...user.warnings);
  applyFeatures(state, user.features, "user", userConfigPath);

  const project = await readWorkflowFeatureConfig(projectConfigPath, "project");
  state.warnings.push(...project.warnings);
  applyFeatures(state, project.features, "project", projectConfigPath);

  applyHookContributions(state, options);
  applyEnv(state, options.env ?? process.env);
  applyCli(state, options.cliFlags ?? {});
  applySession(state, options.sessionEntries ?? []);
  applyFeatures(state, options.overrides ?? {}, "override");

  return freezeResolution(state);
}

export function workflowFeatureSessionEntryData(
  key: WorkflowFeatureKey,
  action: WorkflowFeatureSessionEntryData["action"],
): WorkflowFeatureSessionEntryData {
  return { key, action };
}

function initialResolution(): MutableResolution {
  const decisions = new Map<WorkflowFeatureKey, WorkflowFeatureDecision>();
  for (const key of workflowFeatureKeys()) {
    decisions.set(key, { key, value: DEFAULT_WORKFLOW_FEATURES[key], source: "default" });
  }
  return { features: { ...DEFAULT_WORKFLOW_FEATURES }, decisions, warnings: [] };
}

function applyFeatures(
  state: MutableResolution,
  features: Partial<WorkflowFeatureFlags>,
  source: WorkflowFeatureDecisionSource,
  detail?: string,
): void {
  for (const key of workflowFeatureKeys()) {
    const value = features[key];
    if (typeof value !== "boolean") continue;
    applyFeature(state, key, value, source, detail);
  }
}

function applyFeature(
  state: MutableResolution,
  key: WorkflowFeatureKey,
  value: boolean,
  source: WorkflowFeatureDecisionSource,
  detail?: string,
): void {
  state.features = { ...state.features, [key]: value };
  state.decisions.set(
    key,
    detail === undefined ? { key, value, source } : { key, value, source, detail },
  );
}

function applyHookContributions(
  state: MutableResolution,
  options: ResolveWorkflowFeaturesOptions,
): void {
  if (options.events === undefined) return;

  const hookDecisions: WorkflowFeatureDecision[] = [];
  const payload: WorkflowFeatureResolveHookPayload = {
    cwd: options.cwd,
    sessionId: options.sessionId,
    workflowRoot: options.workflowRoot,
    features: { ...state.features },
    decisions: hookDecisions,
    set: (key, value, source, reason) => {
      const detail = reason === undefined ? source : `${source}: ${reason}`;
      applyFeature(state, key, value, "hook", detail);
      payload.features = { ...state.features };
      hookDecisions.push({ key, value, source: "hook", detail });
    },
  };

  try {
    options.events.emit(WORKFLOW_FEATURE_RESOLVE_EVENT, payload);
  } catch (cause) {
    state.warnings.push(
      `Workflow feature resolve hook failed; ignoring hook contribution. ${errorMessage(cause)}`,
    );
  }
}

function applyEnv(state: MutableResolution, env: Record<string, string | undefined>): void {
  for (const key of workflowFeatureKeys()) {
    const envName = envVarNameForWorkflowFeature(key);
    const raw = env[envName];
    if (raw === undefined) continue;
    const parsed = parseBooleanEnv(raw);
    if (parsed === undefined) {
      state.warnings.push(
        `Ignoring invalid workflow feature environment value ${envName}=${JSON.stringify(raw)}; expected 1, 0, true, or false.`,
      );
      continue;
    }
    applyFeature(state, key, parsed, "env", envName);
  }
}

function applyCli(state: MutableResolution, cliFlags: Record<string, boolean | undefined>): void {
  for (const key of workflowFeatureKeys()) {
    const flagName = cliFlagNameForWorkflowFeature(key);
    if (cliFlags[flagName] !== true) continue;
    applyFeature(state, key, true, "cli", flagName);
  }
}

function applySession(
  state: MutableResolution,
  entries: readonly WorkflowFeatureSessionEntryLike[],
): void {
  const latest = new Map<WorkflowFeatureKey, WorkflowFeatureSessionEntryData["action"]>();
  for (const entry of entries) {
    const data = sessionEntryData(entry);
    if (data === undefined) continue;
    latest.set(data.key, data.action);
  }

  for (const [key, action] of latest) {
    if (action === "reset") continue;
    applyFeature(state, key, action === "enable", "session");
  }
}

function sessionEntryData(
  entry: WorkflowFeatureSessionEntryLike,
): WorkflowFeatureSessionEntryData | undefined {
  if (entry.type !== "custom" || entry.customType !== WORKFLOW_FEATURE_SESSION_ENTRY_TYPE) {
    return undefined;
  }
  if (!isRecord(entry.data)) return undefined;
  const key = entry.data.key;
  const action = entry.data.action;
  if (!isWorkflowFeatureKey(key)) return undefined;
  if (action !== "enable" && action !== "disable" && action !== "reset") return undefined;
  return { key, action };
}

function parseBooleanEnv(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return undefined;
}

function freezeResolution(state: MutableResolution): ResolvedWorkflowFeatures {
  return {
    features: { ...state.features },
    decisions: workflowFeatureKeys().map((key) => state.decisions.get(key)!),
    warnings: [...state.warnings],
  };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
