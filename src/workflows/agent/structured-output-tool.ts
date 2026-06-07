import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export class WorkflowAgentSchemaError extends Error {
  readonly variant = "schema";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowAgentSchemaError";
  }
}

export type WorkflowStructuredOutputOutcome =
  | { readonly type: "pending" }
  | { readonly type: "finished"; readonly value: unknown }
  | { readonly type: "gave_up"; readonly reason: string };

export interface WorkflowStructuredOutputToolBundle {
  readonly tools: readonly ToolDefinition<TSchema, unknown, unknown>[];
  readonly toolSchema: TSchema;
  getOutcome(): WorkflowStructuredOutputOutcome;
}

const GIVE_UP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1 },
  },
  required: ["reason"],
} as const;

export function createWorkflowStructuredOutputToolBundle(
  schema: unknown,
): WorkflowStructuredOutputToolBundle {
  assertJsonSchemaObject(schema);
  const { toolSchema, usesEnvelope } = toPiToolParameterSchema(schema);
  let outcome: WorkflowStructuredOutputOutcome = { type: "pending" };

  const structuredOutput = defineTool<TSchema, unknown, unknown>({
    name: "structured_output",
    label: "Structured Output",
    description: "Return the final structured result for a workflow agent.",
    promptSnippet: "Submit final structured output for this workflow agent",
    promptGuidelines: [
      "Use structured_output as the final action when a workflow agent requests structured output.",
      "Do not answer with prose instead of calling structured_output when structured output is required.",
    ],
    parameters: toolSchema,
    async execute(_toolCallId, params) {
      if (outcome.type !== "pending") return duplicateOutcomeResult(outcome);

      const result = structuredClone(params);
      outcome = {
        type: "finished",
        value: usesEnvelope ? unwrapEnvelopeResult(result) : result,
      };
      return {
        content: [{ type: "text", text: "Structured output accepted." }],
        details: result,
        terminate: true,
      };
    },
  });

  const giveUp = defineTool<TSchema, unknown, unknown>({
    name: "give_up",
    label: "Give Up",
    description: "Explain why this workflow agent cannot produce valid structured output.",
    promptSnippet: "Give up on producing structured output with a reason",
    promptGuidelines: [
      "Use give_up only when a workflow agent cannot complete the assigned structured-output task.",
    ],
    parameters: GIVE_UP_SCHEMA as TSchema,
    async execute(_toolCallId, params) {
      if (outcome.type !== "pending") return duplicateOutcomeResult(outcome);

      const reason = reasonFromParams(params);
      outcome = { type: "gave_up", reason };
      return {
        content: [{ type: "text", text: `Structured output abandoned: ${reason}` }],
        details: { reason },
        terminate: true,
      };
    },
  });

  return {
    tools: [structuredOutput, giveUp],
    toolSchema,
    getOutcome: () => outcome,
  };
}

function toPiToolParameterSchema(schema: Record<string, unknown>): {
  readonly toolSchema: TSchema;
  readonly usesEnvelope: boolean;
} {
  if (schema.type === "object") {
    return { toolSchema: schema as TSchema, usesEnvelope: false };
  }

  return {
    toolSchema: {
      type: "object",
      additionalProperties: false,
      properties: { result: schema },
      required: ["result"],
    } as TSchema,
    usesEnvelope: true,
  };
}

function unwrapEnvelopeResult(value: unknown): unknown {
  if (!isRecord(value) || !("result" in value)) {
    throw new WorkflowAgentSchemaError("structured_output envelope is missing result.");
  }
  return value.result;
}

function duplicateOutcomeResult(
  outcome: Exclude<WorkflowStructuredOutputOutcome, { type: "pending" }>,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: "A structured-output outcome was already submitted; keeping the first one.",
      },
    ],
    details: { outcome: outcome.type },
  };
}

function reasonFromParams(params: unknown): string {
  if (!isRecord(params) || typeof params.reason !== "string" || params.reason.trim().length === 0) {
    throw new WorkflowAgentSchemaError("give_up requires a non-empty reason.");
  }
  return params.reason;
}

function assertJsonSchemaObject(schema: unknown): asserts schema is Record<string, unknown> {
  if (!isRecord(schema) || Array.isArray(schema)) {
    throw new WorkflowAgentSchemaError("agent({ schema }) must be a JSON Schema object.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
