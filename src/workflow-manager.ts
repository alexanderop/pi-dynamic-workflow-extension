import {
	createWorkflowSnapshot,
	preview,
	updateSnapshotStats,
	type WorkflowSnapshot,
} from "./display.js";
import {
	parseWorkflowScript,
	type RunWorkflowOptions,
	runWorkflow,
} from "./workflow.js";

export type WorkflowJobStatus = "running" | "done" | "error" | "cancelled";

export interface WorkflowJob {
	id: number;
	name: string;
	description?: string;
	status: WorkflowJobStatus;
	script: string;
	args?: unknown;
	snapshot: WorkflowSnapshot;
	startedAt: number;
	finishedAt?: number;
	error?: string;
	result?: unknown;
}

export type WorkflowJobListener = (job: WorkflowJob) => void;

export interface StartWorkflowJobOptions
	extends Omit<
		RunWorkflowOptions,
		| "args"
		| "signal"
		| "onPhase"
		| "onLog"
		| "onAgentStart"
		| "onAgentEnd"
		| "onAgentActivity"
	> {
	args?: unknown;
}

interface InternalWorkflowJob extends WorkflowJob {
	controller: AbortController;
	promise?: Promise<void>;
}

export class WorkflowManager {
	private nextId = 1;
	private readonly jobs: InternalWorkflowJob[] = [];
	private readonly listeners = new Set<WorkflowJobListener>();

	start(script: string, options: StartWorkflowJobOptions = {}): WorkflowJob {
		const parsed = parseWorkflowScript(script);
		const snapshot = createWorkflowSnapshot(parsed.meta);
		const job: InternalWorkflowJob = {
			id: this.nextId++,
			name: parsed.meta.name,
			description: parsed.meta.description,
			status: "running",
			script,
			args: options.args,
			snapshot,
			startedAt: Date.now(),
			controller: new AbortController(),
		};

		this.jobs.push(job);
		this.touch(job);
		job.promise = this.runJob(job, options);
		return job;
	}

	getJobs(): WorkflowJob[] {
		return [...this.jobs];
	}

	getJob(id: number): WorkflowJob | undefined {
		return this.jobs.find((job) => job.id === id);
	}

	cancel(id: number): boolean {
		const job = this.jobs.find((item) => item.id === id);
		if (job?.status !== "running") return false;
		job.status = "cancelled";
		job.controller.abort();
		this.touch(job);
		return true;
	}

	cancelAll(): void {
		for (const job of this.jobs) this.cancel(job.id);
	}

	onChange(listener: WorkflowJobListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async runJob(
		job: InternalWorkflowJob,
		options: StartWorkflowJobOptions,
	): Promise<void> {
		try {
			const result = await runWorkflow(job.script, {
				cwd: options.cwd,
				args: options.args,
				agent: options.agent,
				concurrency: options.concurrency,
				maxEstimatedTokens: options.maxEstimatedTokens,
				session: options.session,
				signal: job.controller.signal,
				onPhase: (title) => {
					job.snapshot.currentPhase = title;
					if (!job.snapshot.phases.includes(title))
						job.snapshot.phases.push(title);
					this.touch(job);
				},
				onLog: (message) => {
					job.snapshot.logs.push(message);
					this.touch(job);
				},
				onAgentStart: (event) => {
					job.snapshot.agents.push({
						id: event.id,
						label: event.label,
						phase: event.phase,
						prompt: event.prompt,
						status: "running",
						activity: [],
					});
					this.touch(job);
				},
				onAgentActivity: (event) => {
					const agent = job.snapshot.agents.find(
						(item) => item.id === event.id,
					);
					if (!agent) return;
					agent.activity = [
						...(agent.activity ?? []),
						{
							type: event.type,
							text: event.text,
							toolName: event.toolName,
							argsPreview: event.argsPreview,
						},
					].slice(-12);
					this.touch(job);
				},
				onAgentEnd: (event) => {
					const agent = job.snapshot.agents.find(
						(item) => item.id === event.id,
					);
					if (agent) {
						agent.status = event.error ? "error" : "done";
						agent.resultPreview = preview(event.result);
						if (event.error) agent.error = event.error.message;
					}
					this.touch(job);
				},
			});

			if (result.agentCount === 0) {
				throw new Error("workflow scripts must call agent() at least once");
			}

			job.status = "done";
			job.result = result.result;
			job.snapshot.currentPhase = undefined;
			job.snapshot.result = result.result;
			for (const agent of job.snapshot.agents) {
				if (agent.status === "running" || agent.status === "queued")
					agent.status = "done";
			}
		} catch (error) {
			if (job.controller.signal.aborted || job.status === "cancelled") {
				job.status = "cancelled";
				job.error = "Workflow was cancelled";
			} else {
				const message = error instanceof Error ? error.message : String(error);
				job.status = "error";
				job.error = message;
				job.snapshot.logs.push(`[error] ${message}`);
			}
			for (const agent of job.snapshot.agents) {
				if (agent.status === "running" || agent.status === "queued")
					agent.status = job.status === "cancelled" ? "skipped" : "error";
			}
		} finally {
			job.finishedAt = Date.now();
			this.touch(job);
		}
	}

	private touch(job: InternalWorkflowJob): void {
		job.snapshot.durationMs = Date.now() - job.startedAt;
		updateSnapshotStats(job.snapshot);
		for (const listener of [...this.listeners]) {
			try {
				listener(job);
			} catch {
				// Listener failures should not affect the running workflow.
			}
		}
	}
}

export function createWorkflowManager(): WorkflowManager {
	return new WorkflowManager();
}

export function cloneWorkflowSnapshot(
	snapshot: WorkflowSnapshot,
): WorkflowSnapshot {
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
