import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	cloneWorkflowSnapshot,
	createToolUpdateWorkflowDisplay,
	createWorkflowSnapshot,
	updateSnapshotStats,
	type WorkflowSnapshot,
} from "../display.js";
import {
	buildWorkflowToolBackgroundStartMessage,
	WORKFLOW_TOOL_DESCRIPTION,
	WORKFLOW_TOOL_PROMPT_GUIDELINES,
	WORKFLOW_TOOL_PROMPT_SNIPPET,
	WORKFLOW_TOOL_SCRIPT_DESCRIPTION,
} from "../prompts/workflow-tool.js";
import { parseWorkflowScript, type RunWorkflowOptions, runWorkflow, safeJsonStringify } from "../workflow.js";
import { WorkflowDashboard } from "../workflow-dashboard.js";
import { createWorkflowManager, type WorkflowManager } from "../workflow-manager.js";
import { applyWorkflowSnapshotSuccess, createWorkflowSnapshotEventHandlers } from "../workflow-snapshot-events.js";

export const workflowToolSchema = Type.Object({
	script: Type.String({
		description: WORKFLOW_TOOL_SCRIPT_DESCRIPTION,
	}),
	args: Type.Optional(Type.Any({ description: "Optional JSON value exposed as global `args`." })),
});

export type WorkflowToolInput = Static<typeof workflowToolSchema>;

export interface WorkflowToolOptions extends Pick<
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

export function createWorkflowTool(options: WorkflowToolOptions = {}) {
	const manager = options.manager ?? createWorkflowManager();
	const runInBackground = options.background ?? Boolean(options.manager);

	return defineTool({
		name: "workflow",
		label: "Workflow",
		description: WORKFLOW_TOOL_DESCRIPTION,
		promptSnippet: WORKFLOW_TOOL_PROMPT_SNIPPET,
		promptGuidelines: [...WORKFLOW_TOOL_PROMPT_GUIDELINES],
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
				snapshot.logs.push("Open /workflows for the interactive live dashboard.");
				createToolUpdateWorkflowDisplay(onUpdate).update(snapshot);
				return {
					content: [
						{
							type: "text",
							text: buildWorkflowToolBackgroundStartMessage({
								name: job.name,
								id: job.id,
								scriptPath: job.scriptPath,
							}),
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
				...createWorkflowSnapshotEventHandlers(snapshot, { emit }),
			});

			if (result.agentCount === 0) {
				throw new Error("workflow scripts must call agent() at least once");
			}

			snapshot.durationMs = Date.now() - startedAt;
			applyWorkflowSnapshotSuccess(snapshot, result);
			updateSnapshotStats(snapshot);
			display.complete(snapshot);

			return {
				content: [
					{
						type: "text",
						text: `Workflow ${result.meta.name} completed with ${result.agentCount} agent(s).\n\nResult:\n${safeJsonStringify(
							result.result,
							"workflow result",
							2,
						)}`,
					},
				],
				details: cloneWorkflowSnapshot(snapshot),
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			const snapshot = result.details as WorkflowSnapshot | undefined;
			if (snapshot?.name) return new WorkflowDashboard(snapshot, theme, !isPartial);
			const text = result.content?.[0];
			return new Text(text?.type === "text" ? text.text : "workflow", 0, 0);
		},
	});
}
