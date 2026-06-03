import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot } from "./display.js";
import type { WorkflowJob, WorkflowManager } from "./workflow-manager.js";
import {
	cell,
	clampIndex,
	fitLine,
	formatDuration,
	formatTokens,
	phaseStatus,
	phaseSummaries,
	singleLine,
	statusGlyph,
	type WorkflowPhaseSummary,
	windowAround,
} from "./workflow-ui-format.js";

type FocusPane = "phases" | "agents" | "detail";

interface BrowserTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BrowserTui {
	requestRender(): void;
}

interface BrowserNavState {
	selectedJobIndex: number;
	selectedPhaseIndex: number;
	selectedAgentIndex: number;
	focus: FocusPane;
	detailScroll: number;
	expanded: boolean;
}

export interface WorkflowBrowserActions {
	save?(job: WorkflowJob): void;
	rerun?(job: WorkflowJob): void;
	resume?(job: WorkflowJob): void;
}

export class WorkflowBrowser implements Component {
	private readonly unsubscribe: () => void;
	private closed = false;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private nav: BrowserNavState = {
		selectedJobIndex: 0,
		selectedPhaseIndex: 0,
		selectedAgentIndex: 0,
		focus: "phases",
		detailScroll: 0,
		expanded: false,
	};

	constructor(
		private readonly manager: WorkflowManager,
		private readonly tui: BrowserTui,
		private readonly theme: BrowserTheme,
		private readonly done: () => void,
		private readonly actions: WorkflowBrowserActions = {},
	) {
		const initialJobs = this.manager.getJobs();
		this.nav.selectedJobIndex = Math.max(0, initialJobs.length - 1);
		const initialJob = initialJobs[this.nav.selectedJobIndex];
		if (initialJob)
			this.nav.selectedPhaseIndex = this.activePhaseIndex(initialJob);
		this.unsubscribe = this.manager.onChange(() => {
			this.clampSelection();
			this.updateTimer();
			this.tui.requestRender();
		});
		this.updateTimer();
	}

	handleInput(data: string): void {
		const jobs = this.manager.getJobs();
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.close();
			return;
		}

		if (jobs.length === 0) return;

		if (matchesKey(data, Key.left)) {
			this.moveFocus(-1);
		} else if (matchesKey(data, Key.right)) {
			this.moveFocus(1);
		} else if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
		} else if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
		} else if (matchesKey(data, Key.home)) {
			this.jumpSelection("start");
		} else if (matchesKey(data, Key.end)) {
			this.jumpSelection("end");
		} else if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
			this.nav.expanded = !this.nav.expanded;
			this.nav.detailScroll = 0;
		} else if (data === "j" || data === "J") {
			this.nav.detailScroll++;
		} else if (data === "k" || data === "K") {
			this.nav.detailScroll = Math.max(0, this.nav.detailScroll - 1);
		} else if (data === "c" || data === "C") {
			const job = jobs[this.nav.selectedJobIndex];
			if (job) this.manager.cancel(job.id);
		} else if (data === "s" || data === "S") {
			const job = jobs[this.nav.selectedJobIndex];
			if (job) this.actions.save?.(job);
		} else if (data === "r") {
			const job = jobs[this.nav.selectedJobIndex];
			if (job) this.actions.rerun?.(job);
		} else if (data === "R") {
			const job = jobs[this.nav.selectedJobIndex];
			if (job) this.actions.resume?.(job);
		} else if (data === "[" || data === "<") {
			this.selectJob(this.nav.selectedJobIndex - 1);
		} else if (data === "]" || data === ">") {
			this.selectJob(this.nav.selectedJobIndex + 1);
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
			this.theme.fg(
				"toolTitle",
				this.theme.bold(fitLine("◆ Workflows", width)),
			),
		);

		if (jobs.length === 0) {
			lines.push(
				this.theme.fg(
					"muted",
					fitLine("No workflows have been started in this session.", width),
				),
			);
			lines.push(
				this.theme.fg(
					"dim",
					fitLine("Run a workflow tool call, then reopen /workflows.", width),
				),
			);
			return lines;
		}

		lines.push(this.renderJobStrip(jobs, width));
		const job = jobs[this.nav.selectedJobIndex] ?? jobs.at(-1);
		if (!job) return lines.map((item) => fitLine(item, width));

		lines.push(...this.renderHeader(job, width));

		if (width < 70) {
			lines.push(...this.renderNarrow(job, width));
		} else if (width <= 110) {
			lines.push(...this.renderTwoPane(job, width));
		} else {
			lines.push(...this.renderWide(job, width));
		}

		lines.push(
			this.theme.fg(
				"dim",
				fitLine(
					"↑↓ select · ←→ focus · j/k scroll · enter expand · c cancel · s save · r rerun · R resume · [/]/<> workflow · q close",
					width,
				),
			),
		);
		return lines.map((item) => fitLine(item, width));
	}

	invalidate(): void {
		this.frame++;
	}

	private renderHeader(job: WorkflowJob, width: number): string[] {
		const snapshot = job.snapshot;
		const duration = formatDuration(
			job.status === "running"
				? Date.now() - job.startedAt
				: snapshot.durationMs,
		);
		const title = `${statusGlyph(job.status, this.frame)} #${job.id} ${job.name} — ${snapshot.doneCount}/${snapshot.agentCount} agents · ${job.status} · ${duration}`;
		const status = snapshot.description ?? job.description ?? "Workflow status";
		return [
			this.theme.fg(
				job.status === "error" ? "error" : "accent",
				fitLine(title, width),
			),
			this.theme.fg("muted", fitLine(status, width)),
		];
	}

	private renderJobStrip(jobs: WorkflowJob[], width: number): string {
		const rendered = windowAround(jobs, this.nav.selectedJobIndex, 4)
			.map(([job, index]) => {
				const label = `${statusGlyph(job.status, this.frame)} #${job.id} ${job.name}`;
				return index === this.nav.selectedJobIndex
					? this.theme.fg("accent", this.theme.bold(`[${label}]`))
					: this.theme.fg("muted", label);
			})
			.join("  ");
		return fitLine(rendered, width);
	}

	private renderWide(job: WorkflowJob, width: number): string[] {
		const phaseWidth = Math.max(22, Math.floor((width - 6) * 0.25));
		const agentWidth = Math.max(28, Math.floor((width - 6) * 0.34));
		const detailWidth = Math.max(10, width - phaseWidth - agentWidth - 6);
		const height = 14;
		const phases = phaseSummaries(job.snapshot);
		const agents = this.filteredAgents(job);
		const phaseRows = this.renderPhasesPane(job, phaseWidth, height);
		const agentRows = this.renderAgentsPane(agents, agentWidth, height);
		const detailRows = this.renderDetailPane(job, detailWidth, height);
		const rows = Math.max(
			phaseRows.length,
			agentRows.length,
			detailRows.length,
			1,
		);
		const lines = [
			this.theme.fg(
				"muted",
				`${cell(this.paneTitle("Phases", "phases"), phaseWidth)} │ ${cell(this.paneTitle("Agents", "agents"), agentWidth)} │ ${cell(this.paneTitle("Detail", "detail"), detailWidth)}`,
			),
		];

		for (let i = 0; i < rows; i++) {
			lines.push(
				`${cell(phaseRows[i] ?? "", phaseWidth)} │ ${cell(agentRows[i] ?? "", agentWidth)} │ ${cell(detailRows[i] ?? "", detailWidth)}`,
			);
		}
		if (phases.length === 0) lines.push(cell("No phases", width));
		return lines;
	}

	private renderTwoPane(job: WorkflowJob, width: number): string[] {
		const leftWidth = Math.max(30, Math.floor((width - 3) * 0.46));
		const detailWidth = Math.max(10, width - leftWidth - 3);
		const height = 12;
		const leftRows = [
			this.theme.fg("muted", this.paneTitle("Phases", "phases")),
			...this.renderPhasesPane(job, leftWidth, 5),
			this.theme.fg("muted", this.paneTitle("Agents", "agents")),
			...this.renderAgentsPane(this.filteredAgents(job), leftWidth, 6),
		];
		const detailRows = this.renderDetailPane(job, detailWidth, height);
		const rows = Math.max(leftRows.length, detailRows.length, 1);
		const lines = [
			this.theme.fg(
				"muted",
				`${cell("Phases + Agents", leftWidth)} │ ${cell(this.paneTitle("Detail", "detail"), detailWidth)}`,
			),
		];
		for (let i = 0; i < rows; i++) {
			lines.push(
				`${cell(leftRows[i] ?? "", leftWidth)} │ ${cell(detailRows[i] ?? "", detailWidth)}`,
			);
		}
		return lines;
	}

	private renderNarrow(job: WorkflowJob, width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("muted", "Phases"));
		lines.push(...this.renderPhasesPane(job, width, 5));
		lines.push(this.theme.fg("muted", "Agents"));
		lines.push(...this.renderAgentsPane(this.filteredAgents(job), width, 6));
		lines.push(this.theme.fg("muted", "Detail"));
		lines.push(...this.renderDetailPane(job, width, 8));
		return lines.map((item) => fitLine(item, width));
	}

	private renderPhasesPane(
		job: WorkflowJob,
		width: number,
		height: number,
	): string[] {
		const phases = phaseSummaries(job.snapshot);
		return windowAround(phases, this.nav.selectedPhaseIndex, height).map(
			([summary, index]) =>
				this.phaseRow(
					job,
					summary,
					index === this.nav.selectedPhaseIndex,
					width,
				),
		);
	}

	private phaseRow(
		job: WorkflowJob,
		summary: WorkflowPhaseSummary,
		selected: boolean,
		width: number,
	): string {
		const prefix = selected ? "›" : " ";
		const status = phaseStatus(summary, job.snapshot.currentPhase);
		const running = summary.running + summary.queued;
		const suffix = summary.error
			? ` · ${summary.error} error`
			: running
				? ` · ${running} running`
				: "";
		const text = `${prefix} ${statusGlyph(status, this.frame)} ${summary.label} ${summary.done}/${summary.agents.length}${suffix}`;
		return selected && this.nav.focus === "phases"
			? this.theme.fg("accent", this.theme.bold(fitLine(text, width)))
			: selected
				? this.theme.fg("accent", fitLine(text, width))
				: fitLine(text, width);
	}

	private renderAgentsPane(
		agents: WorkflowAgentSnapshot[],
		width: number,
		height: number,
	): string[] {
		if (agents.length === 0) return ["No agents in phase"];
		return windowAround(agents, this.nav.selectedAgentIndex, height).map(
			([agent, index]) =>
				this.agentRow(agent, index === this.nav.selectedAgentIndex, width),
		);
	}

	private agentRow(
		agent: WorkflowAgentSnapshot,
		selected: boolean,
		width: number,
	): string {
		const prefix = selected ? "›" : " ";
		const metrics = this.agentMetrics(agent);
		const text = `${prefix} ${statusGlyph(agent.status, this.frame)} #${agent.id} ${agent.label}${metrics ? ` ${metrics}` : ""}`;
		return selected && this.nav.focus === "agents"
			? this.theme.fg("accent", this.theme.bold(fitLine(text, width)))
			: selected
				? this.theme.fg("accent", fitLine(text, width))
				: fitLine(text, width);
	}

	private renderDetailPane(
		job: WorkflowJob,
		width: number,
		height: number,
	): string[] {
		const rows = this.detailRows(job);
		const safeHeight = Math.max(1, height);
		const maxScroll = Math.max(0, rows.length - safeHeight);
		this.nav.detailScroll = clampIndex(this.nav.detailScroll, maxScroll + 1);
		const start = Math.min(this.nav.detailScroll, maxScroll);
		const visible = rows.slice(start, start + safeHeight);
		if (rows.length > safeHeight) {
			const end = Math.min(rows.length, start + safeHeight);
			const marker = start === 0 ? "↓" : end === rows.length ? "↑" : "↕";
			visible[safeHeight - 1] = `${end} of ${rows.length} ${marker}`;
		}
		return visible.map((item) => fitLine(item, width));
	}

	private detailRows(job: WorkflowJob): string[] {
		const agent = this.selectedAgent(job);
		if (!agent) {
			const result = job.result ?? job.snapshot.result;
			return [
				`Workflow: ${job.name}`,
				`Status: ${job.status}`,
				`Agents: ${job.snapshot.doneCount}/${job.snapshot.agentCount}`,
				...(result !== undefined
					? ["Outcome", `  ${singleLine(JSON.stringify(result))}`]
					: []),
				...(job.error ? ["Error", `  ${job.error}`] : []),
			];
		}

		return [
			`Agent: ${agent.label}`,
			`Phase: ${agent.phase ?? "Unphased"}`,
			`Status: ${agent.status}${agent.model ? ` · ${agent.model}` : ""}`,
			`Metrics: ${this.detailMetrics(agent)}`,
			"Prompt",
			...this.promptRows(agent.prompt),
			...(agent.activity?.length
				? ["Activity", ...this.activityRows(agent)]
				: []),
			...(agent.resultText || agent.resultPreview
				? [
						"Outcome",
						`  ${singleLine(agent.resultText ?? agent.resultPreview)}`,
					]
				: []),
			...(agent.error ? ["Error", `  ${agent.error}`] : []),
			...(job.result !== undefined && job.status !== "running"
				? ["Workflow result", `  ${singleLine(JSON.stringify(job.result))}`]
				: []),
			...(job.error ? ["Workflow error", `  ${job.error}`] : []),
		];
	}

	private promptRows(prompt: string): string[] {
		const rows = prompt.split(/\r?\n/).map((item) => `  ${singleLine(item)}`);
		if (this.nav.expanded) return rows;
		const firstRows = rows.slice(0, 2);
		if (rows.length > 2) firstRows.push("  … enter to expand");
		return firstRows;
	}

	private activityRows(agent: WorkflowAgentSnapshot): string[] {
		return (agent.activity ?? []).slice(-8).map((item) => {
			if (item.type === "tool")
				return `  Tool: ${item.toolName ?? "tool"} ${item.argsPreview ?? ""}`;
			return `  ${item.type}: ${item.text ?? ""}`;
		});
	}

	private selectedAgent(job: WorkflowJob): WorkflowAgentSnapshot | undefined {
		return this.filteredAgents(job)[this.nav.selectedAgentIndex];
	}

	private filteredAgents(job: WorkflowJob): WorkflowAgentSnapshot[] {
		const phase = phaseSummaries(job.snapshot)[this.nav.selectedPhaseIndex];
		return phase?.agents ?? [];
	}

	private agentMetrics(agent: WorkflowAgentSnapshot): string {
		const parts: string[] = [];
		if (agent.model) parts.push(agent.model);
		const tokens = formatTokens(
			agent.liveTokens ?? agent.inputTokens ?? agent.outputTokens,
		);
		if (tokens) parts.push(`${tokens} tok`);
		const tools =
			agent.toolCount ??
			agent.activity?.filter((item) => item.type === "tool").length ??
			0;
		parts.push(`${tools} tools`);
		const elapsed = this.agentElapsed(agent);
		if (elapsed) parts.push(elapsed);
		if (agent.cached) parts.push("cached");
		return `— ${parts.join(" · ")}`;
	}

	private detailMetrics(agent: WorkflowAgentSnapshot): string {
		return this.agentMetrics(agent).replace(/^—\s*/, "") || "0 tools";
	}

	private agentElapsed(agent: WorkflowAgentSnapshot): string | undefined {
		if (agent.startedAt === undefined) return undefined;
		const end = agent.endedAt ?? Date.now();
		return formatDuration(Math.max(0, end - agent.startedAt));
	}

	private paneTitle(label: string, pane: FocusPane): string {
		return this.nav.focus === pane ? `[${label}]` : label;
	}

	private moveFocus(delta: number): void {
		const panes: FocusPane[] = ["phases", "agents", "detail"];
		const index = panes.indexOf(this.nav.focus);
		this.nav.focus = panes[clampIndex(index + delta, panes.length)] ?? "phases";
	}

	private moveSelection(delta: number): void {
		const job = this.currentJob();
		if (!job) return;
		if (this.nav.focus === "phases") {
			const phases = phaseSummaries(job.snapshot);
			this.nav.selectedPhaseIndex = clampIndex(
				this.nav.selectedPhaseIndex + delta,
				phases.length,
			);
			this.nav.selectedAgentIndex = 0;
			this.nav.detailScroll = 0;
			return;
		}
		if (this.nav.focus === "agents") {
			const agents = this.filteredAgents(job);
			this.nav.selectedAgentIndex = clampIndex(
				this.nav.selectedAgentIndex + delta,
				agents.length,
			);
			this.nav.detailScroll = 0;
			return;
		}
		this.nav.detailScroll = Math.max(0, this.nav.detailScroll + delta);
	}

	private jumpSelection(position: "start" | "end"): void {
		const job = this.currentJob();
		if (!job) return;
		if (this.nav.focus === "phases") {
			this.nav.selectedPhaseIndex =
				position === "start" ? 0 : phaseSummaries(job.snapshot).length - 1;
			this.nav.selectedAgentIndex = 0;
		} else if (this.nav.focus === "agents") {
			this.nav.selectedAgentIndex =
				position === "start" ? 0 : this.filteredAgents(job).length - 1;
		} else {
			this.nav.detailScroll =
				position === "start" ? 0 : Number.MAX_SAFE_INTEGER;
		}
	}

	private selectJob(index: number): void {
		const jobs = this.manager.getJobs();
		this.nav.selectedJobIndex = clampIndex(index, jobs.length);
		const job = jobs[this.nav.selectedJobIndex];
		this.nav.selectedPhaseIndex = job ? this.activePhaseIndex(job) : 0;
		this.nav.selectedAgentIndex = 0;
		this.nav.detailScroll = 0;
		this.nav.expanded = false;
	}

	private activePhaseIndex(job: WorkflowJob): number {
		const phases = phaseSummaries(job.snapshot);
		const currentIndex = phases.findIndex(
			(phase) => phase.name === job.snapshot.currentPhase,
		);
		if (currentIndex >= 0) return currentIndex;
		const runningIndex = phases.findIndex(
			(phase) => phase.running > 0 || phase.queued > 0,
		);
		return runningIndex >= 0 ? runningIndex : 0;
	}

	private currentJob(): WorkflowJob | undefined {
		const jobs = this.manager.getJobs();
		return jobs[this.nav.selectedJobIndex];
	}

	private clampSelection(): void {
		const jobs = this.manager.getJobs();
		if (jobs.length === 0) {
			this.nav.selectedJobIndex = 0;
			this.nav.selectedPhaseIndex = 0;
			this.nav.selectedAgentIndex = 0;
			this.nav.detailScroll = 0;
			return;
		}
		this.nav.selectedJobIndex = clampIndex(
			this.nav.selectedJobIndex,
			jobs.length,
		);
		const job = jobs[this.nav.selectedJobIndex];
		const phases = job ? phaseSummaries(job.snapshot) : [];
		this.nav.selectedPhaseIndex = clampIndex(
			this.nav.selectedPhaseIndex,
			phases.length,
		);
		const agents = job ? this.filteredAgents(job) : [];
		this.nav.selectedAgentIndex = clampIndex(
			this.nav.selectedAgentIndex,
			agents.length,
		);
		this.nav.detailScroll = Math.max(0, this.nav.detailScroll);
	}

	private updateTimer(): void {
		const running = this.manager
			.getJobs()
			.some((job) => job.status === "running");
		if (!running || this.closed) {
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
			return;
		}
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame++;
			this.tui.requestRender();
		}, 250);
		this.timer.unref?.();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.unsubscribe();
		this.done();
	}
}
