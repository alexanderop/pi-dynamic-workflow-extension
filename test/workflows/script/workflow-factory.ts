import type { WorkflowMeta } from "#src/workflows/script/model.ts";

interface WorkflowScriptParts {
  beforeMeta?: string;
  meta?: Partial<WorkflowMeta>;
  body?: string;
}

export function workflowScript({
  beforeMeta,
  meta,
  body = "return null;",
}: WorkflowScriptParts = {}): string {
  return workflowScriptSource({
    beforeMeta,
    metaSource: JSON.stringify(workflowMeta(meta), null, 2),
    body,
  });
}

function workflowMeta(meta: Partial<WorkflowMeta> | undefined): WorkflowMeta {
  const name = meta?.name ?? "test-workflow";
  return {
    ...meta,
    name,
    description: meta?.description ?? name,
  };
}

interface InvalidWorkflowScriptParts {
  beforeMeta?: string;
  metaSource: string;
  body?: string;
}

export function invalidWorkflowScript({
  beforeMeta,
  metaSource,
  body = "return null;",
}: InvalidWorkflowScriptParts): string {
  return workflowScriptSource({ beforeMeta, metaSource, body });
}

function workflowScriptSource({
  beforeMeta,
  metaSource,
  body,
}: {
  beforeMeta?: string;
  metaSource: string;
  body: string;
}): string {
  return [beforeMeta, `export const meta = ${metaSource};`, body]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");
}
