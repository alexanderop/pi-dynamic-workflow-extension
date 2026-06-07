/* eslint-disable vitest/no-standalone-expect */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { registerWorkflowsCommand } from "#src/extension/commands/workflows-command.ts";
import {
  showWorkflowsTui,
  type ShowWorkflowsTuiOptions,
} from "#src/extension/tui/workflows-view.ts";
import {
  registerWorkflowRunControl,
  unregisterWorkflowRunControl,
} from "#src/workflows/run/control-registry.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import { delay, unwrap } from "../../support.ts";

vi.mock("#src/extension/tui/workflows-view.ts", () => ({
  showWorkflowsTui: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

type WorkflowCommandMode = "tui" | "rpc" | "json" | "print";

interface RegisteredCommandForTest {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface WorkflowCommandPageOptions {
  readonly tempDir?: string;
  readonly rootDir?: string;
}

const activePages = new Set<WorkflowsCommandPage>();

afterEach(async () => {
  await Promise.all([...activePages].map((page) => page.cleanup()));
  activePages.clear();
});

export function workflowsCommandPage(
  options: WorkflowCommandPageOptions = {},
): WorkflowsCommandPage {
  const page = new WorkflowsCommandPage(options);
  activePages.add(page);
  return page;
}

export class WorkflowsCommandPage {
  #tempDir?: string;
  #rootDir?: string;
  #ownsTempDir = false;
  #runs: WorkflowRunState[] = [];
  #projectWorkflows: Array<{ readonly name: string; readonly source: string }> = [];
  #stdout = "";
  #stdoutSpy?: ReturnType<typeof vi.spyOn>;
  #stderrSpy?: ReturnType<typeof vi.spyOn>;
  #unregisterControls: Array<() => void> = [];

  readonly #controls = new Map<
    string,
    {
      readonly pause: ReturnType<typeof vi.fn<() => void>>;
      readonly resume: ReturnType<typeof vi.fn<() => void>>;
      readonly stopRun: ReturnType<typeof vi.fn<() => void>>;
      readonly stopAgent: ReturnType<typeof vi.fn<(agentId: string) => void>>;
    }
  >();

  constructor(options: WorkflowCommandPageOptions = {}) {
    this.#tempDir = options.tempDir;
    this.#rootDir = options.rootDir;
  }

  get tempDir(): string {
    if (this.#tempDir === undefined) throw new Error("Command page temp dir is not ready.");
    return this.#tempDir;
  }

  get rootDir(): string {
    if (this.#rootDir === undefined) throw new Error("Command page root dir is not ready.");
    return this.#rootDir;
  }

  withRootDir(path: string): this {
    this.#rootDir = path;
    return this;
  }

  withRun(run: WorkflowRunState): this {
    this.#runs = [...this.#runs, run];
    return this;
  }

  withRuns(...runs: WorkflowRunState[]): this {
    this.#runs = [...this.#runs, ...runs];
    return this;
  }

  withSavedWorkflow(name: string, source: string): this {
    this.#projectWorkflows = [...this.#projectWorkflows, { name, source }];
    return this;
  }

  async openTui(): Promise<this> {
    await this.#open("tui");
    return this;
  }

  async openPrint(): Promise<this> {
    await this.#open("print");
    return this;
  }

  async openJson(): Promise<this> {
    await this.#open("json");
    return this;
  }

  async openRpc(): Promise<this> {
    await this.#open("rpc");
    return this;
  }

  pauseRun(runId: string): this {
    this.#tuiOptions().onPauseRun?.(runId);
    return this;
  }

  resumeRun(runId: string): this {
    this.#tuiOptions().onResumeRun?.(runId);
    return this;
  }

  stopRun(runId: string): this {
    this.#tuiOptions().onStopRun?.(runId);
    return this;
  }

  resumeStoppedRun(runId: string): this {
    this.#tuiOptions().onResumeStoppedRun?.(runId);
    return this;
  }

  stopAgent(runId: string, agentId: string): this {
    this.#tuiOptions().onStopAgent?.(runId, agentId);
    return this;
  }

  shouldHavePassedRunsToTui(count: number): this {
    expect(this.#tuiOptions().runs).toHaveLength(count);
    return this;
  }

  shouldHaveRegisteredCallbacks(...names: Array<keyof ShowWorkflowsTuiOptions>): this {
    const options = this.#tuiOptions();
    for (const name of names) expect(options[name]).toEqual(expect.any(Function));
    return this;
  }

  shouldPrintText(textOrPattern: string | RegExp): this {
    assertText(this.#stdout, textOrPattern);
    return this;
  }

  shouldReturnJson(matcher: Record<string, unknown>): this {
    const lines = this.#stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject(matcher);
    return this;
  }

  shouldHaveClosed(): this {
    expect(vi.mocked(showWorkflowsTui)).toHaveBeenCalled();
    return this;
  }

  async shouldHavePersistedRunStatus(
    runId: string,
    status: WorkflowRunState["status"],
  ): Promise<this> {
    await waitForRunStatus(new WorkflowRunStore({ rootDir: this.rootDir }), runId, status);
    return this;
  }

  async shouldHavePersistedAgentStatus(
    runId: string,
    agentId: string,
    status: string,
  ): Promise<this> {
    await waitForAgentStatus(
      new WorkflowRunStore({ rootDir: this.rootDir }),
      runId,
      agentId,
      status,
    );
    return this;
  }

  async cleanup(): Promise<void> {
    activePages.delete(this);
    for (const unregister of this.#unregisterControls) unregister();
    this.#unregisterControls = [];
    for (const run of this.#runs) unregisterWorkflowRunControl(run.runId);
    this.#stdoutSpy?.mockRestore();
    this.#stderrSpy?.mockRestore();
    vi.mocked(showWorkflowsTui).mockClear();
    if (this.#ownsTempDir && this.#tempDir !== undefined) {
      await rm(this.#tempDir, { recursive: true, force: true });
    }
  }

  async #open(mode: WorkflowCommandMode): Promise<void> {
    await this.#prepareFilesystem();
    vi.mocked(showWorkflowsTui).mockClear();
    this.#captureStreams();

    const command = this.#registerCommand();
    await command.handler("", {
      cwd: this.tempDir,
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      savedWorkflowDirs: {
        projectDir: this.rootDir,
      },
      ui: {
        custom: vi.fn<() => void>(),
        notify: vi.fn<() => void>(),
      },
    });
  }

  async #prepareFilesystem(): Promise<void> {
    if (this.#tempDir === undefined) {
      this.#tempDir = await mkdtemp(join(tmpdir(), "pi-workflows-command-page-"));
      this.#ownsTempDir = true;
    }
    this.#rootDir ??= join(this.#tempDir, ".pi", "workflows");

    const store = new WorkflowRunStore({ rootDir: this.rootDir });
    await Promise.all([
      ...this.#runs.map((run) => store.writeRun(run)),
      ...this.#projectWorkflows.map(({ name, source }) =>
        writeSavedWorkflow(this.rootDir, name, source),
      ),
    ]);

    for (const run of this.#runs) this.#registerControl(run.runId);
  }

  #registerControl(runId: string): void {
    if (this.#controls.has(runId)) return;

    const control = {
      pause: vi.fn<() => void>(),
      resume: vi.fn<() => void>(),
      stopRun: vi.fn<() => void>(),
      stopAgent: vi.fn<(agentId: string) => void>(),
    };
    this.#controls.set(runId, control);
    this.#unregisterControls.push(
      registerWorkflowRunControl(runId, {
        ...control,
        isPaused: () => false,
        isStopped: () => false,
      }),
    );
  }

  #captureStreams(): void {
    this.#stdout = "";
    this.#stdoutSpy?.mockRestore();
    this.#stderrSpy?.mockRestore();
    this.#stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      this.#stdout += String(chunk);
      return true;
    });
    this.#stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      String(chunk);
      return true;
    });
  }

  #registerCommand(): RegisteredCommandForTest {
    const registerCommandSpy = vi.fn<(...args: unknown[]) => void>();
    registerWorkflowsCommand({ registerCommand: registerCommandSpy } as never);
    return registerCommandSpy.mock.calls[0]?.[1] as RegisteredCommandForTest;
  }

  #tuiOptions(): ShowWorkflowsTuiOptions {
    const options = vi.mocked(showWorkflowsTui).mock.calls.at(-1)?.[1];
    if (options === undefined) throw new Error("Expected /workflows to open the TUI.");
    return options;
  }
}

async function writeSavedWorkflow(dir: string, name: string, source: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(savedWorkflowPath(dir, name), source, "utf8");
}

async function waitForRunStatus(
  store: WorkflowRunStore,
  runId: string,
  status: WorkflowRunState["status"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = unwrap(await store.readRun(runId));
    if (run.status === status) {
      expect(run.status).toBe(status);
      return;
    }
    await delay(1);
  }
  expect(unwrap(await store.readRun(runId)).status).toBe(status);
}

async function waitForAgentStatus(
  store: WorkflowRunStore,
  runId: string,
  agentId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const agent = unwrap(await store.readRun(runId)).workflowProgress.find(
      (entry) => entry.type === "workflow_agent" && entry.agentId === agentId,
    );
    if (agent?.type === "workflow_agent" && agent.state === status) {
      expect(agent.state).toBe(status);
      return;
    }
    await delay(1);
  }
  const agent = unwrap(await store.readRun(runId)).workflowProgress.find(
    (entry) => entry.type === "workflow_agent" && entry.agentId === agentId,
  );
  expect(agent).toMatchObject({ state: status });
}

function assertText(text: string, textOrPattern: string | RegExp): void {
  if (typeof textOrPattern === "string") expect(text).toContain(textOrPattern);
  else expect(text).toMatch(textOrPattern);
}
