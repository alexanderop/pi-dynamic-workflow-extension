import type { WorkflowRuntimeControl } from "#src/workflows/script/model.ts";

const controls = new Map<string, WorkflowRuntimeControl>();

export function registerWorkflowRunControl(
  runId: string,
  control: WorkflowRuntimeControl,
): () => void {
  controls.set(runId, control);
  return () => {
    if (controls.get(runId) === control) controls.delete(runId);
  };
}

export function getWorkflowRunControl(runId: string): WorkflowRuntimeControl | undefined {
  return controls.get(runId);
}

export function unregisterWorkflowRunControl(runId: string): void {
  controls.delete(runId);
}
