// Plain-text formatter for the non-interactive `/workflows` overview (text and
// json command modes). The interactive TUI rendering lives in
// src/extension/tui/; this module is pure string assembly.
import { formatDuration } from "#src/workflows/view/layout.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowSavedWorkflow } from "#src/workflows/saved/resolver.ts";

export function formatWorkflowsOverview(
  runs: WorkflowRunState[],
  savedWorkflows: WorkflowSavedWorkflow[],
): string {
  if (runs.length === 0 && savedWorkflows.length === 0) {
    return "No workflow runs or saved workflows found in .pi/workflows.";
  }

  return [formatWorkflowRuns(runs), formatSavedWorkflows(savedWorkflows)]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}

function formatWorkflowRuns(runs: WorkflowRunState[]): string | undefined {
  if (runs.length === 0) return undefined;

  return [
    "Workflow runs",
    "",
    ...runs
      .map((run) => formatWorkflowRun(run))
      .join("\n\n")
      .split("\n"),
  ].join("\n");
}

function formatWorkflowRun(run: WorkflowRunState): string {
  return [
    run.runId,
    `  Status: ${run.status}`,
    `  Workflow: ${run.workflowName}`,
    `  Agents: ${run.agentCount}`,
    run.durationMs === undefined ? undefined : `  Duration: ${formatDuration(run.durationMs)}`,
    run.outputPath === undefined ? undefined : `  Output: ${run.outputPath}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatSavedWorkflows(savedWorkflows: WorkflowSavedWorkflow[]): string | undefined {
  if (savedWorkflows.length === 0) return undefined;

  return [
    "Saved workflows",
    "",
    ...savedWorkflows
      .map((workflow) => formatSavedWorkflow(workflow))
      .join("\n\n")
      .split("\n"),
  ].join("\n");
}

function formatSavedWorkflow(workflow: WorkflowSavedWorkflow): string {
  return [
    workflow.name,
    `  Scope: ${workflow.scope}`,
    workflow.meta.description === undefined
      ? undefined
      : `  Description: ${workflow.meta.description}`,
    workflow.meta.whenToUse === undefined ? undefined : `  When to use: ${workflow.meta.whenToUse}`,
    `  Path: ${workflow.path}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
