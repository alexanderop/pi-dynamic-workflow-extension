import {
	type CreateAgentSessionOptions,
	createAgentSession,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
		const capture: StructuredOutputCapture = { called: false };
		const runTools = [...this.baseTools, ...(options.tools ?? [])];
		if (options.schema)
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
				await session.prompt(
					this.buildPrompt(prompt, options, Boolean(options.schema)),
				);
			} finally {
				unsubscribe();
			}

			if (options.schema) {
				if (!capture.called)
					throw new Error(
						"Subagent finished without calling structured_output",
					);
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
		const lines = [
			"You are a fresh, isolated Pi subagent running inside a parent workflow.",
			"Do the requested task using the available tools. Be concise and specific.",
		];
		if (options.label) lines.push(`Subagent label: ${options.label}`);
		if (options.instructions) lines.push(options.instructions);
		if (wantsStructuredOutput) {
			lines.push(
				"Your final action MUST be a call to structured_output with data matching its schema. Do not finish with plain prose.",
			);
		}
		lines.push("", "Task:", prompt);
		return lines.join("\n");
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
