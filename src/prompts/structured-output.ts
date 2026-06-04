export const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

export const STRUCTURED_OUTPUT_ANY_SCHEMA_DESCRIPTION = "Final structured output value";

export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION = "Return the final machine-readable result for this subagent task.";

export const STRUCTURED_OUTPUT_TOOL_PROMPT_SNIPPET = "Return the final machine-readable result for this subagent task";

export function structuredOutputToolPromptGuidelines(name: string): string[] {
	return [
		`Use ${name} as the final action when the subagent prompt asks for structured output.`,
		`After calling ${name}, do not emit another assistant response in the same turn.`,
	];
}

export const STRUCTURED_OUTPUT_PROMPT_CONTRACT = [
	"The parent workflow requested structured output.",
	"The parent workflow only receives the structured_output tool arguments, not your prose. If you do not call structured_output, the workflow fails.",
	"Complete the requested task first, then make your final action exactly one structured_output call with data matching its schema.",
	"Do not finish with plain prose.",
	"Do not wrap the result in markdown.",
	"Do not call structured_output until you have completed the task.",
] as const;

export function buildStructuredOutputRepairPrompt(name = STRUCTURED_OUTPUT_TOOL_NAME): string {
	return [
		`You finished without calling ${name}.`,
		"The parent workflow cannot continue until it receives the structured tool arguments.",
		"Do not redo the task or answer in prose.",
		`Make your next and final action exactly one ${name} call with the final result matching the requested schema.`,
	].join("\n");
}

export function structuredOutputMissingError(): Error {
	const error = new Error("Subagent finished without calling structured_output");
	error.name = "StructuredOutputMissingError";
	return error;
}
