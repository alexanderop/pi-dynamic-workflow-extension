// Resolves saved-workflow names to parsed script files in the saved-workflow
// directories, enforcing path containment and parse validity.
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isNodeError } from "#src/workflows/guards.ts";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { tryParseWorkflowScript, WorkflowParseError } from "#src/workflows/script/parser.ts";
import type { WorkflowMeta } from "#src/workflows/script/model.ts";

export interface WorkflowSavedWorkflowLocations {
  readonly projectDir?: string;
}

export interface WorkflowSavedWorkflow {
  readonly name: string;
  readonly path: string;
  readonly scope: "project";
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
  readonly scope: "project";
}

interface WorkflowSavedWorkflowCandidate extends WorkflowSavedWorkflowScope {
  readonly path: string;
  readonly isExactNamePath: boolean;
}

export function projectSavedWorkflowDir(rootDir: string): string {
  return join(dirname(dirname(rootDir)), ".pi", "workflows");
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
    const exact = await tryCandidate(name, { ...scope, path: exactPath, isExactNamePath: true });
    if (exact.kind === "error") return err(exact.error);
    if (exact.kind === "found") return ok(exact.workflow);

    const scanned = await scannedSavedWorkflowPaths(scope.dir, exactPath);
    if (scanned.status === "error") return scanned;

    for (const path of scanned.value) {
      const outcome = await tryCandidate(name, { ...scope, path, isExactNamePath: false });
      if (outcome.kind === "error") return err(outcome.error);
      if (outcome.kind === "found") return ok(outcome.workflow);
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

type SavedWorkflowCandidateOutcome =
  | { readonly kind: "found"; readonly workflow: WorkflowSavedWorkflow }
  | { readonly kind: "skip" }
  | { readonly kind: "error"; readonly error: WorkflowSavedWorkflowError };

/**
 * Read and parse one candidate file: "found" when it defines the requested
 * workflow, "skip" when it is missing or defines a different workflow (keep
 * scanning), "error" when it is unreadable or an exact-name file is invalid.
 */
async function tryCandidate(
  name: string,
  candidate: WorkflowSavedWorkflowCandidate,
): Promise<SavedWorkflowCandidateOutcome> {
  const source = await readSavedWorkflowSource(candidate.path);
  if (source.status === "error") {
    if (isMissingFile(source.error.cause)) return { kind: "skip" };
    return { kind: "error", error: source.error };
  }

  const parsed = parseSavedWorkflowCandidate(name, candidate, source.value);
  if (parsed.status === "error") return { kind: "error", error: parsed.error };
  if (parsed.value === undefined) return { kind: "skip" };
  return { kind: "found", workflow: parsed.value };
}

function candidateScopes(locations: WorkflowSavedWorkflowLocations): WorkflowSavedWorkflowScope[] {
  return locations.projectDir === undefined
    ? []
    : [{ dir: locations.projectDir, scope: "project" }];
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

/**
 * Lexical containment check for a caller-supplied `scriptPath`. Resolving the
 * candidate against `root` collapses `..` segments; an absolute candidate
 * ignores `root` entirely. The path is contained iff the relative path from the
 * resolved root neither escapes upward (`..`) nor is itself absolute (a
 * different drive on Windows). This blocks reads of `/etc/passwd`,
 * `~/.ssh/id_rsa`, and `../../escape` while still allowing any file under the
 * workflow project tree. It is intentionally lexical — it does not resolve
 * symlinks — which matches the local-dev threat model.
 */
export function isScriptPathWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
