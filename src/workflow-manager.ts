import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	createWorkflowSnapshot,
	preview,
	updateSnapshotStats,
	type WorkflowSnapshot,
} from "./display.js";
import {
	createFileWorkflowJournal,
	parseWorkflowScript,
	type RunWorkflowOptions,
	runWorkflow,
	type WorkflowJournal,
} from "./workflow.js";

export type WorkflowJobStatus =
	| "running"
	| "done"
	| "error"
	| "cancelled"
	| "interrupted";

export interface WorkflowJob {
	id: number;
	runId: string;
	name: string;
	description?: string;
	status: WorkflowJobStatus;
	script: string;
	scriptPath?: string;
	args?: unknown;
	snapshot: WorkflowSnapshot;
	startedAt: number;
	finishedAt?: number;
	error?: string;
	result?: unknown;
}

export interface WorkflowJobStore {
	loadJobs(): WorkflowJob[];
	saveJob(job: WorkflowJob): void;
	saveScript(job: WorkflowJob): string;
	createJournal(runId: string): WorkflowJournal;
}

export interface WorkflowManagerOptions {
	store?: WorkflowJobStore;
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

	constructor(private store?: WorkflowJobStore) {
		this.restoreJobs();
	}

	attachStore(store: WorkflowJobStore): void {
		this.store = store;
		this.restoreJobs();
	}

	start(script: string, options: StartWorkflowJobOptions = {}): WorkflowJob {
		const parsed = parseWorkflowScript(script);
		const snapshot = createWorkflowSnapshot(parsed.meta);
		const job: InternalWorkflowJob = {
			id: this.nextId++,
			runId: `wf_${randomUUID()}`,
			name: parsed.meta.name,
			description: parsed.meta.description,
			status: "running",
			script,
			args: options.args,
			snapshot,
			startedAt: Date.now(),
			controller: new AbortController(),
		};

		job.scriptPath = this.store?.saveScript(job);
		this.jobs.push(job);
		this.touch(job);
		job.promise = this.runJob(job, {
			...options,
			journal: options.journal ?? this.store?.createJournal(job.runId),
		});
		return job;
	}

	getJobs(): WorkflowJob[] {
		return [...this.jobs];
	}

	getJob(id: number): WorkflowJob | undefined {
		return this.jobs.find((job) => job.id === id);
	}

	resume(
		id: number,
		options: StartWorkflowJobOptions = {},
	): WorkflowJob | undefined {
		const job = this.jobs.find((item) => item.id === id);
		if (!job || job.status === "running") return job;
		const parsed = parseWorkflowScript(job.script);
		job.name = parsed.meta.name;
		job.description = parsed.meta.description;
		job.args = options.args ?? job.args;
		job.status = "running";
		job.error = undefined;
		job.result = undefined;
		job.finishedAt = undefined;
		job.startedAt = Date.now();
		job.snapshot = createWorkflowSnapshot(parsed.meta);
		job.controller = new AbortController();
		job.scriptPath = this.store?.saveScript(job) ?? job.scriptPath;
		this.touch(job);
		job.promise = this.runJob(job, {
			...options,
			args: job.args,
			journal: options.journal ?? this.store?.createJournal(job.runId),
		});
		return job;
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
				journal: options.journal,
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

	private restoreJobs(): void {
		if (!this.store) return;
		const existingRunIds = new Set(this.jobs.map((job) => job.runId));
		for (const job of this.store.loadJobs()) {
			if (existingRunIds.has(job.runId)) continue;
			const restored: InternalWorkflowJob = {
				...job,
				status: job.status === "running" ? "interrupted" : job.status,
				controller: new AbortController(),
			};
			this.jobs.push(restored);
			if (restored.status !== job.status) this.store.saveJob(restored);
			this.nextId = Math.max(this.nextId, restored.id + 1);
		}
	}

	private touch(job: InternalWorkflowJob): void {
		job.snapshot.durationMs = Date.now() - job.startedAt;
		updateSnapshotStats(job.snapshot);
		this.store?.saveJob(job);
		for (const listener of [...this.listeners]) {
			try {
				listener(job);
			} catch {
				// Listener failures should not affect the running workflow.
			}
		}
	}
}

export function createWorkflowManager(
	options: WorkflowManagerOptions = {},
): WorkflowManager {
	return new WorkflowManager(options.store);
}

export function createFileWorkflowStore(rootDir: string): WorkflowJobStore {
	mkdirSync(rootDir, { recursive: true });
	const runDir = (runId: string) => join(rootDir, runId);
	const manifestPath = (runId: string) => join(runDir(runId), "manifest.json");
	const scriptPath = (name: string) =>
		join(rootDir, "scripts", `${name}.workflow.js`);
	return {
		loadJobs() {
			if (!existsSync(rootDir)) return [];
			return readdirSync(rootDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => manifestPath(entry.name))
				.filter((path) => existsSync(path))
				.map((path) => JSON.parse(readFileSync(path, "utf8")) as WorkflowJob)
				.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
		},
		saveJob(job) {
			mkdirSync(runDir(job.runId), { recursive: true });
			const {
				id,
				runId,
				name,
				description,
				status,
				script,
				scriptPath,
				args,
				snapshot,
				startedAt,
				finishedAt,
				error,
				result,
			} = job;
			writeFileSync(
				manifestPath(runId),
				`${JSON.stringify(
					{
						id,
						runId,
						name,
						description,
						status,
						script,
						scriptPath,
						args,
						snapshot,
						startedAt,
						finishedAt,
						error,
						result,
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
		},
		saveScript(job) {
			const path = scriptPath(job.name);
			mkdirSync(join(rootDir, "scripts"), { recursive: true });
			writeFileSync(path, job.script, "utf8");
			return path;
		},
		createJournal(runId) {
			return createFileWorkflowJournal(join(runDir(runId), "journal.jsonl"));
		},
	};
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
