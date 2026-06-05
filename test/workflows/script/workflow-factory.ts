import type { WorkflowMeta } from "#src/workflows/script/model.ts";

interface WorkflowScriptParts {
  beforeMeta?: string;
  meta?: WorkflowMeta;
  body?: string;
}

export function workflowScript({
  beforeMeta,
  meta = { name: "test-workflow" },
  body = "return null;",
}: WorkflowScriptParts = {}): string {
  return workflowScriptSource({
    beforeMeta,
    metaSource: JSON.stringify(meta, null, 2),
    body,
  });
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
