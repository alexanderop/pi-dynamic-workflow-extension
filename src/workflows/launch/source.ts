// Launch-source selection and validation: decides whether a launch request
// resolves from an inline script, a saved workflow name, or a script path,
// then loads and validates that source. Background execution lives in
// background.ts; terminal-state builders in run-state.ts.
import { dirname } from "node:path";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { stripMarkdownFence } from "#src/workflows/script/parser.ts";
import { isScriptPathWithinRoot, projectSavedWorkflowDir } from "#src/workflows/saved/resolver.ts";
import { WORKFLOW_SCRIPT_MAX_LENGTH } from "./model.ts";
import type {
  WorkflowLaunchError,
  WorkflowLaunchInvalidRequestError,
  WorkflowLaunchOptions,
  WorkflowLaunchRequest,
} from "./model.ts";
import type { WorkflowLaunchOperations } from "./operations.ts";

export function workflowProjectCwdFromRootDir(rootDir: string): string {
  return dirname(dirname(rootDir));
}

export async function loadLaunchSource(
  request: WorkflowLaunchRequest,
  options: WorkflowLaunchOptions,
  operations: WorkflowLaunchOperations,
): Promise<Result<{ readonly kind: "script"; readonly script: string }, WorkflowLaunchError>> {
  const selected = selectLaunchSource(request);
  if (selected.status === "error") return selected;

  switch (selected.value.kind) {
    case "script":
      return ok(selected.value);
    case "name": {
      const resolved = await operations.resolveSavedWorkflowByName(selected.value.name, {
        projectDir:
          options.savedWorkflowDirs?.projectDir ?? projectSavedWorkflowDir(options.rootDir),
      });
      if (resolved.status === "error") return resolved;
      return ok({ kind: "script", script: resolved.value.source });
    }
    case "scriptPath": {
      const projectRoot = workflowProjectCwdFromRootDir(options.rootDir);
      if (!isScriptPathWithinRoot(projectRoot, selected.value.scriptPath)) {
        return err({
          _tag: "WorkflowLaunchInvalidRequestError",
          message: `Workflow scriptPath '${selected.value.scriptPath}' is outside the workflow project directory '${projectRoot}'.`,
        });
      }
      const source = await operations.readSavedWorkflowScriptPath(selected.value.scriptPath);
      if (source.status === "error") return source;
      return ok({ kind: "script", script: source.value });
    }
  }
}

function selectLaunchSource(
  request: WorkflowLaunchRequest,
): Result<
  | { readonly kind: "script"; readonly script: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "scriptPath"; readonly scriptPath: string },
  WorkflowLaunchInvalidRequestError
> {
  if (request.scriptPath !== undefined)
    return ok({ kind: "scriptPath", scriptPath: request.scriptPath });

  if (request.script !== undefined) {
    // Normalize model-emitted fenced input here so the canonical (unfenced)
    // source is what gets validated, persisted, and saved downstream.
    const script = stripMarkdownFence(request.script);
    if (script.length === 0) {
      return err({
        _tag: "WorkflowLaunchInvalidRequestError",
        message: "Workflow launch script must not be empty.",
      });
    }
    if (script.length > WORKFLOW_SCRIPT_MAX_LENGTH) {
      return err({
        _tag: "WorkflowLaunchInvalidRequestError",
        message: `Workflow launch script must not exceed ${WORKFLOW_SCRIPT_MAX_LENGTH} characters.`,
      });
    }
    return ok({ kind: "script", script });
  }

  if (request.name !== undefined) return ok({ kind: "name", name: request.name });

  return err({
    _tag: "WorkflowLaunchInvalidRequestError",
    message: "Workflow launch requires one of script, name, or scriptPath.",
  });
}
