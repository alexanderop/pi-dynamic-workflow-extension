import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	createToolUpdateWorkflowDisplay,
	createWorkflowSnapshot,
	preview,
	updateSnapshotStats,
	type WorkflowSnapshot,
} from "./display.js";
import {
	parseWorkflowScript,
	type RunWorkflowOptions,
	runWorkflow,
} from "./workflow.js";
import { WorkflowDashboard } from "./workflow-dashboard.js";
import {
	cloneWorkflowSnapshot,
	createWorkflowManager,
	type WorkflowManager,
} from "./workflow-manager.js";

const workflowToolSchema = Type.Object({
	script: Type.String({
		description: [
			"Required raw JavaScript workflow script, with no Markdown fences.",
			"First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }.",
			"Use phase(title), agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), log(message), args, cwd, and budget.",
			"parallel() requires functions, not promises.",
		].join(" "),
	}),
	args: Type.Optional(
		Type.Any({ description: "Optional JSON value exposed as global `args`." }),
	),
});

export type WorkflowToolInput = Static<typeof workflowToolSchema>;

export interface WorkflowToolOptions
	extends Pick<
		RunWorkflowOptions,
		"cwd" | "agent" | "concurrency" | "maxEstimatedTokens"
	> {
	/** Shared manager used by /workflows to show live background runs. */
	manager?: WorkflowManager;
	/** Defaults to true when a manager is provided, otherwise false. */
	background?: boolean;
}

export function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
	if (typeof args === "string") return { script: args };
	if (!args || typeof args !== "object") return args as WorkflowToolInput;
	const input = args as Record<string, unknown>;
	if (typeof input.script === "string")
		return {
			...input,
			script: normalizeWorkflowScript(input.script),
		} as WorkflowToolInput;
	return args as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
	return script.trim();
}

function cloneDetails(snapshot: WorkflowSnapshot): WorkflowSnapshot {
	return {
		...snapshot,
		phases: [...snapshot.phases],
		logs: [...snapshot.logs],
		agents: snapshot.agents.map((agent) => ({
			...agent,
			activity: agent.activity ? [...agent.activity] : undefined,
		})),
	};
}

export function createWorkflowTool(options: WorkflowToolOptions = {}) {
	const manager = options.manager ?? createWorkflowManager();
	const runInBackground = options.background ?? Boolean(options.manager);

	return defineTool({
		name: "workflow",
		label: "Workflow",
		description:
			"Execute a deterministic JavaScript workflow that orchestrates multiple isolated Pi subagents.",
		promptSnippet:
			"Run a JavaScript orchestration workflow with isolated subagents",
		promptGuidelines: [
			"Use workflow only when the user explicitly asks for a workflow, workflows, fan-out, multi-agent orchestration, or a planned multi-step agent run.",
			"For workflow, always pass one raw JavaScript string in the required script parameter; do not include Markdown fences.",
			"For workflow, the first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty description' }` with literal-only values.",
			"For workflow, call phase(title) before groups of related agent work so progress is visible.",
			"For workflow, call agent(prompt, opts) at least once; subagents are isolated, so each prompt must include enough file paths and context.",
			"For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent(...)))`.",
			"For workflow, always await agent(), parallel(), and pipeline() before returning a JSON-serializable result.",
			"For workflow, do not use Date.now(), new Date(), Math.random(), require, import, fs, network APIs, or direct filesystem access in the script; delegate work to agent().",
			"When workflow returns a background job id, do not poll, wait, or re-run it; continue normally because the extension will send a workflow-completion message when the job finishes.",
		],
		parameters: workflowToolSchema,
		prepareArguments(args) {
			return normalizeWorkflowToolArgs(args);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Workflow was aborted");
			const script = normalizeWorkflowScript(params.script);

			if (runInBackground) {
				const job = manager.start(script, {
					cwd: options.cwd ?? ctx.cwd,
					args: params.args,
					agent: options.agent,
					concurrency: options.concurrency,
					maxEstimatedTokens: options.maxEstimatedTokens,
					session: {
						modelRegistry: ctx.modelRegistry,
						model: ctx.model,
					},
				});
				const snapshot = cloneWorkflowSnapshot(job.snapshot);
				snapshot.logs.push(
					"Open /workflows for the interactive live dashboard.",
				);
				createToolUpdateWorkflowDisplay(onUpdate).update(snapshot);
				const scriptNote = job.scriptPath
					? ` The reusable workflow script was saved at ${job.scriptPath}.`
					: "";
				return {
					content: [
						{
							type: "text",
							text: `Workflow ${job.name} started in the background as #${job.id}.${scriptNote} Use /workflows to watch progress, navigate agents, cancel, and inspect the final result. Do not poll, wait, or re-run it; the extension will notify you with a workflow-completion message when it finishes. When you receive that message, summarize the outcome for the user and suggest a useful next step.`,
						},
					],
					details: snapshot,
				};
			}

			const startedAt = Date.now();
			const parsed = parseWorkflowScript(script);
			const snapshot = createWorkflowSnapshot(parsed.meta);
			const display = createToolUpdateWorkflowDisplay(onUpdate);

			const emit = () => {
				snapshot.durationMs = Date.now() - startedAt;
				updateSnapshotStats(snapshot);
				display.update(snapshot);
			};

			emit();
			const result = await runWorkflow(script, {
				cwd: options.cwd ?? ctx.cwd,
				args: params.args,
				signal,
				agent: options.agent,
				concurrency: options.concurrency,
				maxEstimatedTokens: options.maxEstimatedTokens,
				session: {
					modelRegistry: ctx.modelRegistry,
					model: ctx.model,
				},
				onPhase(title) {
					snapshot.currentPhase = title;
					if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
					emit();
				},
				onLog(message) {
					snapshot.logs.push(message);
					emit();
				},
				onAgentStart(event) {
					const now = Date.now();
					snapshot.agents.push({
						id: event.id,
						label: event.label,
						phase: event.phase,
						prompt: event.prompt,
						status: event.cached ? "done" : "running",
						startedAt: now,
						model: event.model,
						toolCount: 0,
						activity: [],
						cached: event.cached,
					});
					emit();
				},
				onAgentActivity(event) {
					const agent = snapshot.agents.find((item) => item.id === event.id);
					if (!agent) return;
					if (event.type === "tool")
						agent.toolCount = (agent.toolCount ?? 0) + 1;
					agent.activity = [
						...(agent.activity ?? []),
						{
							type: event.type,
							text: event.text,
							toolName: event.toolName,
							argsPreview: event.argsPreview,
						},
					].slice(-12);
					emit();
				},
				onAgentEnd(event) {
					const agent = snapshot.agents.find((item) => item.id === event.id);
					if (agent) {
						agent.status = event.result === null ? "error" : "done";
						agent.endedAt = Date.now();
						agent.resultPreview = preview(event.result);
						agent.resultText =
							typeof event.result === "string"
								? event.result
								: JSON.stringify(event.result, null, 2);
						if (event.error) agent.error = event.error.message;
					}
					emit();
				},
			});

			if (result.agentCount === 0) {
				throw new Error("workflow scripts must call agent() at least once");
			}

			snapshot.currentPhase = undefined;
			snapshot.durationMs = Date.now() - startedAt;
			snapshot.result = result.result;
			for (const agent of snapshot.agents) {
				if (agent.status === "running" || agent.status === "queued") {
					agent.status = signal?.aborted ? "skipped" : "done";
					agent.endedAt = agent.endedAt ?? Date.now();
				}
			}
			updateSnapshotStats(snapshot);
			display.complete(snapshot);

			return {
				content: [
					{
						type: "text",
						text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${JSON.stringify(
							result.result,
							null,
							2,
						)}`,
					},
				],
				details: cloneDetails(snapshot),
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const snapshot = result.details as WorkflowSnapshot | undefined;
			if (snapshot?.name)
				return new WorkflowDashboard(snapshot, theme, !isPartial);
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? text.text : "workflow", 0, 0);
		},
	});
}
