import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowAgent } from "../../builders/workflow-agent.ts";
import { WORKFLOW_NOW, workflowRun } from "../../builders/workflow-run.ts";
import {
  createWorkflowStatuslineController,
  registerWorkflowStatusline,
} from "#src/extension/statusline/workflow-statusline.ts";

describe("workflow statusline controller", () => {
  it("should set a Pi footer status when an active workflow updates", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => WORKFLOW_NOW,
    });

    controller.update(
      workflowRun.running("review", {
        startTime: WORKFLOW_NOW - 3_000,
        agents: [
          workflowAgent.done("scan", { phase: "Review" }),
          workflowAgent.running("verify", { phase: "Verify" }),
        ],
        phases: ["Review", "Verify"],
      }),
    );

    expect(setStatus).toHaveBeenCalledWith(
      "dynamic-workflows",
      "○ review  1/2 agents · 3s · phase Verify · agent verify",
    );
  });

  it("should keep the newest active workflow for the current session", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => WORKFLOW_NOW,
      sessionId: "session_current",
    });

    controller.setRuns([
      workflowRun.running("older", {
        runId: "wf_older",
        sessionId: "session_current",
        startTime: WORKFLOW_NOW - 10_000,
      }),
      workflowRun.running("other", {
        runId: "wf_other",
        sessionId: "session_other",
        startTime: WORKFLOW_NOW - 1_000,
      }),
      workflowRun.running("newer", {
        runId: "wf_newer",
        sessionId: "session_current",
        startTime: WORKFLOW_NOW - 2_000,
      }),
    ]);

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", "○ newer  0/0 agents · 2s");
  });

  it("should clear the footer status when no active workflows remain", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => WORKFLOW_NOW,
    });

    controller.update(workflowRun.running("review"));
    controller.update(workflowRun.completed("review"));

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", undefined);
  });

  it("should refresh elapsed time when ticking an active workflow", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    let now = WORKFLOW_NOW;
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => now,
    });

    controller.update(workflowRun.running("review", { startTime: WORKFLOW_NOW }));
    now = WORKFLOW_NOW + 61_000;
    controller.tick();

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", "○ review  0/0 agents · 1m 1s");
  });

  it("should ignore updates for runs outside the bound session", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => WORKFLOW_NOW,
      sessionId: "session_current",
    });

    controller.update(workflowRun.running("other", { sessionId: "session_other" }));

    expect(setStatus).not.toHaveBeenCalled();
  });

  it("should clear the footer status when disposed", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({ setStatus });

    controller.update(workflowRun.running("review"));
    controller.dispose();

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", undefined);
  });
});

type SetStatusForTest = (key: string, text: string | undefined) => void;

interface RegisteredHandlers {
  session_start?: (event: unknown, ctx: unknown) => void;
  session_shutdown?: (event: unknown) => void;
}

const tempDirs: string[] = [];

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

function makeCwdWithRun(run: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-statusline-"));
  tempDirs.push(cwd);
  const runId = (run as { runId: string }).runId;
  const runDir = join(cwd, ".pi", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(run), "utf8");
  return cwd;
}

function makeEmptyCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-statusline-empty-"));
  tempDirs.push(cwd);
  return cwd;
}

// Many run manifests make each store read take long enough that a 1ms poll tick
// reliably fires while a prior refresh is still in flight (the refreshPending guard).
function makeCwdWithManyRuns(count: number): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-statusline-many-"));
  tempDirs.push(cwd);
  const root = join(cwd, ".pi", "workflows");
  for (let index = 0; index < count; index += 1) {
    const runId = `wf_run_${index}`;
    const run = workflowRun.running(`run-${index}`, {
      runId,
      sessionId: "session_current",
      startTime: WORKFLOW_NOW - index,
      agents: [workflowAgent.running("scan")],
    });
    const runDir = join(root, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "manifest.json"), JSON.stringify(run), "utf8");
  }
  return cwd;
}

// Makes `.pi/workflows` a regular file so the store's readdir fails with a
// non-ENOENT error, exercising the "store returned an error" branch.
function makeBrokenCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-statusline-broken-"));
  tempDirs.push(cwd);
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "workflows"), "not a directory", "utf8");
  return cwd;
}

function registerForTest(options?: { pollIntervalMs?: number; defaultInterval?: boolean }): {
  handlers: RegisteredHandlers;
  pi: { on: ReturnType<typeof vi.fn> };
} {
  const handlers: RegisteredHandlers = {};
  const pi = {
    on: vi.fn<(event: string, handler: (...args: unknown[]) => void) => void>((event, handler) => {
      (handlers as Record<string, unknown>)[event] = handler;
    }),
  };
  if (options?.defaultInterval === true) {
    registerWorkflowStatusline(pi as any);
  } else {
    registerWorkflowStatusline(pi as any, { pollIntervalMs: options?.pollIntervalMs ?? 5 });
  }
  return { handlers, pi };
}

function ctxForTest(options: {
  cwd: string;
  setStatus: SetStatusForTest;
  sessionId?: string;
  throwSessionId?: boolean;
}): unknown {
  return {
    cwd: options.cwd,
    ui: { setStatus: options.setStatus },
    sessionManager: {
      getSessionId: () => {
        if (options.throwSessionId === true) throw new Error("no session");
        return options.sessionId;
      },
    },
  };
}

describe("registerWorkflowStatusline", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should register session lifecycle handlers", () => {
    const { pi } = registerForTest();

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("should render active runs from the store on session start and clear them on shutdown", async () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const run = workflowRun.running("watched", {
      runId: "wf_watched",
      sessionId: "session_current",
      startTime: WORKFLOW_NOW - 1_000,
      agents: [workflowAgent.running("scan")],
    });
    const cwd = makeCwdWithRun(run);
    const { handlers } = registerForTest();

    handlers.session_start?.({}, ctxForTest({ cwd, setStatus, sessionId: "session_current" }));
    await waitFor(() =>
      setStatus.mock.calls.some(([, text]) => (text ?? "").includes("○ watched")),
    );

    handlers.session_shutdown?.({});
    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", undefined);
  });

  it("should dispose a prior session when a new session starts", async () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const cwd = makeEmptyCwd();
    const { handlers } = registerForTest();

    handlers.session_start?.({}, ctxForTest({ cwd, setStatus, sessionId: "first" }));
    await waitFor(() => setStatus.mock.calls.length > 0);
    const callsBefore = setStatus.mock.calls.length;
    // A second session start must dispose the first (clearing the footer status).
    handlers.session_start?.({}, ctxForTest({ cwd, setStatus, sessionId: "second" }));

    expect(setStatus.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(setStatus).toHaveBeenCalledWith("dynamic-workflows", undefined);
    handlers.session_shutdown?.({});
  });

  it("should poll repeatedly and skip overlapping refreshes while one is in flight", async () => {
    const setStatus = vi.fn<SetStatusForTest>();
    // A sizeable store makes each refresh slow enough that the 1ms poll re-enters
    // refresh while a prior one is still awaiting the store read.
    const cwd = makeCwdWithManyRuns(40);
    const { handlers } = registerForTest({ pollIntervalMs: 1 });

    handlers.session_start?.({}, ctxForTest({ cwd, setStatus, sessionId: "session_current" }));
    // Wait until at least one refresh has completed and rendered run progress, and
    // several poll ticks have fired (so an overlapping refresh was skipped).
    await waitFor(
      () =>
        setStatus.mock.calls.length >= 5 &&
        setStatus.mock.calls.some(([, text]) => (text ?? "").includes("agents")),
    );

    expect(setStatus.mock.calls.some(([, text]) => (text ?? "").includes("agents"))).toBe(true);
    handlers.session_shutdown?.({});
  });

  it("should clear the footer status when the store read fails", async () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const cwd = makeBrokenCwd();
    const { handlers } = registerForTest();

    handlers.session_start?.({}, ctxForTest({ cwd, setStatus, sessionId: "session_current" }));
    // First tick clears via controller.tick (no runs); store error means setRuns is never called.
    await waitFor(() => setStatus.mock.calls.length > 0);

    expect(setStatus).toHaveBeenCalledWith("dynamic-workflows", undefined);
    handlers.session_shutdown?.({});
  });

  it("should stop polling and clear the footer once the session is disposed", async () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const cwd = makeEmptyCwd();
    const { handlers } = registerForTest({ pollIntervalMs: 1 });

    handlers.session_start?.({}, ctxForTest({ cwd, setStatus, sessionId: "session_current" }));
    await waitFor(() => setStatus.mock.calls.length >= 2);
    handlers.session_shutdown?.({});
    // The interval is cleared on dispose and any in-flight refresh early-returns once
    // disposed, so the footer settles on the cleared (undefined) status.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", undefined);
  });

  it("should treat a session id lookup that throws as no active session", async () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const cwd = makeEmptyCwd();
    const { handlers } = registerForTest();

    handlers.session_start?.({}, ctxForTest({ cwd, setStatus, throwSessionId: true }));
    await waitFor(() => setStatus.mock.calls.length > 0);

    expect(setStatus).toHaveBeenCalled();
    handlers.session_shutdown?.({});
  });

  it("should fall back to the default poll interval when none is configured", async () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const cwd = makeEmptyCwd();
    const { handlers } = registerForTest({ defaultInterval: true });

    handlers.session_start?.({}, ctxForTest({ cwd, setStatus, sessionId: "session_current" }));
    await waitFor(() => setStatus.mock.calls.length > 0);

    expect(setStatus).toHaveBeenCalled();
    handlers.session_shutdown?.({});
  });
});
