import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowStructuredOutputTool,
  WorkflowAgentSchemaError,
} from "#src/workflows/agent/structured-output-tool.ts";

describe("createWorkflowStructuredOutputTool", () => {
  it("should create a terminating structured_output tool from a plain object schema", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["source", "items"],
    };
    const capture = vi.fn<(value: unknown) => void>();

    const tool = createWorkflowStructuredOutputTool(schema, capture);
    const params = { source: "vue-blog", items: ["Vue 3.5"] };
    const result = await tool.execute("tool_1", params, undefined, undefined, {} as never);

    expect(tool).toMatchObject({
      name: "structured_output",
      label: "Structured Output",
      parameters: schema,
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Structured output accepted." }],
      details: params,
      terminate: true,
    });
    expect(capture).toHaveBeenCalledWith(params);
  });

  it("should reject schemas that cannot be used as Pi tool parameters", () => {
    expect(() => createWorkflowStructuredOutputTool({ type: "array" }, () => {})).toThrow(
      WorkflowAgentSchemaError,
    );
  });
});
