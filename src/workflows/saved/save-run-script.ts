import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "../result.ts";
import { WorkflowRunStore, type WorkflowRunStoreError } from "../run/store.ts";
import { tryParseWorkflowScript } from "../script/parser.ts";
import type { WorkflowParseError } from "../script/parser.ts";
import {
  personalSavedWorkflowDir,
  projectSavedWorkflowDir,
  savedWorkflowPath,
  validateSavedWorkflowName,
  type WorkflowSavedWorkflowInvalidNameError,
  type WorkflowSavedWorkflowLocations,
} from "./resolver.ts";

export interface WorkflowSaveRunScriptRequest {
  readonly runId: string;
  readonly name: string;
  readonly scope: "project" | "personal";
}

export interface WorkflowSaveRunScriptOptions {
  readonly rootDir: string;
  readonly savedWorkflowDirs?: WorkflowSavedWorkflowLocations;
}

export interface WorkflowSavedRunScript {
  readonly runId: string;
  readonly name: string;
  readonly scope: "project" | "personal";
  readonly path: string;
}

export type WorkflowSaveRunScriptError =
  | WorkflowSavedWorkflowInvalidNameError
  | WorkflowSaveRunScriptInvalidScopeError
  | WorkflowSaveRunScriptRunReadError
  | WorkflowSaveRunScriptInvalidRunStatusError
  | WorkflowSaveRunScriptReadError
  | WorkflowSaveRunScriptInvalidWorkflowError
  | WorkflowSaveRunScriptWriteError;

export interface WorkflowSaveRunScriptInvalidScopeError {
  readonly _tag: "WorkflowSaveRunScriptInvalidScopeError";
  readonly message: string;
  readonly scope: unknown;
}

export interface WorkflowSaveRunScriptRunReadError {
  readonly _tag: "WorkflowSaveRunScriptRunReadError";
  readonly message: string;
  readonly runId: string;
  readonly cause: WorkflowRunStoreError;
}

export interface WorkflowSaveRunScriptInvalidRunStatusError {
  readonly _tag: "WorkflowSaveRunScriptInvalidRunStatusError";
  readonly message: string;
  readonly runId: string;
  readonly status: string;
}

export interface WorkflowSaveRunScriptReadError {
  readonly _tag: "WorkflowSaveRunScriptReadError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkflowSaveRunScriptInvalidWorkflowError {
  readonly _tag: "WorkflowSaveRunScriptInvalidWorkflowError";
  readonly message: string;
  readonly path: string;
  readonly cause?: WorkflowParseError;
}

export interface WorkflowSaveRunScriptWriteError {
  readonly _tag: "WorkflowSaveRunScriptWriteError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export async function saveRunScript(
  request: WorkflowSaveRunScriptRequest,
  options: WorkflowSaveRunScriptOptions,
): Promise<Result<WorkflowSavedRunScript, WorkflowSaveRunScriptError>> {
  const name = validateSavedWorkflowName(request.name);
  if (name.status === "error") return name;

  const target = targetSavedWorkflowPath(request, options);
  if (target.status === "error") return target;

  const run = await new WorkflowRunStore({ rootDir: options.rootDir }).readRun(request.runId);
  if (run.status === "error") {
    return err({
      _tag: "WorkflowSaveRunScriptRunReadError",
      message: `Could not read workflow run '${request.runId}'.`,
      runId: request.runId,
      cause: run.error,
    });
  }

  if (run.value.status !== "completed") {
    return err({
      _tag: "WorkflowSaveRunScriptInvalidRunStatusError",
      message: `Workflow run '${request.runId}' must be completed before it can be saved as a reusable workflow.`,
      runId: request.runId,
      status: run.value.status,
    });
  }

  let source: string;
  try {
    source = await readFile(run.value.scriptPath, "utf8");
  } catch (cause) {
    return err({
      _tag: "WorkflowSaveRunScriptReadError",
      message: `Could not read workflow run script at '${run.value.scriptPath}'.`,
      path: run.value.scriptPath,
      cause,
    });
  }

  const parsed = tryParseWorkflowScript(source);
  if (parsed.status === "error") {
    return err({
      _tag: "WorkflowSaveRunScriptInvalidWorkflowError",
      message: parsed.error.message,
      path: run.value.scriptPath,
      cause: parsed.error,
    });
  }

  if (parsed.value.meta.name !== request.name) {
    return err({
      _tag: "WorkflowSaveRunScriptInvalidWorkflowError",
      message: `Saved workflow name must match script meta.name; requested '${request.name}', got '${parsed.value.meta.name}'.`,
      path: run.value.scriptPath,
    });
  }

  try {
    await mkdir(dirname(target.value.path), { recursive: true });
    await writeFile(target.value.path, source, "utf8");
  } catch (cause) {
    return err({
      _tag: "WorkflowSaveRunScriptWriteError",
      message: `Could not write saved workflow script at '${target.value.path}'.`,
      path: target.value.path,
      cause,
    });
  }

  return ok({
    runId: request.runId,
    name: request.name,
    scope: target.value.scope,
    path: target.value.path,
  });
}

function targetSavedWorkflowPath(
  request: WorkflowSaveRunScriptRequest,
  options: WorkflowSaveRunScriptOptions,
): Result<
  { readonly scope: "project" | "personal"; readonly path: string },
  WorkflowSaveRunScriptInvalidScopeError
> {
  if (request.scope === "project") {
    const dir = options.savedWorkflowDirs?.projectDir ?? projectSavedWorkflowDir(options.rootDir);
    return ok({ scope: "project", path: savedWorkflowPath(dir, request.name) });
  }

  if (request.scope === "personal") {
    const dir = options.savedWorkflowDirs?.personalDir ?? personalSavedWorkflowDir();
    return ok({ scope: "personal", path: savedWorkflowPath(dir, request.name) });
  }

  return err({
    _tag: "WorkflowSaveRunScriptInvalidScopeError",
    message: "Saved workflow scope must be 'project' or 'personal'.",
    scope: request.scope,
  });
}
