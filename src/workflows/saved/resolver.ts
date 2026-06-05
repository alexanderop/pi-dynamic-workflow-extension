import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { err, ok, type Result } from "../result.ts";
import { tryParseWorkflowScript, WorkflowParseError } from "../script/parser.ts";
import type { WorkflowMeta } from "../script/model.ts";

export interface WorkflowSavedWorkflowLocations {
  readonly projectDir?: string;
  readonly personalDir?: string;
}

export interface WorkflowSavedWorkflow {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "personal";
  readonly source: string;
  readonly meta: WorkflowMeta;
}

export type WorkflowSavedWorkflowError =
  | WorkflowSavedWorkflowInvalidNameError
  | WorkflowSavedWorkflowNotFoundError
  | WorkflowSavedWorkflowReadError
  | WorkflowSavedWorkflowInvalidError;

export interface WorkflowSavedWorkflowInvalidNameError {
  readonly _tag: "WorkflowSavedWorkflowInvalidNameError";
  readonly message: string;
  readonly name: string;
}

export interface WorkflowSavedWorkflowNotFoundError {
  readonly _tag: "WorkflowSavedWorkflowNotFoundError";
  readonly message: string;
  readonly name: string;
  readonly searchedPaths: string[];
}

export interface WorkflowSavedWorkflowReadError {
  readonly _tag: "WorkflowSavedWorkflowReadError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkflowSavedWorkflowInvalidError {
  readonly _tag: "WorkflowSavedWorkflowInvalidError";
  readonly message: string;
  readonly path: string;
  readonly cause: WorkflowParseError;
}

interface WorkflowSavedWorkflowScope {
  readonly dir: string;
  readonly scope: "project" | "personal";
}

interface WorkflowSavedWorkflowCandidate extends WorkflowSavedWorkflowScope {
  readonly path: string;
  readonly isExactNamePath: boolean;
}

export function projectSavedWorkflowDir(rootDir: string): string {
  return join(dirname(dirname(rootDir)), ".pi", "workflows");
}

export function personalSavedWorkflowDir(): string {
  return join(homedir(), ".pi", "workflows");
}

export function savedWorkflowPath(dir: string, name: string): string {
  return join(dir, `${name}.js`);
}

export async function resolveSavedWorkflowByName(
  name: string,
  locations: WorkflowSavedWorkflowLocations,
): Promise<Result<WorkflowSavedWorkflow, WorkflowSavedWorkflowError>> {
  const validName = validateSavedWorkflowName(name);
  if (validName.status === "error") return validName;

  const scopes = candidateScopes(locations);
  for (const scope of scopes) {
    const exactPath = savedWorkflowPath(scope.dir, name);
    const exactCandidate = { ...scope, path: exactPath, isExactNamePath: true };
    const exactSource = await readSavedWorkflowSource(exactPath);
    if (exactSource.status === "error") {
      if (!isMissingFile(exactSource.error.cause)) return exactSource;
    } else {
      const exact = parseSavedWorkflowCandidate(name, exactCandidate, exactSource.value);
      if (exact.status === "error") return exact;
      if (exact.value !== undefined) return ok(exact.value);
    }

    const scanned = await scannedSavedWorkflowPaths(scope.dir, exactPath);
    if (scanned.status === "error") return scanned;

    for (const candidate of scanned.value.map((path) => ({
      ...scope,
      path,
      isExactNamePath: false,
    }))) {
      const source = await readSavedWorkflowSource(candidate.path);
      if (source.status === "error") {
        if (isMissingFile(source.error.cause)) continue;
        return source;
      }

      const parsed = parseSavedWorkflowCandidate(name, candidate, source.value);
      if (parsed.status === "error") return parsed;
      if (parsed.value !== undefined) return ok(parsed.value);
    }
  }

  return err({
    _tag: "WorkflowSavedWorkflowNotFoundError",
    message: `Saved workflow '${name}' was not found.`,
    name,
    searchedPaths: scopes.flatMap((scope) => [
      savedWorkflowPath(scope.dir, name),
      join(scope.dir, "*.js"),
    ]),
  });
}

export async function readSavedWorkflowScriptPath(
  path: string,
): Promise<Result<string, WorkflowSavedWorkflowReadError>> {
  return readSavedWorkflowSource(path);
}

function candidateScopes(locations: WorkflowSavedWorkflowLocations): WorkflowSavedWorkflowScope[] {
  return [
    locations.projectDir === undefined
      ? undefined
      : { dir: locations.projectDir, scope: "project" as const },
    locations.personalDir === undefined
      ? undefined
      : { dir: locations.personalDir, scope: "personal" as const },
  ].filter((scope): scope is WorkflowSavedWorkflowScope => scope !== undefined);
}

async function scannedSavedWorkflowPaths(
  dir: string,
  exactPath: string,
): Promise<Result<string[], WorkflowSavedWorkflowReadError>> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (isMissingFile(cause)) return ok([]);
    return err({
      _tag: "WorkflowSavedWorkflowReadError",
      message: `Could not read saved workflow directory at '${dir}'.`,
      path: dir,
      cause,
    });
  }

  return ok(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(dir, entry.name))
      .filter((path) => path !== exactPath)
      .toSorted(),
  );
}

function parseSavedWorkflowCandidate(
  name: string,
  candidate: WorkflowSavedWorkflowCandidate,
  source: string,
): Result<WorkflowSavedWorkflow | undefined, WorkflowSavedWorkflowInvalidError> {
  const parsed = tryParseWorkflowScript(source);
  if (parsed.status === "error") {
    if (candidate.isExactNamePath) return err(invalidSavedWorkflow(candidate.path, parsed.error));
    return ok(undefined);
  }

  if (parsed.value.meta.name === name) {
    return ok({
      name,
      path: candidate.path,
      scope: candidate.scope,
      source,
      meta: parsed.value.meta,
    });
  }

  if (candidate.isExactNamePath) {
    return err(
      invalidSavedWorkflow(
        candidate.path,
        new WorkflowParseError(
          `Saved workflow meta.name must match requested command '${name}', got '${parsed.value.meta.name}'.`,
        ),
      ),
    );
  }

  return ok(undefined);
}

async function readSavedWorkflowSource(
  path: string,
): Promise<Result<string, WorkflowSavedWorkflowReadError>> {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (cause) {
    return err({
      _tag: "WorkflowSavedWorkflowReadError",
      message: `Could not read saved workflow script at '${path}'.`,
      path,
      cause,
    });
  }
}

export function validateSavedWorkflowName(
  name: string,
): Result<void, WorkflowSavedWorkflowInvalidNameError> {
  if (name.length > 0 && basename(name) === name && !name.includes("/") && !name.includes("\\")) {
    return ok(undefined);
  }

  return err({
    _tag: "WorkflowSavedWorkflowInvalidNameError",
    message: "Saved workflow name must be a non-empty command name without path separators.",
    name,
  });
}

function invalidSavedWorkflow(
  path: string,
  cause: WorkflowParseError,
): WorkflowSavedWorkflowInvalidError {
  return {
    _tag: "WorkflowSavedWorkflowInvalidError",
    message: cause.message,
    path,
    cause,
  };
}

function isMissingFile(cause: unknown): boolean {
  return isNodeError(cause) && cause.code === "ENOENT";
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}
