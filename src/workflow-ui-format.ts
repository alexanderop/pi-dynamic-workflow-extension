import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot, WorkflowAgentStatus, WorkflowSnapshot } from "./display.js";
import type { WorkflowJobStatus } from "./workflow-manager.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface WorkflowPhaseSummary {
	name?: string;
	label: string;
	agents: WorkflowAgentSnapshot[];
	done: number;
	running: number;
	error: number;
	queued: number;
}

export function statusGlyph(status: WorkflowAgentStatus | WorkflowJobStatus, frame = 0): string {
	switch (status) {
		case "running":
			return SPINNER[Math.abs(frame) % SPINNER.length] ?? "⠋";
		case "queued":
			return "○";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "cancelled":
		case "interrupted":
		case "skipped":
			return "-";
	}
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "0s";
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder ? `${hours}h${remainder}m` : `${hours}h`;
}

export function formatTokens(value: number | undefined): string | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (Math.abs(value) < 1000) return `${value}`;
	if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function singleLine(value: unknown): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

export function fitLine(value: string, width: number): string {
	return truncateToWidth(value, Math.max(0, width), width > 0 ? "…" : "");
}

export function truncatePlainLine(value: string, width: number): string {
	const safeWidth = Math.max(0, width);
	if (safeWidth === 0) return "";
	if (visibleWidth(value) <= safeWidth) return value;
	if (safeWidth === 1) return "…";

	let result = "";
	for (const character of value) {
		if (visibleWidth(`${result}${character}…`) > safeWidth) break;
		result += character;
	}
	return `${result}…`;
}

export function cell(value: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const clipped = fitLine(singleLine(value), safeWidth);
	return clipped + " ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)));
}

export function windowAround<T>(items: T[], selected: number, size: number): Array<[T, number]> {
	if (size <= 0) return [];
	if (items.length <= size) return items.map((item, index) => [item, index]);
	const safeSelected = Math.max(0, Math.min(selected, items.length - 1));
	const half = Math.floor(size / 2);
	const start = Math.max(0, Math.min(safeSelected - half, items.length - size));
	return items.slice(start, start + size).map((item, offset) => [item, start + offset]);
}

export function phaseSummaries(snapshot: WorkflowSnapshot): WorkflowPhaseSummary[] {
	const names = [
		...snapshot.phases,
		...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
		...snapshot.agents.map((agent) => agent.phase).filter((phase): phase is string => Boolean(phase)),
	].filter((phase, index, all) => all.indexOf(phase) === index);

	const summaries = names.map((name) => buildPhaseSummary(snapshot, name));
	const unphased = snapshot.agents.filter((agent) => !agent.phase);
	if (unphased.length > 0) summaries.push(buildPhaseSummary(snapshot, undefined));
	return summaries.length > 0
		? summaries
		: [
				{
					name: undefined,
					label: "Unphased",
					agents: [],
					done: 0,
					running: 0,
					error: 0,
					queued: 0,
				},
			];
}

function buildPhaseSummary(snapshot: WorkflowSnapshot, name: string | undefined): WorkflowPhaseSummary {
	const agents = snapshot.agents.filter((agent) => agent.phase === name);
	return {
		name,
		label: name ?? "Unphased",
		agents,
		done: agents.filter((agent) => agent.status === "done").length,
		running: agents.filter((agent) => agent.status === "running").length,
		error: agents.filter((agent) => agent.status === "error").length,
		queued: agents.filter((agent) => agent.status === "queued").length,
	};
}

export function phaseStatus(summary: WorkflowPhaseSummary, currentPhase?: string): WorkflowAgentStatus {
	if (summary.error > 0) return "error";
	if (summary.running > 0 || summary.queued > 0 || currentPhase === summary.name) return "running";
	if (summary.agents.length > 0 && summary.done === summary.agents.length) return "done";
	return "queued";
}

export function clampIndex(index: number, length: number): number {
	return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}
