import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { WorkflowRunStore, type WorkflowRunStoreError } from "#src/workflows/run/store.ts";
import { tryParseWorkflowScript } from "#src/workflows/script/parser.ts";
import type { WorkflowParseError } from "#src/workflows/script/parser.ts";
import {
  projectSavedWorkflowDir,
  savedWorkflowPath,
  validateSavedWorkflowName,
  type WorkflowSavedWorkflowInvalidNameError,
  type WorkflowSavedWorkflowLocations,
} from "./resolver.ts";

export interface WorkflowSaveRunScriptRequest {
  readonly runId: string;
}

export interface WorkflowSaveRunScriptOptions {
  readonly rootDir: string;
  readonly savedWorkflowDirs?: WorkflowSavedWorkflowLocations;
}

export interface WorkflowSavedRunScript {
  readonly runId: string;
  readonly name: string;
  readonly scope: "project";
  readonly path: string;
}

export type WorkflowSaveRunScriptError =
  | WorkflowSavedWorkflowInvalidNameError
  | WorkflowSaveRunScriptRunReadError
  | WorkflowSaveRunScriptInvalidRunStatusError
  | WorkflowSaveRunScriptReadError
  | WorkflowSaveRunScriptInvalidWorkflowError
  | WorkflowSaveRunScriptWriteError;

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

  const name = validateSavedWorkflowName(parsed.value.meta.name);
  if (name.status === "error") return name;

  const target = targetSavedWorkflowPath(parsed.value.meta.name, options);

  try {
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(target.path, source, "utf8");
  } catch (cause) {
    return err({
      _tag: "WorkflowSaveRunScriptWriteError",
      message: `Could not write saved workflow script at '${target.path}'.`,
      path: target.path,
      cause,
    });
  }

  return ok({
    runId: request.runId,
    name: parsed.value.meta.name,
    scope: target.scope,
    path: target.path,
  });
}

function targetSavedWorkflowPath(
  name: string,
  options: WorkflowSaveRunScriptOptions,
): { readonly scope: "project"; readonly path: string } {
  const dir = options.savedWorkflowDirs?.projectDir ?? projectSavedWorkflowDir(options.rootDir);
  return { scope: "project", path: savedWorkflowPath(dir, name) };
}
