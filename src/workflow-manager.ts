import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkflowSnapshot, updateSnapshotStats, type WorkflowSnapshot } from "./display.js";
import {
	createFileWorkflowJournal,
	parseWorkflowScript,
	type RunWorkflowOptions,
	runWorkflow,
	type WorkflowJournal,
} from "./workflow.js";
import {
	applyWorkflowSnapshotFailure,
	applyWorkflowSnapshotSuccess,
	createWorkflowSnapshotEventHandlers,
} from "./workflow-snapshot-events.js";

export type WorkflowJobStatus = "running" | "done" | "error" | "cancelled" | "interrupted";

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

export interface WorkflowStoreFileOperations {
	ensureDir(path: string): void;
	exists(path: string): boolean;
	listDirectories(path: string): string[];
	readFile(path: string): string;
	writeFile(path: string, value: string): void;
	createJournal(path: string): WorkflowJournal;
}

export const defaultWorkflowStoreFileOperations: WorkflowStoreFileOperations = {
	ensureDir(path) {
		mkdirSync(path, { recursive: true });
	},
	exists(path) {
		return existsSync(path);
	},
	listDirectories(path) {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	},
	readFile(path) {
		return readFileSync(path, "utf8");
	},
	writeFile(path, value) {
		writeFileSync(path, value, "utf8");
	},
	createJournal(path) {
		return createFileWorkflowJournal(path);
	},
};

export interface WorkflowManagerOptions {
	store?: WorkflowJobStore;
}

export type WorkflowJobListener = (job: WorkflowJob) => void;

export interface StartWorkflowJobOptions extends Omit<
	RunWorkflowOptions,
	"args" | "signal" | "onPhase" | "onLog" | "onAgentStart" | "onAgentEnd" | "onAgentActivity"
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

	resume(id: number, options: StartWorkflowJobOptions = {}): WorkflowJob | undefined {
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

	interrupt(id: number): boolean {
		const job = this.jobs.find((item) => item.id === id);
		if (job?.status !== "running") return false;
		job.status = "interrupted";
		job.controller.abort();
		this.touch(job);
		return true;
	}

	interruptAll(): void {
		for (const job of this.jobs) this.interrupt(job.id);
	}

	onChange(listener: WorkflowJobListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async runJob(job: InternalWorkflowJob, options: StartWorkflowJobOptions): Promise<void> {
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
				...createWorkflowSnapshotEventHandlers(job.snapshot, {
					emit: () => this.touch(job),
				}),
			});

			if (result.agentCount === 0) {
				throw new Error("workflow scripts must call agent() at least once");
			}

			job.status = "done";
			job.result = result.result;
			applyWorkflowSnapshotSuccess(job.snapshot, result);
		} catch (error) {
			let message: string;
			if (job.status === "cancelled") {
				message = "Workflow was cancelled";
				job.error = message;
			} else if (job.controller.signal.aborted || job.status === "interrupted") {
				job.status = "interrupted";
				message = "Workflow was interrupted";
				job.error = message;
			} else {
				message = error instanceof Error ? error.message : String(error);
				job.status = "error";
				job.error = message;
			}
			applyWorkflowSnapshotFailure(job.snapshot, job.status, message);
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
		for (const listener of Array.from(this.listeners)) {
			try {
				listener(job);
			} catch {
				// Listener failures should not affect the running workflow.
			}
		}
	}
}

export function createWorkflowManager(options: WorkflowManagerOptions = {}): WorkflowManager {
	return new WorkflowManager(options.store);
}

function isWorkflowJobStatus(value: unknown): value is WorkflowJobStatus {
	return (
		value === "running" || value === "done" || value === "error" || value === "cancelled" || value === "interrupted"
	);
}

function isSafeRunId(value: unknown): boolean {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function parseStoredJobManifest(
	path: string,
	expectedRunId: string,
	operations: WorkflowStoreFileOperations,
): WorkflowJob | undefined {
	try {
		const job = JSON.parse(operations.readFile(path)) as WorkflowJob;
		if (job.runId !== expectedRunId) return undefined;
		return isWorkflowJobStatus(job.status) ? job : undefined;
	} catch {
		return undefined;
	}
}

export function createFileWorkflowStore(
	rootDir: string,
	operations: WorkflowStoreFileOperations = defaultWorkflowStoreFileOperations,
): WorkflowJobStore {
	operations.ensureDir(rootDir);
	const runDir = (runId: string) => {
		if (!isSafeRunId(runId)) throw new Error(`unsafe workflow runId: ${runId}`);
		return join(rootDir, runId);
	};
	const manifestPath = (runId: string) => join(runDir(runId), "manifest.json");
	const scriptPath = (name: string) => join(rootDir, "scripts", `${name}.workflow.js`);
	return {
		loadJobs() {
			if (!operations.exists(rootDir)) return [];
			return operations
				.listDirectories(rootDir)
				.filter((name) => isSafeRunId(name))
				.flatMap((name): WorkflowJob[] => {
					const path = manifestPath(name);
					if (!operations.exists(path)) return [];
					const job = parseStoredJobManifest(path, name, operations);
					return job ? [job] : [];
				})
				.sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
		},
		saveJob(job) {
			operations.ensureDir(runDir(job.runId));
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
			operations.writeFile(
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
			);
		},
		saveScript(job) {
			const path = scriptPath(job.name);
			operations.ensureDir(join(rootDir, "scripts"));
			operations.writeFile(path, job.script);
			return path;
		},
		createJournal(runId) {
			return operations.createJournal(join(runDir(runId), "journal.jsonl"));
		},
	};
}

export { cloneWorkflowSnapshot } from "./display.js";
