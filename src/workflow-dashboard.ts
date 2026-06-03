import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	formatWorkflowArtifactSummary,
	type WorkflowAgentSnapshot,
	type WorkflowAgentStatus,
	type WorkflowSnapshot,
} from "./display.js";

interface DashboardTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function cell(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const clipped = truncateToWidth(
		singleLine(text),
		safeWidth,
		safeWidth > 0 ? "…" : "",
	);
	return clipped + " ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)));
}

function icon(status: WorkflowAgentStatus): string {
	switch (status) {
		case "queued":
			return "○";
		case "running":
			return "●";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "skipped":
			return "-";
	}
}

function phaseRows(snapshot: WorkflowSnapshot): string[] {
	const names = [
		...snapshot.phases,
		...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
		...snapshot.agents
			.map((agent) => agent.phase)
			.filter((phase): phase is string => Boolean(phase)),
	];

	return [...new Set(names)]
		.map((phase) => {
			const agents = snapshot.agents.filter((agent) => agent.phase === phase);
			if (agents.length === 0 && snapshot.currentPhase !== phase)
				return undefined;
			const done = agents.filter((agent) => agent.status === "done").length;
			const failed = agents.filter((agent) => agent.status === "error").length;
			const running = agents.some(
				(agent) => agent.status === "running" || agent.status === "queued",
			);
			const marker =
				running || snapshot.currentPhase === phase
					? "▶"
					: failed > 0
						? "✗"
						: "✓";
			const suffix = failed > 0 ? ` · ${failed} error` : "";
			return `${marker} ${phase} ${done}/${agents.length}${suffix}`;
		})
		.filter((row): row is string => Boolean(row));
}

function latestInterestingAgent(
	snapshot: WorkflowSnapshot,
): WorkflowAgentSnapshot | undefined {
	return (
		[...snapshot.agents]
			.reverse()
			.find((agent) => agent.status === "running") ?? snapshot.agents.at(-1)
	);
}

export class WorkflowDashboard implements Component {
	constructor(
		private readonly snapshot: WorkflowSnapshot,
		private readonly theme: DashboardTheme,
		private readonly completed: boolean,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const minWidth = 60;
		if (width < minWidth)
			return renderWorkflowDashboardFallback(
				this.snapshot,
				this.completed,
				width,
			);

		const phaseWidth = Math.max(18, Math.floor(width * 0.28));
		const agentWidth = Math.max(22, Math.floor(width * 0.34));
		const detailWidth = Math.max(8, width - phaseWidth - agentWidth - 6);

		const selected = latestInterestingAgent(this.snapshot);
		const phases = phaseRows(this.snapshot).slice(-8);
		const agents = this.snapshot.agents
			.slice(-8)
			.map((agent) => `${icon(agent.status)} #${agent.id} ${agent.label}`);
		const activity = selected?.activity?.slice(-3).map((item) => {
			if (item.type === "tool")
				return `Tool: ${item.toolName ?? "tool"} ${item.argsPreview ?? ""}`;
			return item.text ?? "";
		});
		const artifacts = (this.snapshot.artifacts ?? []).flatMap(
			(artifact, index) => {
				const row = formatWorkflowArtifactSummary(artifact);
				return index === 0 ? ["Artifacts", row] : [row];
			},
		);
		const detail = selected
			? [
					`Agent: ${selected.label}`,
					`Phase: ${selected.phase ?? "Unphased"}`,
					`Status: ${selected.status}`,
					...artifacts,
					`Prompt: ${selected.prompt}`,
					...(activity?.length
						? activity.map((line) => `Activity: ${line}`)
						: []),
					...(selected.resultPreview
						? [`Preview: ${selected.resultPreview}`]
						: []),
					...(selected.error ? [`Error: ${selected.error}`] : []),
				]
			: artifacts.length
				? artifacts
				: ["No agents started yet"];

		const rows = Math.max(phases.length, agents.length, detail.length, 1);
		const status = this.completed
			? "completed"
			: this.snapshot.runningCount > 0
				? "running"
				: "starting";
		const title = `◆ ${this.snapshot.name} — ${status} — ${this.snapshot.doneCount}/${this.snapshot.agentCount} done${
			this.snapshot.runningCount
				? ` · ${this.snapshot.runningCount} running`
				: ""
		}${this.snapshot.errorCount ? ` · ${this.snapshot.errorCount} error` : ""}`;

		const lines = [
			this.theme.fg(
				"toolTitle",
				this.theme.bold(truncateToWidth(title, width)),
			),
			this.theme.fg(
				"muted",
				`${cell("Phases", phaseWidth)} │ ${cell("Agents", agentWidth)} │ ${cell("Detail", detailWidth)}`,
			),
		];

		for (let i = 0; i < rows; i++) {
			lines.push(
				`${cell(phases[i] ?? "", phaseWidth)} │ ${cell(agents[i] ?? "", agentWidth)} │ ${cell(detail[i] ?? "", detailWidth)}`,
			);
		}

		for (const log of this.snapshot.logs.slice(-2)) {
			lines.push(
				this.theme.fg("dim", truncateToWidth(`log: ${singleLine(log)}`, width)),
			);
		}

		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		// Stateless renderer. Clear caches here if render caching is added later.
	}
}

function renderWorkflowDashboardFallback(
	snapshot: WorkflowSnapshot,
	completed: boolean,
	width: number,
): string[] {
	const header = completed ? "Workflow completed" : "Workflow running";
	const lines = [
		`${header}: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done)`,
		...snapshot.agents
			.slice(-4)
			.map((agent) => `  #${agent.id} ${icon(agent.status)} ${agent.label}`),
	];
	return lines.map((line) => truncateToWidth(line, width));
}
