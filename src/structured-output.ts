import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

export interface StructuredOutputCapture {
	called: boolean;
	value?: unknown;
}

export interface StructuredOutputToolOptions {
	schema: unknown;
	capture: StructuredOutputCapture;
	name?: string;
}

function asToolSchema(schema: unknown): TSchema {
	if (schema && typeof schema === "object") return schema as TSchema;
	return Type.Any({ description: "Final structured output value" });
}

export function createStructuredOutputTool({
	schema,
	capture,
	name = "structured_output",
}: StructuredOutputToolOptions): ToolDefinition<any, unknown> {
	return defineTool({
		name,
		label: "Structured Output",
		description:
			"Return the final machine-readable result for this subagent task.",
		promptSnippet:
			"Return the final machine-readable result for this subagent task",
		promptGuidelines: [
			`Use ${name} as the final action when the subagent prompt asks for structured output.`,
			`After calling ${name}, do not emit another assistant response in the same turn.`,
		],
		parameters: asToolSchema(schema),
		async execute(_toolCallId, params) {
			capture.called = true;
			capture.value = params;
			return {
				content: [{ type: "text", text: "Structured output received." }],
				details: params,
				terminate: true,
			};
		},
	});
}
