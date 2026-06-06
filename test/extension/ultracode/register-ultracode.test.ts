import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUNDLED_ULTRACODE_WORKFLOW_SCRIPT } from "#src/extension/ultracode/launch-ultracode-workflow.ts";
import {
  handleUltracodeInput,
  registerUltracode,
} from "#src/extension/ultracode/register-ultracode.ts";
import { ok, type Result } from "#src/workflows/result.ts";
import type {
  WorkflowLaunch,
  WorkflowLaunchError,
  WorkflowLaunchOptions,
  WorkflowLaunchRequest,
  WorkflowTaskNotification,
} from "#src/workflows/launch/launcher.ts";

describe("registerUltracode", () => {
  it("should register session editor lifecycle and input handlers without registering a tool", () => {
    const pi = {
      on: vi.fn<(...args: unknown[]) => void>(),
      sendMessage: vi.fn<(...args: unknown[]) => void>(),
      registerTool: vi.fn<(...args: unknown[]) => void>(),
    };

    registerUltracode(pi as any);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(pi.registerTool).not.toHaveBeenCalled();
  });
});

describe("handleUltracodeInput", () => {
  it("should continue extension-sourced input", async () => {
    const result = await handleUltracodeInput(
      { type: "input", text: "ultracode audit", source: "extension" },
      contextForTest(),
    );

    expect(result).toEqual({ action: "continue" });
  });

  it("should continue non-trigger input", async () => {
    const result = await handleUltracodeInput(
      { type: "input", text: "please ultracode audit", source: "interactive" },
      contextForTest(),
    );

    expect(result).toEqual({ action: "continue" });
  });

  it("should warn and handle empty ultracode input", async () => {
    const ctx = contextForTest();

    const result = await handleUltracodeInput(
      { type: "input", text: "ultracode", source: "interactive" },
      ctx,
    );

    expect(result).toEqual({ action: "handled" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: ultracode <workflow goal>", "warning");
  });

  it("should directly launch the bundled ultracode workflow and handle the input", async () => {
    const launchWorkflow = vi.fn<LaunchWorkflowForTest>(async () =>
      ok({
        taskId: "task_1",
        runId: "wf_1",
        scriptPath: "/repo/.pi/workflows/wf_1/script.js",
        transcriptDir: "/repo/.pi/workflows/wf_1/transcripts",
        confirmation: "Started workflow wf_1",
        completion: Promise.resolve(ok({} as any)),
      }),
    );
    const sendMessage = vi.fn<(notification: WorkflowTaskNotification) => void>();
    const ctx = contextForTest({ cwd: "/repo", sessionId: "session_current" });

    const result = await handleUltracodeInput(
      { type: "input", text: "Ultracode audit repo", source: "interactive" },
      ctx,
      { sendMessage, launchDependencies: { launchWorkflow } },
    );

    expect(result).toEqual({ action: "handled" });
    expect(launchWorkflow).toHaveBeenCalledWith(
      {
        script: BUNDLED_ULTRACODE_WORKFLOW_SCRIPT,
        args: { goal: "audit repo" },
        description: "audit repo",
      },
      expect.objectContaining({
        rootDir: join("/repo", ".pi", "workflows"),
        sessionId: "session_current",
        triggerSource: "ultracode",
        cwd: "/repo",
        notifyTerminal: expect.any(Function),
        schedulerRunner: expect.any(Function),
      }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Started workflow wf_1", "info");
  });

  it("should ask Pi to continue from the terminal workflow notification", async () => {
    const notification = {
      customType: "workflow-task-notification",
      display: true,
      content: "done",
      details: {} as any,
    } as WorkflowTaskNotification;
    const launchWorkflow = vi.fn<LaunchWorkflowForTest>(async (_request, options) => {
      await options.notifyTerminal?.(notification);
      return ok({
        taskId: "task_1",
        runId: "wf_1",
        scriptPath: "/repo/.pi/workflows/wf_1/script.js",
        transcriptDir: "/repo/.pi/workflows/wf_1/transcripts",
        confirmation: "Started workflow wf_1",
        completion: Promise.resolve(ok({} as any)),
      });
    });
    const sendMessage =
      vi.fn<(notification: WorkflowTaskNotification, options?: unknown) => void>();

    await handleUltracodeInput(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      contextForTest({ cwd: "/repo" }),
      { sendMessage, launchDependencies: { launchWorkflow } },
    );

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "workflow-task-notification",
        content: expect.stringContaining("Original user request: ultracode audit repo"),
      }),
      {
        deliverAs: "followUp",
        triggerTurn: true,
      },
    );
  });
});

type LaunchWorkflowForTest = (
  request: WorkflowLaunchRequest,
  options: WorkflowLaunchOptions,
) => Promise<Result<WorkflowLaunch, WorkflowLaunchError>>;

function contextForTest(options: { cwd?: string; sessionId?: string } = {}) {
  return {
    cwd: options.cwd ?? "/tmp/project",
    sessionManager:
      options.sessionId === undefined ? undefined : { getSessionId: () => options.sessionId },
    ui: {
      notify: vi.fn<(...args: unknown[]) => void>(),
    },
  } as any;
}
