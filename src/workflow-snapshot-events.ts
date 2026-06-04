import { preview, type WorkflowSnapshot } from "./display.js";
import { safeJsonStringify, type RunWorkflowOptions, type WorkflowResult } from "./workflow.js";
import type { WorkflowJobStatus } from "./workflow-manager.js";

export interface WorkflowSnapshotEventOptions {
	emit: () => void;
	now?: () => number;
}

type WorkflowSnapshotEventHandlers = Pick<
	RunWorkflowOptions,
	"onPhase" | "onLog" | "onArtifact" | "onAgentStart" | "onAgentActivity" | "onAgentEnd"
>;

export function createWorkflowSnapshotEventHandlers(
	snapshot: WorkflowSnapshot,
	options: WorkflowSnapshotEventOptions,
): WorkflowSnapshotEventHandlers {
	const now = options.now ?? Date.now;
	const emit = options.emit;
	return {
		onPhase(title) {
			snapshot.currentPhase = title;
			if (!snapshot.phases.includes(title)) snapshot.phases.push(title);
			emit();
		},
		onLog(message) {
			snapshot.logs.push(message);
			emit();
		},
		onArtifact(artifact) {
			snapshot.artifacts = [...(snapshot.artifacts ?? []), artifact];
			emit();
		},
		onAgentStart(event) {
			snapshot.agents.push({
				id: event.id,
				label: event.label,
				phase: event.phase,
				prompt: event.prompt,
				status: event.cached ? "done" : "running",
				startedAt: now(),
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
			if (event.type === "tool") agent.toolCount = (agent.toolCount ?? 0) + 1;
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
				agent.status = event.error ? "error" : "done";
				agent.endedAt = now();
				agent.resultPreview = preview(event.result);
				agent.resultText =
					typeof event.result === "string" ? event.result : safeJsonStringify(event.result, "agent result", 2);
				if (event.error) agent.error = event.error.message;
			}
			emit();
		},
	};
}

export function applyWorkflowSnapshotSuccess(snapshot: WorkflowSnapshot, result: WorkflowResult, now = Date.now): void {
	snapshot.currentPhase = undefined;
	snapshot.result = result.result;
	snapshot.artifacts = result.artifacts;
	for (const agent of snapshot.agents) {
		if (agent.status === "running" || agent.status === "queued") {
			agent.status = "done";
			agent.endedAt = agent.endedAt ?? now();
		}
	}
}

export function applyWorkflowSnapshotFailure(
	snapshot: WorkflowSnapshot,
	status: WorkflowJobStatus | "error",
	message: string,
	now = Date.now,
): void {
	if (status === "error") snapshot.logs.push(`[error] ${message}`);
	for (const agent of snapshot.agents) {
		if (agent.status === "running" || agent.status === "queued") {
			agent.status = status === "cancelled" || status === "interrupted" ? "skipped" : "error";
			agent.endedAt = agent.endedAt ?? now();
		}
	}
}
