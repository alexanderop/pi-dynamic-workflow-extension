import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createWorkflowManager,
	createWorkflowTool,
	WorkflowBrowser,
} from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
	const manager = createWorkflowManager();
	const workflowTool = createWorkflowTool({ manager });
	let unsubscribeStatus: (() => void) | undefined;

	pi.registerTool(workflowTool);

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

	pi.on("session_start", (_event, ctx) => {
		const active = pi.getActiveTools();
		if (!active.includes(workflowTool.name)) {
			pi.setActiveTools([...active, workflowTool.name]);
		}

		unsubscribeStatus?.();
		unsubscribeStatus = manager.onChange(() => updateStatus(ctx));
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubscribeStatus?.();
		unsubscribeStatus = undefined;
		manager.cancelAll();
	});
}
