import { createHash } from "node:crypto";
import type { WorkflowAgentKeyInput, WorkflowJournalKey } from "./model.ts";

const WORKFLOW_AGENT_KEY_VERSION = "v2";

export function computeWorkflowAgentKey(input: WorkflowAgentKeyInput): WorkflowJournalKey {
  const preimage = canonicalJson({
    keyVersion: WORKFLOW_AGENT_KEY_VERSION,
    prompt: input.prompt,
    schema: input.schema ?? null,
    label: input.label ?? null,
    phase: input.phase ?? null,
    agentType: input.agentType,
    model: input.model,
    cwd: input.cwd,
  });
  const digest = createHash("sha256").update(preimage).digest("hex");
  return `${WORKFLOW_AGENT_KEY_VERSION}:${digest}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Workflow journal keys require finite numbers.");
    return value;
  }
  if (typeof value === "bigint") {
    throw new TypeError("Workflow journal keys require JSON-serializable values, not bigint.");
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return null;
  }

  if (typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("Workflow journal keys require acyclic values.");
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => typeof entryValue !== "undefined")
    .toSorted(([left], [right]) => left.localeCompare(right));
  const object: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) object[key] = canonicalize(entryValue, seen);
  seen.delete(value);
  return object;
}
