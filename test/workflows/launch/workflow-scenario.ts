/* eslint-disable vitest/no-standalone-expect */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect } from "vitest";
import {
  launchWorkflow,
  workflowRunJournalPath,
  workflowRunOutputPath,
  workflowRunScriptPath,
  workflowRunTranscriptDir,
  type WorkflowLaunch,
  type WorkflowLaunchError,
  type WorkflowLaunchOptions,
  type WorkflowLaunchRequest,
  type WorkflowTaskNotification,
  type WorkflowTerminalOutput,
} from "#src/workflows/launch/launcher.ts";
import type { WorkflowJournalEvent } from "#src/workflows/journal/model.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { projectSavedWorkflowDir, savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import type { Result } from "#src/workflows/result.ts";
import {
  setupAgentMock,
  type AgentMockHandler,
  type AgentMockServer,
} from "../agent/agent-mock.ts";
import { pathExists, unwrap } from "../../support.ts";

export interface WorkflowScenarioOptions {
  readonly tempDir?: string;
  readonly rootDir?: string;
  readonly now?: number | (() => number);
  readonly runId?: string;
  readonly taskId?: string;
}

interface SavedWorkflowSource {
  readonly name: string;
  readonly source: string;
}

const activeScenarios = new Set<WorkflowScenario>();

afterEach(async () => {
  await Promise.all([...activeScenarios].map((scenario) => scenario.cleanup()));
  activeScenarios.clear();
});

export function workflowScenario(options: WorkflowScenarioOptions = {}): WorkflowScenario {
  const scenario = new WorkflowScenario(options);
  activeScenarios.add(scenario);
  return scenario;
}

export class WorkflowScenario {
  #tempDir?: string;
  #rootDir?: string;
  #now: () => number;
  #runId: string;
  #taskId: string;
  #script?: string;
  #scriptPathSource?: { readonly path: string; readonly source?: string };
  #args?: unknown;
  #projectSavedWorkflows: SavedWorkflowSource[] = [];
  #personalSavedWorkflows: SavedWorkflowSource[] = [];
  #personalDir?: string;
  #agents: AgentMockServer = setupAgentMock();
  #launchOptions: Partial<WorkflowLaunchOptions> = {};
  #notifications: WorkflowTaskNotification[] = [];
  #launch?: WorkflowLaunch;
  #launchError?: WorkflowLaunchError;
  #completed?: WorkflowRunState;
  #completionSettled = false;
  #ownsTempDir = false;

  constructor(options: WorkflowScenarioOptions = {}) {
    this.#tempDir = options.tempDir;
    this.#rootDir = options.rootDir;
    this.#now = normalizeNow(options.now ?? 100);
    this.#runId = options.runId ?? "wf_test";
    this.#taskId = options.taskId ?? "task_test";
  }

  get tempDir(): string {
    return this.#requireTempDir();
  }

  get rootDir(): string {
    return this.#requireRootDir();
  }

  get runId(): string {
    return this.#launch?.runId ?? this.#runId;
  }

  get taskId(): string {
    return this.#launch?.taskId ?? this.#taskId;
  }

  get scriptPath(): string {
    return this.#launch?.scriptPath ?? workflowRunScriptPath(this.rootDir, this.runId);
  }

  get transcriptDir(): string {
    return this.#launch?.transcriptDir ?? workflowRunTranscriptDir(this.rootDir, this.runId);
  }

  get outputPath(): string {
    return workflowRunOutputPath(this.rootDir, this.runId);
  }

  get journalPath(): string {
    return workflowRunJournalPath(this.rootDir, this.runId);
  }

  get agents(): AgentMockServer {
    return this.#agents;
  }

  get store(): WorkflowRunStore {
    return new WorkflowRunStore({ rootDir: this.rootDir });
  }

  get notifications(): readonly WorkflowTaskNotification[] {
    return this.#notifications;
  }

  withNow(valueOrFn: number | (() => number)): this {
    this.#now = normalizeNow(valueOrFn);
    return this;
  }

  withIds({ runId, taskId }: { readonly runId?: string; readonly taskId?: string }): this {
    if (runId !== undefined) this.#runId = runId;
    if (taskId !== undefined) this.#taskId = taskId;
    return this;
  }

  withRootDir(path: string): this {
    this.#rootDir = path;
    return this;
  }

  withScript(source: string, args?: unknown): this {
    this.#script = source;
    this.#args = args;
    return this;
  }

  withScriptPath(path: string, source?: string): this {
    this.#scriptPathSource = { path, source };
    return this;
  }

  withSavedWorkflow(name: string, source: string): this {
    this.#projectSavedWorkflows = [...this.#projectSavedWorkflows, { name, source }];
    return this;
  }

  withPersonalWorkflow(name: string, source: string): this {
    this.#personalSavedWorkflows = [...this.#personalSavedWorkflows, { name, source }];
    return this;
  }

  withAgents(...handlers: AgentMockHandler[]): this {
    this.#agents = setupAgentMock(...handlers);
    return this;
  }

  withLaunchOptions(overrides: Partial<WorkflowLaunchOptions>): this {
    this.#launchOptions = { ...this.#launchOptions, ...overrides };
    return this;
  }

  async launch(): Promise<this> {
    if (this.#script === undefined) {
      throw new Error("workflowScenario.launch() requires withScript(source) first.");
    }
    return await this.launchInline(this.#script, this.#args);
  }

  async launchInline(script = this.#script, args = this.#args): Promise<this> {
    if (script === undefined) {
      throw new Error("workflowScenario.launchInline() requires a script source.");
    }
    await this.#launchRequest({ script, args });
    return this;
  }

  async launchByName(name: string, args = this.#args): Promise<this> {
    await this.#launchRequest({ name, args });
    return this;
  }

  async launchByPath(path = this.#scriptPathSource?.path, args = this.#args): Promise<this> {
    if (path === undefined) {
      throw new Error("workflowScenario.launchByPath() requires a script path.");
    }
    await this.#launchRequest({ scriptPath: path, args });
    return this;
  }

  async resumeFrom(runId: string, script = this.#script, args = this.#args): Promise<this> {
    if (script === undefined) {
      throw new Error("workflowScenario.resumeFrom() requires a script source.");
    }
    await this.#launchRequest({ script, args, resumeFromRunId: runId });
    return this;
  }

  async complete(): Promise<WorkflowRunState> {
    const launch = this.#requireLaunch();
    this.#completed = unwrap(await launch.completion);
    this.#completionSettled = true;
    return this.#completed;
  }

  async expectLaunchError(tagOrMatcher: string | Partial<WorkflowLaunchError>): Promise<this> {
    if (this.#script !== undefined) {
      await this.#launchRequest({ script: this.#script, args: this.#args });
    } else if (this.#scriptPathSource !== undefined) {
      await this.#launchRequest({ scriptPath: this.#scriptPathSource.path, args: this.#args });
    } else {
      await this.#launchRequest({});
    }

    const error = this.#requireLaunchError();
    if (typeof tagOrMatcher === "string") {
      expect(error).toMatchObject({ _tag: tagOrMatcher });
    } else {
      expect(error).toMatchObject(tagOrMatcher);
    }
    return this;
  }

  shouldHaveReturnedTask(taskId = this.#taskId): this {
    expect(this.#requireLaunch().taskId).toBe(taskId);
    return this;
  }

  shouldHaveReturnedRun(runId = this.#runId): this {
    expect(this.#requireLaunch().runId).toBe(runId);
    return this;
  }

  shouldHaveReturnedImmediately(): this {
    this.#requireLaunch();
    expect(this.#completionSettled).toBe(false);
    return this;
  }

  shouldHaveConfirmationText(...fragments: string[]): this {
    const { confirmation } = this.#requireLaunch();
    for (const fragment of fragments) expect(confirmation).toContain(fragment);
    return this;
  }

  shouldHaveLaunchConfirmation(
    expected: Partial<
      Pick<WorkflowLaunch, "taskId" | "runId" | "scriptPath" | "transcriptDir">
    > = {},
  ): this {
    const launch = this.#requireLaunch();
    expect(launch).toMatchObject(expected);
    expect(launch.confirmation).toContain(
      `Workflow launched in background. Task ID: ${launch.taskId}`,
    );
    expect(launch.confirmation).toContain(`Run ID: ${launch.runId}`);
    expect(launch.confirmation).toContain(`Script file: ${launch.scriptPath}`);
    expect(launch.confirmation).toContain(`Transcript dir: ${launch.transcriptDir}`);
    expect(launch.confirmation).toContain("Use /workflows to watch live progress");
    return this;
  }

  async shouldHaveWrittenScriptCopy(expectedSource = this.#script): Promise<this> {
    expect(await pathExists(this.scriptPath)).toBe(true);
    if (expectedSource !== undefined) {
      await expect(readFile(this.scriptPath, "utf8")).resolves.toBe(expectedSource);
    }
    return this;
  }

  async shouldHaveWrittenInitialManifest(matcher: Partial<WorkflowRunState> = {}): Promise<this> {
    const manifest = unwrap(await this.store.readRun(this.runId));
    expect(manifest).toMatchObject({
      runId: this.runId,
      taskId: this.taskId,
      status: "running",
      scriptPath: this.scriptPath,
      logs: [],
      workflowProgress: [],
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      ...matcher,
    });
    return this;
  }

  async shouldHaveManifest(matcher: Partial<WorkflowRunState>): Promise<this> {
    expect(unwrap(await this.store.readRun(this.runId))).toMatchObject(matcher);
    return this;
  }

  shouldHaveStatus(status: WorkflowRunState["status"]): this {
    expect(this.#requireCompleted().status).toBe(status);
    return this;
  }

  shouldHaveCompletedWithResult(result: unknown): this {
    expect(this.#requireCompleted()).toMatchObject({ status: "completed", result });
    return this;
  }

  shouldHaveFailedWithError(matcher: unknown): this {
    const completed = this.#requireCompleted();
    expect(completed.status).toBe("failed");
    expect(completed.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: matcher })]),
    );
    return this;
  }

  async shouldHaveOutputFile(matcher: Partial<WorkflowTerminalOutput> = {}): Promise<this> {
    expect(await pathExists(this.outputPath)).toBe(true);
    const output = JSON.parse(await readFile(this.outputPath, "utf8")) as WorkflowTerminalOutput;
    expect(output).toMatchObject({
      runId: this.runId,
      taskId: this.taskId,
      outputPath: this.outputPath,
      ...matcher,
    });
    return this;
  }

  shouldHaveTaskNotification(matcher: Partial<WorkflowTaskNotification> = {}): this {
    expect(this.#notifications).toEqual(expect.arrayContaining([expect.objectContaining(matcher)]));
    return this;
  }

  async shouldHaveJournalEvent(
    type: WorkflowJournalEvent["type"],
    matcher: Partial<WorkflowJournalEvent> = {},
  ): Promise<this> {
    const events = await this.#readJournal();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type, ...matcher })]));
    return this;
  }

  async shouldNotHaveJournalEvent(
    type: WorkflowJournalEvent["type"],
    matcher: Partial<WorkflowJournalEvent> = {},
  ): Promise<this> {
    const events = await this.#readJournal();
    expect(events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type, ...matcher })]),
    );
    return this;
  }

  async shouldHaveUsedProjectSavedWorkflow(name: string): Promise<this> {
    const source = this.#projectSavedWorkflows.find((workflow) => workflow.name === name)?.source;
    if (source === undefined) {
      throw new Error(`No project saved workflow named '${name}' was configured.`);
    }
    await this.shouldHaveWrittenScriptCopy(source);
    return this;
  }

  async shouldHaveUsedPersonalSavedWorkflow(name: string): Promise<this> {
    const source = this.#personalSavedWorkflows.find((workflow) => workflow.name === name)?.source;
    if (source === undefined) {
      throw new Error(`No personal saved workflow named '${name}' was configured.`);
    }
    await this.shouldHaveWrittenScriptCopy(source);
    return this;
  }

  async shouldNotHaveCreatedRunStorage(): Promise<this> {
    expect(await pathExists(join(this.rootDir, this.runId))).toBe(false);
    return this;
  }

  async cleanup(): Promise<void> {
    activeScenarios.delete(this);
    if (this.#ownsTempDir && this.#tempDir !== undefined) {
      await rm(this.#tempDir, { recursive: true, force: true });
    }
    this.#agents.close();
  }

  async #launchRequest(request: WorkflowLaunchRequest): Promise<void> {
    await this.#prepareFilesystem();
    this.#launch = undefined;
    this.#launchError = undefined;
    this.#completed = undefined;
    this.#completionSettled = false;
    this.#notifications = [];

    const result = await launchWorkflow(request, this.#buildLaunchOptions());
    if (result.status === "error") {
      this.#launchError = result.error;
      return;
    }

    this.#launch = result.value;
    void result.value.completion.finally(() => {
      this.#completionSettled = true;
    });
  }

  async #prepareFilesystem(): Promise<void> {
    if (this.#tempDir === undefined) {
      this.#tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-scenario-"));
      this.#ownsTempDir = true;
    }
    if (this.#rootDir === undefined) {
      this.#rootDir = join(this.#tempDir, ".pi", "workflows");
    }
    this.#personalDir ??= join(this.#tempDir, "home", ".pi", "workflows");

    await Promise.all([
      ...this.#projectSavedWorkflows.map(({ name, source }) =>
        writeSavedWorkflow(projectSavedWorkflowDir(this.rootDir), name, source),
      ),
      ...this.#personalSavedWorkflows.map(({ name, source }) =>
        writeSavedWorkflow(this.#personalDir!, name, source),
      ),
      this.#scriptPathSource?.source === undefined
        ? Promise.resolve()
        : writeArbitraryFile(this.#scriptPathSource.path, this.#scriptPathSource.source),
    ]);
  }

  #buildLaunchOptions(): WorkflowLaunchOptions {
    const notifyTerminal = this.#launchOptions.notifyTerminal;
    return {
      ...this.#launchOptions,
      rootDir: this.rootDir,
      now: this.#now,
      createTaskId: () => this.#taskId,
      createRunId: () => this.#runId,
      schedulerRunner: this.#launchOptions.schedulerRunner ?? this.#agents.schedulerRunner,
      notifyTerminal: async (notification) => {
        this.#notifications.push(notification);
        await notifyTerminal?.(notification);
      },
      savedWorkflowDirs: {
        projectDir: projectSavedWorkflowDir(this.rootDir),
        personalDir: this.#personalDir,
        ...this.#launchOptions.savedWorkflowDirs,
      },
    };
  }

  async #readJournal(): Promise<WorkflowJournalEvent[]> {
    if (!(await pathExists(this.journalPath))) return [];
    return (await readFile(this.journalPath, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as WorkflowJournalEvent);
  }

  #requireTempDir(): string {
    if (this.#tempDir === undefined) throw new Error("Workflow scenario temp dir is not ready.");
    return this.#tempDir;
  }

  #requireRootDir(): string {
    if (this.#rootDir === undefined) throw new Error("Workflow scenario root dir is not ready.");
    return this.#rootDir;
  }

  #requireLaunch(): WorkflowLaunch {
    if (this.#launch === undefined) {
      const detail =
        this.#launchError === undefined
          ? "No launch has been run."
          : `Launch failed with ${this.#launchError["_tag"]}: ${this.#launchError.message}`;
      throw new Error(detail);
    }
    return this.#launch;
  }

  #requireLaunchError(): WorkflowLaunchError {
    if (this.#launchError === undefined) {
      throw new Error("Expected workflow launch to fail, but it succeeded.");
    }
    return this.#launchError;
  }

  #requireCompleted(): WorkflowRunState {
    if (this.#completed === undefined) {
      throw new Error("Workflow scenario has not completed. Call await scenario.complete() first.");
    }
    return this.#completed;
  }
}

async function writeSavedWorkflow(dir: string, name: string, source: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(savedWorkflowPath(dir, name), source, "utf8");
}

async function writeArbitraryFile(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
}

function normalizeNow(valueOrFn: number | (() => number)): () => number {
  if (typeof valueOrFn === "function") return valueOrFn;
  return () => valueOrFn;
}

export type WorkflowScenarioLaunchResult = Result<WorkflowLaunch, WorkflowLaunchError>;
