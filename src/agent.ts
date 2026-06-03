import {
	type CreateAgentSessionOptions,
	createAgentSession,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	buildStructuredOutputRepairPrompt,
	STRUCTURED_OUTPUT_TOOL_NAME,
	structuredOutputMissingError,
} from "./prompts/structured-output.js";
import { buildWorkflowSubagentPrompt } from "./prompts/workflow-agent.js";
import {
	createStructuredOutputTool,
	type StructuredOutputCapture,
} from "./structured-output.js";

export interface AgentRunOptions {
	label?: string;
	schema?: unknown;
	signal?: AbortSignal;
	instructions?: string;
	tools?: ToolDefinition[];
	onActivity?: (event: {
		type: "text" | "tool" | "log";
		text?: string;
		toolName?: string;
		argsPreview?: string;
	}) => void;
}

export interface WorkflowAgentOptions {
	cwd?: string;
	session?: Partial<CreateAgentSessionOptions>;
	tools?: ToolDefinition[];
}

export interface WorkflowAgentPromptSession {
	prompt(prompt: string): Promise<unknown>;
	setActiveToolsByName(toolNames: string[]): void;
}

export interface WorkflowAgentPromptRunOptions {
	session: WorkflowAgentPromptSession;
	initialPrompt: string;
	wantsStructuredOutput: boolean;
	capture: StructuredOutputCapture;
	onActivity?: AgentRunOptions["onActivity"];
}

export async function runWorkflowAgentPrompts({
	session,
	initialPrompt,
	wantsStructuredOutput,
	capture,
	onActivity,
}: WorkflowAgentPromptRunOptions): Promise<void> {
	await session.prompt(initialPrompt);
	if (!wantsStructuredOutput || capture.called) return;

	onActivity?.({
		type: "log",
		text: "Subagent omitted structured_output; requesting one repair turn.",
	});
	session.setActiveToolsByName([STRUCTURED_OUTPUT_TOOL_NAME]);
	await session.prompt(buildStructuredOutputRepairPrompt());
}

export class WorkflowAgent {
	private readonly cwd: string;
	private readonly baseTools: ToolDefinition[];
	private readonly sessionOptions: Partial<CreateAgentSessionOptions>;

	constructor(options: WorkflowAgentOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.baseTools = options.tools ?? [];
		this.sessionOptions = options.session ?? {};
	}

	async run(prompt: string, options: AgentRunOptions = {}): Promise<unknown> {
		const wantsStructuredOutput = Object.hasOwn(options, "schema");
		const capture: StructuredOutputCapture = { called: false };
		const runTools = [...this.baseTools, ...(options.tools ?? [])];
		if (wantsStructuredOutput)
			runTools.push(
				createStructuredOutputTool({ schema: options.schema, capture }),
			);

		const { customTools: sessionCustomTools, ...restSessionOptions } =
			this.sessionOptions;
		const { session } = await createAgentSession({
			cwd: this.cwd,
			agentDir: getAgentDir(),
			sessionManager: SessionManager.inMemory(this.cwd),
			settingsManager: SettingsManager.create(this.cwd, getAgentDir()),
			customTools: [
				...((sessionCustomTools as ToolDefinition[] | undefined) ?? []),
				...runTools,
			],
			...restSessionOptions,
		});

		let removeAbortListener: (() => void) | undefined;
		try {
			if (options.signal) {
				const onAbort = () => void session.abort();
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () =>
					options.signal?.removeEventListener("abort", onAbort);
			}

			const unsubscribe = session.subscribe((event) => {
				if (!options.onActivity) return;
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					options.onActivity({
						type: "text",
						text: event.assistantMessageEvent.delta,
					});
				}
				if (event.type === "tool_execution_start") {
					options.onActivity({
						type: "tool",
						toolName: event.toolName,
						argsPreview: previewArgs(event.args),
					});
				}
			});

			try {
				await runWorkflowAgentPrompts({
					session,
					initialPrompt: this.buildPrompt(
						prompt,
						options,
						wantsStructuredOutput,
					),
					wantsStructuredOutput,
					capture,
					onActivity: options.onActivity,
				});
			} finally {
				unsubscribe();
			}

			if (wantsStructuredOutput) {
				if (!capture.called) throw structuredOutputMissingError();
				return capture.value;
			}

			return this.lastAssistantText(session.messages);
		} finally {
			removeAbortListener?.();
			session.dispose();
		}
	}

	private buildPrompt(
		prompt: string,
		options: AgentRunOptions,
		wantsStructuredOutput: boolean,
	): string {
		return buildWorkflowSubagentPrompt({
			prompt,
			label: options.label,
			instructions: options.instructions,
			wantsStructuredOutput,
		});
	}

	private lastAssistantText(messages: unknown[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as
				| { role?: string; content?: unknown }
				| undefined;
			if (message?.role !== "assistant") continue;
			const parts = Array.isArray(message.content) ? message.content : [];
			const text = parts
				.filter(
					(part): part is { type: "text"; text: string } =>
						Boolean(part) &&
						typeof part === "object" &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string",
				)
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
		return "";
	}
}

function previewArgs(args: unknown): string {
	try {
		const text = JSON.stringify(args ?? {});
		return text.length > 160 ? `${text.slice(0, 159)}…` : text;
	} catch {
		return "[unserializable args]";
	}
}
