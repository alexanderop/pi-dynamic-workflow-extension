import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { tryParseWorkflowScript } from "#src/workflows/script/parser.ts";
import { resolveSavedWorkflowByName } from "./resolver.ts";
import type {
  WorkflowSavedWorkflow,
  WorkflowSavedWorkflowError,
  WorkflowSavedWorkflowLocations,
} from "./resolver.ts";

export type WorkflowSavedWorkflowListError =
  | WorkflowSavedWorkflowListReadError
  | WorkflowSavedWorkflowError;

export interface WorkflowSavedWorkflowListReadError {
  readonly _tag: "WorkflowSavedWorkflowListReadError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

interface WorkflowSavedWorkflowScope {
  readonly dir: string;
  readonly scope: "project";
}

export async function listSavedWorkflows(
  locations: WorkflowSavedWorkflowLocations,
): Promise<Result<WorkflowSavedWorkflow[], WorkflowSavedWorkflowListError>> {
  const byName = new Map<string, WorkflowSavedWorkflow>();

  for (const scope of candidateScopes(locations)) {
    const listed = await listSavedWorkflowScope(scope);
    if (listed.status === "error") return listed;

    for (const workflow of listed.value) {
      if (!byName.has(workflow.name)) byName.set(workflow.name, workflow);
    }
  }

  return ok([...byName.values()].toSorted(compareSavedWorkflows));
}

async function listSavedWorkflowScope(
  scope: WorkflowSavedWorkflowScope,
): Promise<Result<WorkflowSavedWorkflow[], WorkflowSavedWorkflowListError>> {
  const paths = await savedWorkflowFiles(scope.dir);
  if (paths.status === "error") return paths;

  const names = new Set<string>();

  for (const path of paths.value) {
    const source = await readSavedWorkflowSource(path);
    if (source.status === "error") {
      if (isMissingFile(source.error.cause)) continue;
      return source;
    }

    const parsed = tryParseWorkflowScript(source.value);
    if (parsed.status === "error") continue;
    names.add(parsed.value.meta.name);
  }

  const workflows: WorkflowSavedWorkflow[] = [];
  for (const name of [...names].toSorted()) {
    const resolved = await resolveSavedWorkflowByName(name, resolverLocations(scope));
    if (resolved.status === "error") return resolved;
    workflows.push(resolved.value);
  }

  return ok(workflows);
}

async function savedWorkflowFiles(
  dir: string,
): Promise<Result<string[], WorkflowSavedWorkflowListReadError>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (isMissingFile(cause)) return ok([]);
    return err({
      _tag: "WorkflowSavedWorkflowListReadError",
      message: `Could not read saved workflow directory at '${dir}'.`,
      path: dir,
      cause,
    });
  }

  return ok(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(dir, entry.name))
      .toSorted(),
  );
}

async function readSavedWorkflowSource(
  path: string,
): Promise<Result<string, WorkflowSavedWorkflowListReadError>> {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (cause) {
    return err({
      _tag: "WorkflowSavedWorkflowListReadError",
      message: `Could not read saved workflow script at '${path}'.`,
      path,
      cause,
    });
  }
}

function candidateScopes(locations: WorkflowSavedWorkflowLocations): WorkflowSavedWorkflowScope[] {
  return locations.projectDir === undefined
    ? []
    : [{ dir: locations.projectDir, scope: "project" }];
}

function resolverLocations(scope: WorkflowSavedWorkflowScope): WorkflowSavedWorkflowLocations {
  return { projectDir: scope.dir };
}

function compareSavedWorkflows(left: WorkflowSavedWorkflow, right: WorkflowSavedWorkflow): number {
  return left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope);
}

function isMissingFile(cause: unknown): boolean {
  return isNodeError(cause) && cause.code === "ENOENT";
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}
