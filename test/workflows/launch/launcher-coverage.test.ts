import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchWorkflow } from "#src/workflows/launch/launcher.ts";
import type {
  WorkflowLaunchOptions,
  WorkflowTaskNotification,
} from "#src/workflows/launch/launcher.ts";
import type { WorkflowLaunchOperations } from "#src/workflows/launch/operations.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { err, ok } from "#src/workflows/result.ts";
import { workflowScript } from "../script/workflow-factory.ts";
import { agent, setupAgentMock } from "../agent/agent-mock.ts";
import { projectSavedWorkflowDir, savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { unwrap } from "../../support.ts";

const immediateDefer = (start: () => void): void => start();

function fakeOperations(
  overrides: Partial<WorkflowLaunchOperations> = {},
): WorkflowLaunchOperations {
  return {
    resolveSavedWorkflowByName: async () => {
      throw new Error("not used");
    },
    readSavedWorkflowScriptPath: async () => {
      throw new Error("not used");
    },
    readJournalEvents: async () => [],
    createJournal: () => ({ append: async () => undefined }),
    prepareRunFiles: async () => ok(undefined),
    writeRun: async () => ok(undefined),
    writeTerminalOutput: async () => ok(undefined),
    ...overrides,
  };
}

describe("launchWorkflow coverage", () => {
  let tempDir: string;
  let rootDir: string;
  let now: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-launcher-cov-"));
    rootDir = join(tempDir, ".pi", "workflows");
    now = 100;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function launchOptions(overrides: Partial<WorkflowLaunchOptions> = {}): WorkflowLaunchOptions {
    return {
      rootDir,
      now: () => now,
      createTaskId: () => "task_test",
      createRunId: () => "wf_test",
      defer: immediateDefer,
      ...overrides,
    };
  }

  it("should generate crypto-random task and run ids when no id factories are provided", async () => {
    const agents = setupAgentMock();
    const result = await launchWorkflow(
      { script: workflowScript({ meta: { name: "random-ids" }, body: "return 1;" }) },
      {
        rootDir,
        schedulerRunner: agents.schedulerRunner,
        defer: immediateDefer,
      },
    );

    const launch = unwrap(result);
    expect(launch.taskId).toMatch(/^task_[0-9a-f]{12}$/);
    expect(launch.runId).toMatch(/^wf_[0-9a-f]{16}$/);
    const completed = unwrap(await launch.completion);
    expect(completed.status).toBe("completed");
    agents.close();
  });

  it("should reject inline launch requests with an empty script", async () => {
    const result = await launchWorkflow({ script: "" }, launchOptions());

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowLaunchInvalidRequestError",
        message: expect.stringContaining("must not be empty"),
      },
    });
  });

  it("should reject inline launch requests whose script exceeds the maximum length", async () => {
    const result = await launchWorkflow({ script: "a".repeat(524_289) }, launchOptions());

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowLaunchInvalidRequestError",
        message: expect.stringContaining("must not exceed"),
      },
    });
  });

  it("should surface a persistence error when the resume journal cannot be read", async () => {
    const operations = fakeOperations({
      readJournalEvents: async () => {
        throw new Error("journal unreadable");
      },
    });
    const result = await launchWorkflow(
      {
        script: workflowScript({ meta: { name: "resume-fail" }, body: "return 1;" }),
        resumeFromRunId: "wf_missing",
      },
      launchOptions({ operations }),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchPersistenceError" },
    });
  });

  it("should surface a persistence error when preparing run files fails", async () => {
    const operations = fakeOperations({
      prepareRunFiles: async () =>
        err({
          _tag: "WorkflowLaunchPersistenceError" as const,
          message: "cannot prepare",
          path: "/nope",
          cause: new Error("prepare boom"),
        }),
    });
    const result = await launchWorkflow(
      { script: workflowScript({ meta: { name: "prepare-fail" }, body: "return 1;" }) },
      launchOptions({ operations }),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchPersistenceError", message: "cannot prepare" },
    });
  });

  it("should derive the run description and summary from required workflow meta description", async () => {
    const notifications: WorkflowTaskNotification[] = [];
    const writes: WorkflowRunState[] = [];
    const script = workflowScript({
      meta: { name: "meta-desc", description: "Meta supplied description" },
      body: "return 1;",
    });
    const operations = fakeOperations({
      writeRun: async ({ state }) => {
        writes.push(state);
        return ok(undefined);
      },
    });

    const launch = unwrap(
      await launchWorkflow(
        { script, description: "ignored request description" },
        launchOptions({
          operations,
          notifyTerminal: (notification) => {
            notifications.push(notification);
          },
        }),
      ),
    );
    now = 125;
    unwrap(await launch.completion);

    expect(notifications[0]?.details.summary).toBe(
      'Dynamic workflow "Meta supplied description" completed',
    );
    expect(writes.at(-1)).toMatchObject({ description: "Meta supplied description" });
  });

  it("should resolve saved workflow directories from the root dir when none are configured", async () => {
    const script = workflowScript({ meta: { name: "by-name" }, body: "return 'named';" });
    await mkdir(projectSavedWorkflowDir(rootDir), { recursive: true });
    await writeFile(savedWorkflowPath(projectSavedWorkflowDir(rootDir), "by-name"), script, "utf8");
    const agents = setupAgentMock();

    const launch = unwrap(
      await launchWorkflow(
        { name: "by-name" },
        launchOptions({ schedulerRunner: agents.schedulerRunner }),
      ),
    );
    const completed = unwrap(await launch.completion);

    expect(completed).toMatchObject({ workflowName: "by-name", result: "named" });
    agents.close();
  });

  it("should map runtime phases into the manifest when meta declares no phases", async () => {
    const writes: WorkflowRunState[] = [];
    const script = workflowScript({
      meta: { name: "runtime-phases" },
      body: `phase("Runtime Phase");\nreturn 1;`,
    });
    const operations = fakeOperations({
      writeRun: async ({ state }) => {
        writes.push(state);
        return ok(undefined);
      },
    });

    const launch = unwrap(await launchWorkflow({ script }, launchOptions({ operations })));
    now = 125;
    const completed = unwrap(await launch.completion);

    expect(completed.phases).toMatchObject([{ title: "Runtime Phase" }]);
    expect(writes.some((state) => state.phases.some((p) => p.title === "Runtime Phase"))).toBe(
      true,
    );
  });

  it("should report a background error when terminal output writing fails after success", async () => {
    const operations = fakeOperations({
      writeTerminalOutput: async () =>
        err({
          _tag: "WorkflowLaunchPersistenceError" as const,
          message: "output write failed",
          path: "/out",
          cause: new Error("out boom"),
        }),
    });

    const launch = unwrap(
      await launchWorkflow(
        { script: workflowScript({ meta: { name: "terminal-output-fail" }, body: "return 1;" }) },
        launchOptions({ operations }),
      ),
    );
    now = 125;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchBackgroundError", message: "output write failed" },
    });
  });

  it("should report a background error when run manifest writing fails during terminal artifacts", async () => {
    let terminalWriteSeen = false;
    const operations = fakeOperations({
      writeTerminalOutput: async () => {
        terminalWriteSeen = true;
        return ok(undefined);
      },
      writeRun: async () => {
        // Only fail the terminal manifest write, which happens after the
        // terminal output has been written.
        if (terminalWriteSeen) {
          return err({
            _tag: "WorkflowLaunchPersistenceError" as const,
            message: "manifest write failed",
            path: "/run",
            cause: new Error("run boom"),
          });
        }
        return ok(undefined);
      },
    });

    const launch = unwrap(
      await launchWorkflow(
        { script: workflowScript({ meta: { name: "terminal-manifest-fail" }, body: "return 1;" }) },
        launchOptions({ operations }),
      ),
    );
    now = 125;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchBackgroundError", message: "manifest write failed" },
    });
  });

  it("should report a background error when terminal output writing fails after a failed run", async () => {
    const operations = fakeOperations({
      writeTerminalOutput: async () =>
        err({
          _tag: "WorkflowLaunchPersistenceError" as const,
          message: "failed-path output write failed",
          path: "/out",
          cause: new Error("out boom"),
        }),
    });

    const launch = unwrap(
      await launchWorkflow(
        {
          script: workflowScript({
            meta: { name: "fail-then-output-fail" },
            body: `throw new Error("workflow exploded");`,
          }),
        },
        launchOptions({ operations }),
      ),
    );
    now = 125;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowLaunchBackgroundError",
        message: "failed-path output write failed",
      },
    });
  });

  it("should report a terminal notification error when notifying the caller throws", async () => {
    const operations = fakeOperations();

    const launch = unwrap(
      await launchWorkflow(
        { script: workflowScript({ meta: { name: "notify-throws" }, body: "return 1;" }) },
        launchOptions({
          operations,
          notifyTerminal: () => {
            throw new Error("notify exploded");
          },
        }),
      ),
    );
    now = 125;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowLaunchBackgroundError",
        message: expect.stringContaining("Could not enqueue terminal notification"),
      },
    });
  });

  it("should swallow live manifest persistence rejections without failing the run", async () => {
    const slow = agent.pending({ label: "slow-agent" });
    const agents = setupAgentMock(slow);
    let liveWriteCount = 0;
    const operations = fakeOperations({
      // Reject only the live progress writes (which happen while the agent is
      // running) so the persister's catch handler is exercised, but allow the
      // terminal manifest write to succeed.
      writeRun: async ({ state }) => {
        if (state.status === "running") {
          liveWriteCount += 1;
          throw new Error("live write boom");
        }
        return ok(undefined);
      },
    });

    const launch = unwrap(
      await launchWorkflow(
        {
          script: workflowScript({
            meta: { name: "live-write-reject" },
            body: `return await agent("scan", { label: "slow-agent" });`,
          }),
          args: {},
        },
        launchOptions({ operations, schedulerRunner: agents.schedulerRunner }),
      ),
    );

    await slow.waitUntilStarted();
    now = 125;
    slow.resolve("done");
    const completion = await launch.completion;

    expect(completion).toMatchObject({ status: "ok", value: { status: "completed" } });
    expect(liveWriteCount).toBeGreaterThan(0);
    agents.close();
  });

  it("should fail using only the initial run state when runtime setup throws before any progress", async () => {
    const writes: WorkflowRunState[] = [];
    const operations = fakeOperations({
      writeRun: async ({ state }) => {
        writes.push(state);
        return ok(undefined);
      },
    });

    // Throwing from onRuntimeControlReady makes runtime setup throw before any
    // runtime state exists, so the failure path runs with no partial state.
    const launch = unwrap(
      await launchWorkflow(
        { script: workflowScript({ meta: { name: "setup-throws" }, body: "return 1;" }) },
        launchOptions({
          operations,
          onRuntimeControlReady: () => {
            throw new Error("control setup exploded");
          },
        }),
      ),
    );
    now = 125;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowLaunchBackgroundError",
        message: "control setup exploded",
      },
    });
    expect(writes.at(-1)).toMatchObject({ status: "failed" });
  });

  it("should map a thrown Error cause into the background error message", async () => {
    const operations = fakeOperations({
      // Reject (throw) a real Error so the background promise's catch handler
      // maps it through the Error branch of errorMessage.
      writeTerminalOutput: async () => {
        throw new Error("error instance failure");
      },
    });

    const launch = unwrap(
      await launchWorkflow(
        { script: workflowScript({ meta: { name: "error-reject" }, body: "return 1;" }) },
        launchOptions({ operations }),
      ),
    );
    now = 125;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchBackgroundError", message: "error instance failure" },
    });
  });

  it("should map a non-Error cause with a message into the background error message", async () => {
    const operations = fakeOperations({
      // Reject (throw) instead of returning a Result so the rejection
      // propagates to the background promise's catch handler.
      writeTerminalOutput: async () => Promise.reject({ message: "structured failure" }),
    });

    const launch = unwrap(
      await launchWorkflow(
        { script: workflowScript({ meta: { name: "structured-reject" }, body: "return 1;" }) },
        launchOptions({ operations }),
      ),
    );
    now = 125;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchBackgroundError", message: "structured failure" },
    });
  });

  it("should stringify a non-Error cause without a message into the background error message", async () => {
    const operations = fakeOperations({
      writeTerminalOutput: async () => Promise.reject("plain string failure"),
    });

    const launch = unwrap(
      await launchWorkflow(
        { script: workflowScript({ meta: { name: "string-reject" }, body: "return 1;" }) },
        launchOptions({ operations }),
      ),
    );
    now = 125;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchBackgroundError", message: "plain string failure" },
    });
  });
});
