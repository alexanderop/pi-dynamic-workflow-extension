import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INPUT_MARKER = "pi-workflow-live-e2e";

const SCRIPT = `export const meta = {
	name: 'e2e_live_runtime',
	description: 'Live API end-to-end workflow',
	phases: [{ title: 'Run' }]
}
const ANSWER_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['status'],
	properties: {
		status: { type: 'string' }
	}
}
phase('Run')
log('started live api call')
const answer = await agent(
	'Return exactly one structured_output call with {"status":"live-agent-ok"}. Do not inspect files, run commands, or add commentary.',
	{
		label: 'live-worker',
		phase: 'Run',
		schema: ANSWER_SCHEMA,
		instructions: 'Keep this response minimal; no filesystem or shell work is required.'
	}
)
return {
	ok: typeof answer.status === 'string' && answer.status.toLowerCase() === args.expected,
	answer
}
`;

interface StoredWorkflowJob {
	id: number;
	runId: string;
	name: string;
	description?: string;
	status: string;
	error?: string;
	result?: unknown;
	snapshot?: {
		phases?: string[];
		logs?: string[];
		agents?: Array<{
			label?: string;
			phase?: string;
			status?: string;
			prompt?: string;
			resultText?: string;
			error?: string;
		}>;
	};
}

interface ProbeState {
	stage: string;
	model?: unknown;
	toolRegistered?: boolean;
	activeTools?: string[];
	workflowToolCallCount?: number;
	workflowToolEnded?: boolean;
	workflowToolError?: boolean;
	toolResultText?: string;
	toolResultDetails?: unknown;
	job?: StoredWorkflowJob;
	error?: string;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function readWorkflowManifests(cwd: string): StoredWorkflowJob[] {
	const root = join(cwd, ".pi", "workflows");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== "scripts")
		.flatMap((entry): StoredWorkflowJob[] => {
			const path = join(root, entry.name, "manifest.json");
			if (!existsSync(path)) return [];
			try {
				return [JSON.parse(readFileSync(path, "utf8")) as StoredWorkflowJob];
			} catch {
				return [];
			}
		})
		.sort((a, b) => a.id - b.id);
}

async function waitForCompletedWorkflow(cwd: string): Promise<StoredWorkflowJob> {
	const timeoutMs = Number(process.env.PI_E2E_LIVE_TIMEOUT_MS ?? 120000);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const jobs = readWorkflowManifests(cwd);
		const completed = jobs.find((job) => job.name === "e2e_live_runtime" && job.status !== "running");
		if (completed) return completed;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(
		`timed out waiting for live workflow; manifests=${JSON.stringify(
			readWorkflowManifests(cwd).map((job) => ({
				id: job.id,
				name: job.name,
				status: job.status,
				error: job.error,
			})),
		)}`,
	);
}

function serializeModel(model: unknown): unknown {
	if (!model || typeof model !== "object") return undefined;
	const record = model as Record<string, unknown>;
	return {
		provider: record.provider,
		id: record.id,
		name: record.name,
	};
}

function textFromToolResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content.find(
		(item): item is { type: "text"; text: string } =>
			Boolean(item) &&
			typeof item === "object" &&
			(item as { type?: unknown }).type === "text" &&
			typeof (item as { text?: unknown }).text === "string",
	);
	return text?.text;
}

function detailsFromToolResult(result: unknown): unknown {
	return result && typeof result === "object" ? (result as { details?: unknown }).details : undefined;
}

function buildPrompt(): string {
	return [
		"This is an automated live end-to-end test of the installed workflow extension.",
		"You MUST call the workflow tool exactly once now. Do not answer in prose before calling it.",
		"Use exactly this workflow tool input:",
		JSON.stringify(
			{
				script: SCRIPT,
				args: { expected: "live-agent-ok" },
			},
			null,
			2,
		),
		"After the workflow tool returns, respond only with: workflow submitted",
	].join("\n\n");
}

export default function workflowRuntimeLiveProbe(pi: ExtensionAPI) {
	let outputPath: string | undefined;
	let armed = false;
	let finalizing = false;
	let workflowToolCallCount = 0;
	let workflowToolEnded = false;
	let workflowToolError = false;
	let toolResultText: string | undefined;
	let toolResultDetails: unknown;

	async function writeState(state: ProbeState): Promise<void> {
		if (!outputPath) return;
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	}

	pi.on("input", async (event, ctx) => {
		if (event.text.trim() !== INPUT_MARKER) return { action: "continue" };
		outputPath = requireEnv("PI_E2E_OUT");

		const toolRegistered = pi.getAllTools().some((tool) => tool.name === "workflow");
		if (!toolRegistered) {
			await writeState({
				stage: "error",
				model: serializeModel(ctx.model),
				toolRegistered: false,
				activeTools: pi.getActiveTools(),
				error: "workflow tool was not registered",
			});
			return { action: "handled" };
		}

		workflowToolCallCount = 0;
		workflowToolEnded = false;
		workflowToolError = false;
		toolResultText = undefined;
		toolResultDetails = undefined;
		finalizing = false;
		armed = true;

		pi.setActiveTools(["workflow"]);
		await writeState({
			stage: "prompting",
			model: serializeModel(ctx.model),
			toolRegistered: true,
			activeTools: pi.getActiveTools(),
		});

		return { action: "transform", text: buildPrompt() };
	});

	pi.on("before_agent_start", (event) => {
		if (!armed) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\nAutomated e2e constraint: for this turn, calling the workflow tool is mandatory. Use the exact script and args supplied by the user. Do not call any other tool.`,
		};
	});

	pi.on("tool_execution_start", (event) => {
		if (armed && event.toolName === "workflow") workflowToolCallCount += 1;
	});

	pi.on("tool_execution_end", (event) => {
		if (!armed || event.toolName !== "workflow") return;
		workflowToolEnded = true;
		workflowToolError = Boolean(event.isError);
		toolResultText = textFromToolResult(event.result);
		toolResultDetails = detailsFromToolResult(event.result);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!armed || finalizing) return;
		finalizing = true;
		try {
			const job = await waitForCompletedWorkflow(ctx.cwd);
			await writeState({
				stage: "done",
				model: serializeModel(ctx.model),
				toolRegistered: pi.getAllTools().some((tool) => tool.name === "workflow"),
				activeTools: pi.getActiveTools(),
				workflowToolCallCount,
				workflowToolEnded,
				workflowToolError,
				toolResultText,
				toolResultDetails,
				job,
			});
		} catch (error) {
			await writeState({
				stage: "error",
				model: serializeModel(ctx.model),
				toolRegistered: pi.getAllTools().some((tool) => tool.name === "workflow"),
				activeTools: pi.getActiveTools(),
				workflowToolCallCount,
				workflowToolEnded,
				workflowToolError,
				toolResultText,
				toolResultDetails,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			armed = false;
			ctx.shutdown();
		}
	});
}
