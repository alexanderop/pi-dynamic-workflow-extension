import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";

export type WorkflowAgentStatus =
	| "queued"
	| "running"
	| "done"
	| "error"
	| "skipped";

export interface WorkflowAgentActivity {
	type: "text" | "tool" | "log";
	text?: string;
	toolName?: string;
	argsPreview?: string;
}

export interface WorkflowAgentSnapshot {
	id: number;
	label: string;
	phase?: string;
	prompt: string;
	status: WorkflowAgentStatus;
	activity?: WorkflowAgentActivity[];
	resultPreview?: string;
	error?: string;
}

export interface WorkflowSnapshot {
	name: string;
	description?: string;
	phases: string[];
	currentPhase?: string;
	logs: string[];
	agents: WorkflowAgentSnapshot[];
	agentCount: number;
	runningCount: number;
	doneCount: number;
	errorCount: number;
	durationMs?: number;
	result?: unknown;
}

export function createWorkflowSnapshot(meta: {
	name: string;
	description?: string;
}): WorkflowSnapshot {
	return {
		name: meta.name,
		description: meta.description,
		phases: [],
		logs: [],
		agents: [],
		agentCount: 0,
		runningCount: 0,
		doneCount: 0,
		errorCount: 0,
	};
}

export function updateSnapshotStats(
	snapshot: WorkflowSnapshot,
): WorkflowSnapshot {
	snapshot.agentCount = snapshot.agents.length;
	snapshot.runningCount = snapshot.agents.filter(
		(agent) => agent.status === "running" || agent.status === "queued",
	).length;
	snapshot.doneCount = snapshot.agents.filter(
		(agent) => agent.status === "done",
	).length;
	snapshot.errorCount = snapshot.agents.filter(
		(agent) => agent.status === "error",
	).length;
	return snapshot;
}

export function preview(value: unknown, maxLength = 180): string {
	const text =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	if (!text) return "";
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > maxLength
		? `${compact.slice(0, maxLength - 1)}…`
		: compact;
}

function statusIcon(status: WorkflowAgentStatus): string {
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

function phaseNames(snapshot: WorkflowSnapshot): string[] {
	return [
		...snapshot.phases,
		...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
		...snapshot.agents
			.map((agent) => agent.phase)
			.filter((phase): phase is string => Boolean(phase)),
	].filter((phase, index, all) => all.indexOf(phase) === index);
}

export function renderWorkflowLines(
	snapshot: WorkflowSnapshot,
	completed = false,
): string[] {
	updateSnapshotStats(snapshot);
	const header = completed ? "Workflow completed" : "Workflow running";
	const lines = [
		`${header}`,
		`◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${
			snapshot.runningCount ? `, ${snapshot.runningCount} running` : ""
		}${snapshot.errorCount ? `, ${snapshot.errorCount} error` : ""})`,
	];

	for (const phase of phaseNames(snapshot)) {
		const agents = snapshot.agents.filter((agent) => agent.phase === phase);
		if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
		const done = agents.filter((agent) => agent.status === "done").length;
		const running = agents.filter(
			(agent) => agent.status === "running" || agent.status === "queued",
		).length;
		const errored = agents.filter((agent) => agent.status === "error").length;
		const marker =
			snapshot.currentPhase === phase || running > 0
				? "▶"
				: errored > 0
					? "✗"
					: "✓";
		lines.push(
			`  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}`,
		);
		for (const agent of agents) {
			lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${agent.label}`);
		}
	}

	const unphased = snapshot.agents.filter((agent) => !agent.phase);
	if (unphased.length > 0) {
		lines.push("  Unphased");
		for (const agent of unphased)
			lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${agent.label}`);
	}

	for (const log of snapshot.logs.slice(-3)) lines.push(`  log: ${log}`);
	if (completed && snapshot.durationMs !== undefined)
		lines.push(`  duration: ${Math.round(snapshot.durationMs / 1000)}s`);
	return lines;
}

export function renderWorkflowText(
	snapshot: WorkflowSnapshot,
	completed = false,
): string {
	return renderWorkflowLines(snapshot, completed).join("\n");
}

function cloneSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
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

export function createToolUpdateWorkflowDisplay(
	onUpdate: AgentToolUpdateCallback<WorkflowSnapshot> | undefined,
): {
	update(snapshot: WorkflowSnapshot): void;
	complete(snapshot: WorkflowSnapshot): void;
	clear(): void;
} {
	const emit = (snapshot: WorkflowSnapshot, completed: boolean) => {
		updateSnapshotStats(snapshot);
		const cloned = cloneSnapshot(snapshot);
		const result: AgentToolResult<WorkflowSnapshot> = {
			content: [{ type: "text", text: renderWorkflowText(cloned, completed) }],
			details: cloned,
		};
		onUpdate?.(result);
	};

	return {
		update(snapshot) {
			emit(snapshot, false);
		},
		complete(snapshot) {
			emit(snapshot, true);
		},
		clear() {},
	};
}
