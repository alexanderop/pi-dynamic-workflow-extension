import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot, WorkflowAgentStatus } from "./display.js";
import type {
	WorkflowJob,
	WorkflowJobStatus,
	WorkflowManager,
} from "./workflow-manager.js";

interface BrowserTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BrowserTui {
	requestRender(): void;
}

function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function line(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), width > 0 ? "…" : "");
}

function cell(value: string, width: number): string {
	const clipped = line(singleLine(value), width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function statusIcon(status: WorkflowAgentStatus | WorkflowJobStatus): string {
	switch (status) {
		case "running":
			return "●";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "cancelled":
		case "interrupted":
		case "skipped":
			return "-";
		case "queued":
			return "○";
	}
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "0s";
	if (ms < 1000) return `${ms}ms`;
	return `${Math.round(ms / 1000)}s`;
}

function windowAround<T>(
	items: T[],
	selected: number,
	size: number,
): Array<[T, number]> {
	if (items.length <= size) return items.map((item, index) => [item, index]);
	const half = Math.floor(size / 2);
	const start = Math.max(0, Math.min(selected - half, items.length - size));
	return items
		.slice(start, start + size)
		.map((item, offset) => [item, start + offset]);
}

export class WorkflowBrowser implements Component {
	private selectedJobIndex = 0;
	private selectedAgentIndex = 0;
	private readonly unsubscribe: () => void;
	private closed = false;

	constructor(
		private readonly manager: WorkflowManager,
		private readonly tui: BrowserTui,
		private readonly theme: BrowserTheme,
		private readonly done: () => void,
	) {
		this.selectedJobIndex = Math.max(0, this.manager.getJobs().length - 1);
		this.unsubscribe = this.manager.onChange(() => {
			this.clampSelection();
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		const jobs = this.manager.getJobs();
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.close();
			return;
		}

		if (jobs.length === 0) return;

		if (matchesKey(data, Key.left)) {
			this.selectedJobIndex = Math.max(0, this.selectedJobIndex - 1);
			this.selectedAgentIndex = 0;
		} else if (matchesKey(data, Key.right)) {
			this.selectedJobIndex = Math.min(
				jobs.length - 1,
				this.selectedJobIndex + 1,
			);
			this.selectedAgentIndex = 0;
		} else if (matchesKey(data, Key.up)) {
			this.selectedAgentIndex = Math.max(0, this.selectedAgentIndex - 1);
		} else if (matchesKey(data, Key.down)) {
			const job = jobs[this.selectedJobIndex];
			const max = Math.max(0, (job?.snapshot.agents.length ?? 1) - 1);
			this.selectedAgentIndex = Math.min(max, this.selectedAgentIndex + 1);
		} else if (matchesKey(data, Key.home)) {
			this.selectedAgentIndex = 0;
		} else if (matchesKey(data, Key.end)) {
			const job = jobs[this.selectedJobIndex];
			this.selectedAgentIndex = Math.max(
				0,
				(job?.snapshot.agents.length ?? 1) - 1,
			);
		} else if (data === "c" || data === "C") {
			const job = jobs[this.selectedJobIndex];
			if (job) this.manager.cancel(job.id);
		}

		this.clampSelection();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		this.clampSelection();
		const jobs = this.manager.getJobs();
		const lines: string[] = [];

		lines.push(
			this.theme.fg("toolTitle", this.theme.bold(line("◆ Workflows", width))),
		);

		if (jobs.length === 0) {
			lines.push(
				this.theme.fg(
					"muted",
					line("No workflows have been started in this session.", width),
				),
			);
			lines.push(
				this.theme.fg(
					"dim",
					line("Run a workflow tool call, then reopen /workflows.", width),
				),
			);
			return lines;
		}

		lines.push(this.renderJobStrip(jobs, width));
		const job = jobs[this.selectedJobIndex] ?? jobs.at(-1);
		if (!job) return lines.map((item) => line(item, width));

		const title = `${statusIcon(job.status)} #${job.id} ${job.name} — ${job.status} — ${job.snapshot.doneCount}/${job.snapshot.agentCount} done${job.snapshot.runningCount ? ` · ${job.snapshot.runningCount} running` : ""}${job.snapshot.errorCount ? ` · ${job.snapshot.errorCount} error` : ""} · ${formatDuration(job.snapshot.durationMs)}`;
		lines.push(
			this.theme.fg(
				job.status === "error" ? "error" : "accent",
				line(title, width),
			),
		);

		if (width < 70) {
			lines.push(...this.renderNarrow(job, width));
		} else {
			lines.push(...this.renderWide(job, width));
		}

		lines.push(
			this.theme.fg(
				"dim",
				line(
					"←/→ workflow • ↑/↓ agent • c cancel running • q/esc close",
					width,
				),
			),
		);
		return lines.map((item) => line(item, width));
	}

	invalidate(): void {
		// Stateless renderer; live data is read from the manager on every render.
	}

	private renderJobStrip(jobs: WorkflowJob[], width: number): string {
		const rendered = windowAround(jobs, this.selectedJobIndex, 4)
			.map(([job, index]) => {
				const label = `${statusIcon(job.status)} #${job.id} ${job.name}`;
				return index === this.selectedJobIndex
					? this.theme.fg("accent", this.theme.bold(`[${label}]`))
					: this.theme.fg("muted", label);
			})
			.join("  ");
		return line(rendered, width);
	}

	private renderWide(job: WorkflowJob, width: number): string[] {
		const agents = job.snapshot.agents;
		const agentWidth = Math.max(28, Math.floor(width * 0.42));
		const detailWidth = Math.max(10, width - agentWidth - 3);
		const agentRows =
			agents.length > 0
				? windowAround(agents, this.selectedAgentIndex, 10)
				: [];
		const detailRows = this.detailRows(job);
		const rows = Math.max(agentRows.length, detailRows.length, 1);
		const lines = [
			this.theme.fg(
				"muted",
				`${cell("Agents", agentWidth)} │ ${cell("Selected details", detailWidth)}`,
			),
		];

		for (let i = 0; i < rows; i++) {
			const agentTuple = agentRows[i];
			const agentText = agentTuple
				? this.agentRow(
						agentTuple[0],
						agentTuple[1] === this.selectedAgentIndex,
					)
				: agents.length === 0 && i === 0
					? "No agents started yet"
					: "";
			lines.push(
				`${cell(agentText, agentWidth)} │ ${cell(detailRows[i] ?? "", detailWidth)}`,
			);
		}
		return lines;
	}

	private renderNarrow(job: WorkflowJob, width: number): string[] {
		const lines: string[] = [];
		const agents = job.snapshot.agents;
		if (agents.length === 0) lines.push("No agents started yet");
		for (const [agent, index] of windowAround(
			agents,
			this.selectedAgentIndex,
			6,
		)) {
			lines.push(this.agentRow(agent, index === this.selectedAgentIndex));
		}
		lines.push(...this.detailRows(job).slice(0, 8));
		return lines.map((item) => line(item, width));
	}

	private agentRow(agent: WorkflowAgentSnapshot, selected: boolean): string {
		const prefix = selected ? "›" : " ";
		const phase = agent.phase ? ` · ${agent.phase}` : "";
		const text = `${prefix} ${statusIcon(agent.status)} #${agent.id} ${agent.label}${phase}`;
		return selected ? this.theme.fg("accent", text) : text;
	}

	private detailRows(job: WorkflowJob): string[] {
		const agent = job.snapshot.agents[this.selectedAgentIndex];
		if (!agent) {
			return [
				`Workflow: ${job.name}`,
				`Status: ${job.status}`,
				...(job.error ? [`Error: ${job.error}`] : []),
			];
		}

		const activity = (agent.activity ?? []).slice(-8).map((item) => {
			if (item.type === "tool")
				return `Tool: ${item.toolName ?? "tool"} ${item.argsPreview ?? ""}`;
			return `${item.type}: ${item.text ?? ""}`;
		});
		return [
			`Agent: ${agent.label}`,
			`Phase: ${agent.phase ?? "Unphased"}`,
			`Status: ${agent.status}`,
			`Prompt: ${agent.prompt}`,
			...activity,
			...(agent.resultPreview ? [`Preview: ${agent.resultPreview}`] : []),
			...(agent.error ? [`Error: ${agent.error}`] : []),
			...(job.result !== undefined
				? [`Workflow result: ${singleLine(JSON.stringify(job.result))}`]
				: []),
			...(job.error ? [`Workflow error: ${job.error}`] : []),
		];
	}

	private clampSelection(): void {
		const jobs = this.manager.getJobs();
		if (jobs.length === 0) {
			this.selectedJobIndex = 0;
			this.selectedAgentIndex = 0;
			return;
		}
		this.selectedJobIndex = Math.max(
			0,
			Math.min(this.selectedJobIndex, jobs.length - 1),
		);
		const job = jobs[this.selectedJobIndex];
		const agentCount = job?.snapshot.agents.length ?? 0;
		this.selectedAgentIndex = Math.max(
			0,
			Math.min(this.selectedAgentIndex, Math.max(0, agentCount - 1)),
		);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		this.done();
	}
}
