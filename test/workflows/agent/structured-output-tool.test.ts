import { describe, expect, it } from "vitest";
import {
  createWorkflowStructuredOutputToolBundle,
  WorkflowAgentSchemaError,
} from "#src/workflows/agent/structured-output-tool.ts";

describe("createWorkflowStructuredOutputToolBundle", () => {
  it("should create structured_output and give_up tools", () => {
    const bundle = createWorkflowStructuredOutputToolBundle(objectSchema());

    expect(bundle.tools.map((tool) => tool.name)).toEqual(["structured_output", "give_up"]);
    expect(bundle.toolSchema).toEqual(objectSchema());
    expect(bundle.getOutcome()).toEqual({ type: "pending" });
  });

  it("should capture object-shaped schema output", async () => {
    const bundle = createWorkflowStructuredOutputToolBundle(objectSchema());
    const tool = bundle.tools[0]!;
    const params = { source: "vue-blog", items: ["Vue 3.5"] };

    const result = await tool.execute("tool_1", params as never, undefined, undefined, {} as never);

    expect(result).toEqual({
      content: [{ type: "text", text: "Structured output accepted." }],
      details: params,
      terminate: true,
    });
    expect(bundle.getOutcome()).toEqual({ type: "finished", value: params });
  });

  it("should wrap and unwrap non-object schemas", async () => {
    const schema = { type: "array", items: { type: "string" } };
    const bundle = createWorkflowStructuredOutputToolBundle(schema);

    expect(bundle.toolSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { result: schema },
      required: ["result"],
    });

    await bundle.tools[0]!.execute(
      "tool_1",
      { result: ["one", "two"] } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(bundle.getOutcome()).toEqual({ type: "finished", value: ["one", "two"] });
  });

  it("should record give_up reasons", async () => {
    const bundle = createWorkflowStructuredOutputToolBundle(objectSchema());
    const giveUp = bundle.tools[1]!;

    const result = await giveUp.execute(
      "tool_1",
      { reason: "source did not contain the required data" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Structured output abandoned: source did not contain the required data",
        },
      ],
      details: { reason: "source did not contain the required data" },
      terminate: true,
    });
    expect(bundle.getOutcome()).toEqual({
      type: "gave_up",
      reason: "source did not contain the required data",
    });
  });

  it("should keep the first outcome when tools are called more than once", async () => {
    const bundle = createWorkflowStructuredOutputToolBundle(objectSchema());

    await bundle.tools[0]!.execute(
      "tool_1",
      { source: "first", items: [] } as never,
      undefined,
      undefined,
      {} as never,
    );
    const duplicate = await bundle.tools[1]!.execute(
      "tool_2",
      { reason: "second" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(duplicate).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("already submitted") }],
      details: { outcome: "finished" },
    });
    expect(duplicate).not.toHaveProperty("terminate");
    expect(bundle.getOutcome()).toEqual({
      type: "finished",
      value: { source: "first", items: [] },
    });
  });

  it("should throw schema errors for invalid tool setup", () => {
    expect(() => createWorkflowStructuredOutputToolBundle(null)).toThrow(WorkflowAgentSchemaError);
  });
});

function objectSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      source: { type: "string" },
      items: { type: "array", items: { type: "string" } },
    },
    required: ["source", "items"],
  };
}
