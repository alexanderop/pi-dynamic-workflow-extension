import { homedir } from "node:os";
import { join } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	createFileWorkflowLibrary,
	createFileWorkflowStore,
	createWorkflowManager,
	createWorkflowTool,
	renderWorkflowReportText,
	type SavedWorkflowEntry,
	selectWorkflowReport,
	WorkflowBrowser,
	type WorkflowJob,
} from "../src/index.js";
import {
	highlightWorkflowTriggerWords,
	transformNativeWorkflowInput,
} from "../src/workflow-trigger.js";

class WorkflowTriggerEditor extends CustomEditor {
	render(width: number): string[] {
		return super.render(width).map(highlightWorkflowTriggerWords);
	}
}

export default function extension(pi: ExtensionAPI) {
	const manager = createWorkflowManager();
	const workflowTool = createWorkflowTool({ manager });
	const globalWorkflowLibrary = createFileWorkflowLibrary(
		join(homedir(), ".pi", "agent", "workflows"),
	);
	const announcedRuns = new Set<string>();
	const currentSessionRunIds = new Set<string>();
	const registeredSavedWorkflowCommands = new Set<string>();
	let unsubscribeStatus: (() => void) | undefined;
	let detachAgentAbortListener: (() => void) | undefined;

	pi.registerTool(workflowTool);

	pi.on("input", async (event) => transformNativeWorkflowInput(event));

	pi.registerMessageRenderer(
		"workflow-completion",
		(message, _options, theme) => {
			const details = message.details as
				| { jobId?: number; runId?: string; name?: string; status?: string }
				| undefined;
			const status = details?.status ?? "done";
			const color = status === "done" ? "success" : "warning";
			const jobLabel = details?.jobId ? `#${details.jobId}` : "";
			const name = details?.name ? ` (${details.name})` : "";
			return new Text(
				`${theme.fg(color, `Workflow ${jobLabel}${name} ${status}`)} — main agent notified. Open /workflows for details.`,
				0,
				0,
			);
		},
	);

	pi.registerCommand("workflows", {
		description: "Show live background workflow dashboards",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/workflows requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) =>
					new WorkflowBrowser(manager, tui, theme, done),
			);
		},
	});

	pi.registerCommand("workflow-save", {
		description: "Save a workflow job globally as a slash command",
		handler: async (args, ctx) => {
			const [idText, name] = args.trim().split(/\s+/, 2);
			const id = Number(idText);
			if (!Number.isInteger(id)) {
				ctx.ui.notify("Usage: /workflow-save <job-id> [command-name]", "error");
				return;
			}
			const job = manager.getJob(id);
			if (!job) {
				ctx.ui.notify(`Workflow #${id} was not found`, "error");
				return;
			}
			const entry = globalWorkflowLibrary.save(job.script, name || job.name);
			registerSavedWorkflowCommand(entry);
			ctx.ui.notify(
				`Saved workflow #${id} globally as /${entry.name} (${entry.path})`,
				"info",
			);
		},
	});

	pi.registerCommand("workflow-resume", {
		description: "Resume a persisted workflow job by numeric id",
		handler: async (args, ctx) => {
			const id = Number(args.trim());
			if (!Number.isInteger(id)) {
				ctx.ui.notify("Usage: /workflow-resume <job-id>", "error");
				return;
			}
			const job = manager.resume(id, {
				cwd: ctx.cwd,
				session: {
					modelRegistry: ctx.modelRegistry,
					model: ctx.model,
				},
			});
			if (!job) {
				ctx.ui.notify(`Workflow #${id} was not found`, "error");
				return;
			}
			announcedRuns.delete(job.runId);
			ctx.ui.notify(`Workflow #${id} resumed`, "info");
		},
	});

	function registerSavedWorkflowCommand(entry: SavedWorkflowEntry): void {
		if (registeredSavedWorkflowCommands.has(entry.name)) return;
		registeredSavedWorkflowCommands.add(entry.name);
		pi.registerCommand(entry.name, {
			description: `Run saved workflow: ${entry.description}`,
			handler: async (commandArgs, ctx) => {
				const current = globalWorkflowLibrary.get(entry.name);
				if (!current) {
					ctx.ui.notify(
						`Saved workflow /${entry.name} no longer exists`,
						"error",
					);
					return;
				}
				const job = manager.start(current.script, {
					cwd: ctx.cwd,
					args: commandArgs.trim() || undefined,
					session: {
						modelRegistry: ctx.modelRegistry,
						model: ctx.model,
					},
				});
				ctx.ui.notify(
					`Started saved workflow /${entry.name} as #${job.id}. You will be notified when it finishes.`,
					"info",
				);
			},
		});
	}

	function registerSavedWorkflowCommands(): void {
		for (const entry of globalWorkflowLibrary.list()) {
			registerSavedWorkflowCommand(entry);
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		const jobs = manager.getJobs();
		const running = jobs.filter((job) => job.status === "running").length;
		if (running > 0) {
			ctx.ui.setStatus(
				"workflow",
				ctx.ui.theme.fg("accent", `workflows:${running}`),
			);
			return;
		}
		ctx.ui.setStatus("workflow", undefined);
	}

	function formatWorkflowCompletion(job: WorkflowJob): string {
		const statusLine =
			job.status === "done"
				? "completed successfully"
				: job.status === "cancelled"
					? "was cancelled"
					: job.status === "interrupted"
						? "was interrupted"
						: "failed";
		const report = renderWorkflowReportText(selectWorkflowReport(job));
		const message = `Background workflow #${job.id} (${job.name}) ${statusLine}.\n\n${report}\n\nPlease summarize this workflow outcome for the user and suggest any useful next step. The interactive details remain available in /workflows.`;
		const maxLength = 30_000;
		if (message.length <= maxLength) return message;
		return `${message.slice(0, maxLength)}\n\n[Workflow completion message truncated. Open /workflows for the full result.]`;
	}

	function announceCompletedWorkflow(
		job: WorkflowJob,
		ctx: ExtensionContext,
	): void {
		if (
			job.status === "running" ||
			job.status === "interrupted" ||
			!currentSessionRunIds.has(job.runId) ||
			announcedRuns.has(job.runId)
		)
			return;
		announcedRuns.add(job.runId);
		pi.appendEntry("workflow-notification-sent", {
			runId: job.runId,
			jobId: job.id,
			name: job.name,
			status: job.status,
		});

		const message = formatWorkflowCompletion(job);
		ctx.ui.notify(
			`Workflow #${job.id} ${job.status === "done" ? "completed" : job.status}`,
			job.status === "done" ? "info" : "warning",
		);
		pi.sendMessage(
			{
				customType: "workflow-completion",
				content: message,
				display: true,
				details: {
					jobId: job.id,
					runId: job.runId,
					name: job.name,
					status: job.status,
				},
			},
			ctx.isIdle()
				? { triggerTurn: true }
				: { triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function watchAgentAbort(ctx: ExtensionContext): void {
		detachAgentAbortListener?.();
		detachAgentAbortListener = undefined;
		const signal = ctx.signal;
		if (!signal) return;
		const onAbort = () => manager.interruptAll();
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		detachAgentAbortListener = () =>
			signal.removeEventListener("abort", onAbort);
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new WorkflowTriggerEditor(tui, theme, keybindings),
		);

		currentSessionRunIds.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				entry.customType === "workflow-notification-sent"
			) {
				const data = entry.data as { runId?: string } | undefined;
				if (data?.runId) announcedRuns.add(data.runId);
			}
		}
		manager.attachStore(
			createFileWorkflowStore(join(ctx.cwd, ".pi", "workflows")),
		);
		registerSavedWorkflowCommands();

		const active = pi.getActiveTools();
		if (!active.includes(workflowTool.name)) {
			pi.setActiveTools([...active, workflowTool.name]);
		}

		unsubscribeStatus?.();
		unsubscribeStatus = manager.onChange((job) => {
			if (job.status === "running") currentSessionRunIds.add(job.runId);
			updateStatus(ctx);
			announceCompletedWorkflow(job, ctx);
		});
		updateStatus(ctx);
	});

	pi.on("agent_start", (_event, ctx) => watchAgentAbort(ctx));
	pi.on("agent_end", () => {
		detachAgentAbortListener?.();
		detachAgentAbortListener = undefined;
	});

	pi.on("session_shutdown", () => {
		unsubscribeStatus?.();
		unsubscribeStatus = undefined;
		detachAgentAbortListener?.();
		detachAgentAbortListener = undefined;
		manager.interruptAll();
	});
}
