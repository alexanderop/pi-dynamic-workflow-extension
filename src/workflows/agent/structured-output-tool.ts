import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export class WorkflowAgentSchemaError extends Error {
  readonly variant = "schema";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowAgentSchemaError";
  }
}

export function createWorkflowStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition<TSchema, unknown, unknown> {
  assertToolParameterSchema(schema);

  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: "Return the final structured result for a workflow agent.",
    promptSnippet: "Submit final structured output for this workflow agent",
    promptGuidelines: [
      "Use structured_output as the final action when a workflow agent requests structured output.",
      "Do not answer with prose instead of calling structured_output when structured output is required.",
    ],
    parameters: schema as TSchema,
    async execute(_toolCallId, params) {
      const result = structuredClone(params);
      capture(result);
      return {
        content: [{ type: "text", text: "Structured output accepted." }],
        details: result,
        terminate: true,
      };
    },
  });
}

function assertToolParameterSchema(schema: unknown): asserts schema is Record<string, unknown> {
  if (!isRecord(schema) || schema.type !== "object") {
    throw new WorkflowAgentSchemaError(
      "agent({ schema }) must be a JSON object schema because Pi tool parameters must be objects.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
