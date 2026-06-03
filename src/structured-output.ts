import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import {
	STRUCTURED_OUTPUT_ANY_SCHEMA_DESCRIPTION,
	STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
	STRUCTURED_OUTPUT_TOOL_NAME,
	STRUCTURED_OUTPUT_TOOL_PROMPT_SNIPPET,
	structuredOutputToolPromptGuidelines,
} from "./prompts/structured-output.js";

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
	return Type.Any({ description: STRUCTURED_OUTPUT_ANY_SCHEMA_DESCRIPTION });
}

export function createStructuredOutputTool({
	schema,
	capture,
	name = STRUCTURED_OUTPUT_TOOL_NAME,
}: StructuredOutputToolOptions): ToolDefinition<any, unknown> {
	return defineTool({
		name,
		label: "Structured Output",
		description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
		promptSnippet: STRUCTURED_OUTPUT_TOOL_PROMPT_SNIPPET,
		promptGuidelines: structuredOutputToolPromptGuidelines(name),
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
