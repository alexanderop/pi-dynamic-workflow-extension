import { formatWorkflowArtifactSummary, preview, type WorkflowAgentStatus } from "./display.js";
import type { WorkflowJob, WorkflowJobStatus } from "./workflow-manager.js";
import { formatDuration, phaseStatus, phaseSummaries, statusGlyph } from "./workflow-ui-format.js";

export interface WorkflowPhaseReportRow {
	label: string;
	status: WorkflowAgentStatus;
	total: number;
	done: number;
	running: number;
	error: number;
}

export interface WorkflowAgentReportRow {
	id: number;
	label: string;
	phase: string;
	status: WorkflowAgentStatus;
	durationMs?: number;
	toolCount: number;
}

export interface WorkflowArtifactReportRow {
	name: string;
	type: "markdown" | "json" | "text";
	description?: string;
}

export interface WorkflowReport {
	id: number;
	name: string;
	status: WorkflowJobStatus;
	durationMs?: number;
	totalAgents: number;
	doneAgents: number;
	errorAgents: number;
	cancelledAgents: number;
	toolCount: number;
	phases: WorkflowPhaseReportRow[];
	agents: WorkflowAgentReportRow[];
	artifacts: WorkflowArtifactReportRow[];
	resultPreview?: string;
	error?: string;
}

export function selectWorkflowReport(job: WorkflowJob): WorkflowReport {
	const snapshot = job.snapshot;
	const phases = phaseSummaries(snapshot).map((phase) => ({
		label: phase.label,
		status: phaseStatus(phase, snapshot.currentPhase),
		total: phase.agents.length,
		done: phase.done,
		running: phase.running + phase.queued,
		error: phase.error,
	}));
	const agents = snapshot.agents.map((agent) => ({
		id: agent.id,
		label: agent.label,
		phase: agent.phase ?? "Unphased",
		status: agent.status,
		durationMs:
			agent.startedAt !== undefined
				? Math.max(0, (agent.endedAt ?? job.finishedAt ?? Date.now()) - agent.startedAt)
				: undefined,
		toolCount: agent.toolCount ?? agent.activity?.filter((item) => item.type === "tool").length ?? 0,
	}));
	const toolCount = snapshot.toolCount ?? agents.reduce((total, agent) => total + agent.toolCount, 0);
	const artifacts = (snapshot.artifacts ?? []).map((artifact) => ({
		name: artifact.name,
		type: artifact.type,
		...(artifact.description !== undefined ? { description: artifact.description } : {}),
	}));
	const result = job.result ?? snapshot.result;
	const cancelledAgents = snapshot.agents.filter((agent) => agent.status === "skipped").length;

	return {
		id: job.id,
		name: job.name,
		status: job.status,
		durationMs: snapshot.durationMs ?? (job.finishedAt ? Math.max(0, job.finishedAt - job.startedAt) : undefined),
		totalAgents: snapshot.agentCount || snapshot.agents.length,
		doneAgents: snapshot.doneCount,
		errorAgents: snapshot.errorCount,
		cancelledAgents,
		toolCount,
		phases,
		agents,
		artifacts,
		resultPreview: result !== undefined ? preview(result, 500) : undefined,
		error: job.error,
	};
}

export function renderWorkflowReportText(report: WorkflowReport): string {
	const lines = [
		`Workflow ${report.name} ${report.status}`,
		`Duration: ${formatDuration(report.durationMs)}`,
		`Agents: ${report.totalAgents} total · ${report.doneAgents} done · ${report.errorAgents} error · ${report.cancelledAgents} cancelled`,
		`Tools: ${report.toolCount}`,
		"",
		"Phases",
	];

	for (const phase of report.phases) {
		const suffix = [
			phase.running ? `${phase.running} running` : undefined,
			phase.error ? `${phase.error} error` : undefined,
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(
			`  ${statusGlyph(phase.status)} ${phase.label} ${phase.done}/${phase.total}${suffix ? ` · ${suffix}` : ""}`,
		);
	}

	lines.push("", "Agents");
	for (const agent of report.agents) {
		lines.push(
			`  #${agent.id} ${statusGlyph(agent.status)} ${agent.label} ${agent.phase} ${formatDuration(agent.durationMs)} · ${agent.toolCount} tools`,
		);
	}

	if (report.artifacts.length > 0) {
		lines.push("", "Artifacts");
		for (const artifact of report.artifacts) {
			lines.push(`  ${formatWorkflowArtifactSummary(artifact)}`);
		}
	}

	if (report.resultPreview) {
		lines.push("", "Final result preview", report.resultPreview);
	}
	if (report.error) {
		lines.push("", "Error", report.error);
	}
	lines.push("", "Open /workflows for full interactive details.");
	return lines.join("\n");
}
