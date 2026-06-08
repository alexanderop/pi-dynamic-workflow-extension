import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { err, ok, type Result } from "#src/workflows/result.ts";
import {
  isWorkflowFeatureKey,
  type WorkflowFeatureFlags,
  type WorkflowFeatureKey,
  type WorkflowFeatureDecisionSource,
} from "#src/workflows/features/registry.ts";

export type WorkflowFeatureConfigScope = Extract<WorkflowFeatureDecisionSource, "user" | "project">;

export interface WorkflowFeatureConfigRead {
  readonly features: Partial<WorkflowFeatureFlags>;
  readonly warnings: string[];
}

export interface WorkflowFeatureConfigWriteError {
  readonly _tag: "WorkflowFeatureConfigWriteError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export type WorkflowFeatureConfigPatch = Partial<Record<WorkflowFeatureKey, boolean | undefined>>;

export function defaultUserWorkflowFeatureConfigPath(): string {
  return join(homedir(), ".pi", "agent", "dynamic-workflows.json");
}

export function defaultProjectWorkflowFeatureConfigPath(workflowRoot: string): string {
  return join(workflowRoot, "config.json");
}

export async function readWorkflowFeatureConfig(
  path: string,
  scope: WorkflowFeatureConfigScope,
): Promise<WorkflowFeatureConfigRead> {
  const loaded = await loadConfigObject(path, scope);
  if (loaded.warnings.length > 0 || loaded.value === undefined) {
    return { features: {}, warnings: loaded.warnings };
  }

  return { features: knownFeaturesFromConfig(loaded.value), warnings: [] };
}

export async function writeWorkflowFeatureConfig(
  path: string,
  patch: WorkflowFeatureConfigPatch,
): Promise<Result<void, WorkflowFeatureConfigWriteError>> {
  const loaded = await loadConfigObject(path, "user");
  const base = loaded.value ?? {};
  const currentFeatures = isRecord(base.features) ? { ...base.features } : {};
  for (const key of Object.keys(patch)) {
    if (!isWorkflowFeatureKey(key)) continue;
    const value = patch[key];
    if (value === undefined) {
      delete currentFeatures[key];
      continue;
    }
    currentFeatures[key] = value;
  }

  const next = { ...base, features: currentFeatures };
  try {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = join(dirname(path), `.dynamic-workflows.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
    return ok(undefined);
  } catch (cause) {
    return err({
      _tag: "WorkflowFeatureConfigWriteError",
      message: `Could not write workflow feature config at '${path}'.`,
      path,
      cause,
    });
  }
}

async function loadConfigObject(
  path: string,
  scope: WorkflowFeatureConfigScope,
): Promise<{ readonly value?: Record<string, unknown>; readonly warnings: string[] }> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return { warnings: [] };
    return { warnings: [configWarning(scope, path, cause)] };
  }

  try {
    const parsed = JSON.parse(source);
    if (!isRecord(parsed)) throw new Error("expected a JSON object");
    return { value: parsed, warnings: [] };
  } catch (cause) {
    return { warnings: [configWarning(scope, path, cause)] };
  }
}

function knownFeaturesFromConfig(config: Record<string, unknown>): Partial<WorkflowFeatureFlags> {
  if (!isRecord(config.features)) return {};
  const features: Partial<Record<WorkflowFeatureKey, boolean>> = {};
  for (const [key, value] of Object.entries(config.features)) {
    if (!isWorkflowFeatureKey(key) || typeof value !== "boolean") continue;
    features[key] = value;
  }
  return features;
}

function configWarning(scope: WorkflowFeatureConfigScope, path: string, cause: unknown): string {
  return `Could not read ${scope} workflow feature config at '${path}'; ignoring it. ${errorMessage(cause)}`;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
