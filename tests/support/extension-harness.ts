import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowExtensionDeps } from "../../src/extension/workflow-extension-deps.js";
import { formatWorkflowCompletion } from "../../src/extension/workflow-extension-format.js";
import type { WorkflowAgentLike } from "../../src/workflow.js";
import { WorkflowBrowser } from "../../src/workflow-browser.js";
import { createFileWorkflowLibrary } from "../../src/workflow-library.js";
import { createFileWorkflowStore, createWorkflowManager, type WorkflowManager } from "../../src/workflow-manager.js";
import { createWorkflowTool } from "../../src/workflow-tool.js";
import { createResolvingWorkflowAgent } from "./faux-workflow-agent.js";
import { createTempDir } from "./temp-dir.js";
import { waitForCondition } from "./wait.js";

type HarnessHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export interface RegisteredCommand {
	description?: string;
	handler(args: string, ctx: ExtensionContextLike): Promise<void> | void;
}

export interface ExtensionContextLike {
	cwd: string;
	hasUI: boolean;
	ui: {
		theme: { fg(color: string, text: string): string };
		notify(message: string, level?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
		confirm(title: string, message: string): Promise<boolean>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		editor(title: string, prefill?: string): Promise<string | undefined>;
		custom<T>(factory: unknown): Promise<T>;
		setEditorComponent(factory: unknown): void;
	};
	sessionManager: { getEntries(): unknown[] };
	modelRegistry: unknown;
	model: unknown;
	isIdle(): boolean;
}

export interface ExtensionHarness {
	pi: ExtensionAPI;
	deps: WorkflowExtensionDeps;
	manager: WorkflowManager;
	commands: Map<string, RegisteredCommand>;
	tools: ToolDefinition[];
	handlers: {
		input: HarnessHandler[];
		session_start: HarnessHandler[];
		session_shutdown: HarnessHandler[];
	};
	entries: unknown[];
	sentMessages: Array<{ message: unknown; options: unknown }>;
	notifications: Array<{ message: string; level: string }>;
	statuses: Map<string, string | undefined>;
	ctx: ExtensionContextLike;
	globalWorkflowsDir: string;
	activeTools: string[];
	confirmResult: boolean;
	inputResults: Array<string | undefined>;
	editorResults: Array<string | undefined>;
	startSession(): Promise<void>;
	shutdownSession(): Promise<void>;
	runCommand(name: string, args?: string): Promise<void>;
	runTool(name: string, params: unknown): Promise<unknown>;
	cleanup(): Promise<void>;
}

export async function createWorkflowExtensionHarness(
	options: { agent?: WorkflowAgentLike } = {},
): Promise<ExtensionHarness> {
	const project = await createTempDir("pi-workflow-extension-project-");
	const global = await createTempDir("pi-workflow-extension-global-");
	const agent = options.agent ?? createResolvingWorkflowAgent("ok");
	const manager = createWorkflowManager();
	const commands = new Map<string, RegisteredCommand>();
	const tools: ToolDefinition[] = [];
	const handlers = {
		input: [] as HarnessHandler[],
		session_start: [] as HarnessHandler[],
		session_shutdown: [] as HarnessHandler[],
	};
	const entries: unknown[] = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string | undefined>();
	let activeTools: string[] = [];
	let confirmResult = true;
	const inputResults: Array<string | undefined> = [];
	const editorResults: Array<string | undefined> = [];

	const ctx: ExtensionContextLike = {
		cwd: project.path,
		hasUI: true,
		ui: {
			theme: {
				fg(_color, text) {
					return text;
				},
			},
			notify(message, level = "info") {
				notifications.push({ message, level });
			},
			setStatus(key, text) {
				statuses.set(key, text);
			},
			async confirm() {
				return confirmResult;
			},
			async input() {
				return inputResults.shift();
			},
			async editor() {
				return editorResults.shift();
			},
			async custom<T>() {
				return undefined as T;
			},
			setEditorComponent() {},
		},
		sessionManager: {
			getEntries() {
				return entries;
			},
		},
		modelRegistry: {},
		model: undefined,
		isIdle() {
			return true;
		},
	};

	const pi = {
		on(event: string, handler: HarnessHandler) {
			if (event === "input" || event === "session_start" || event === "session_shutdown") {
				handlers[event].push(handler);
			}
		},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerMessageRenderer() {},
		sendMessage(message: unknown, sendOptions: unknown) {
			sentMessages.push({ message, options: sendOptions });
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(toolNames: string[]) {
			activeTools = [...toolNames];
		},
	} as unknown as ExtensionAPI;

	const deps: WorkflowExtensionDeps = {
		manager,
		workflowTool: createWorkflowTool({ manager, agent }),
		globalWorkflowLibrary: createFileWorkflowLibrary(global.path),
		createWorkflowStore(cwd) {
			return createFileWorkflowStore(join(cwd, ".pi", "workflows"));
		},
		createBrowser(browserManager, tui, theme, done, actions) {
			return new WorkflowBrowser(browserManager, tui, theme, done, actions);
		},
		formatCompletion: formatWorkflowCompletion,
		startOptions: { agent },
	};

	return {
		pi,
		deps,
		manager,
		commands,
		tools,
		handlers,
		entries,
		sentMessages,
		notifications,
		statuses,
		ctx,
		globalWorkflowsDir: global.path,
		get activeTools() {
			return activeTools;
		},
		get confirmResult() {
			return confirmResult;
		},
		set confirmResult(value: boolean) {
			confirmResult = value;
		},
		inputResults,
		editorResults,
		async startSession() {
			for (const handler of handlers.session_start) {
				await handler({ type: "session_start", reason: "startup" }, ctx);
			}
		},
		async shutdownSession() {
			for (const handler of handlers.session_shutdown) {
				await handler({ type: "session_shutdown", reason: "quit" }, ctx);
			}
		},
		async runCommand(name, args = "") {
			const command = commands.get(name);
			if (!command) throw new Error(`command not registered: ${name}`);
			await command.handler(args, ctx);
		},
		async runTool(name, params) {
			const tool = tools.find((item) => item.name === name);
			if (!tool) throw new Error(`tool not registered: ${name}`);
			return tool.execute("call-1", params as never, undefined, undefined, ctx as never);
		},
		async cleanup() {
			await rm(project.path, { recursive: true, force: true });
			await rm(global.path, { recursive: true, force: true });
		},
	};
}

export async function waitForJobStatus(manager: WorkflowManager, status: string): Promise<void> {
	await waitForCondition(
		() => manager.getJobs().some((job) => job.status === status),
		`timed out waiting for job status ${status}`,
		{
			describe: () =>
				`jobs=${JSON.stringify(manager.getJobs().map((job) => ({ status: job.status, error: job.error })))}`,
		},
	);
}
