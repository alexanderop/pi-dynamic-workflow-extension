import { describe, expect, it, vi } from "vitest";
import {
  BUNDLED_ULTRACODE_WORKFLOW_SCRIPT,
  launchUltracodeWorkflow,
  withUltracodeContinuationPrompt,
} from "#src/extension/ultracode/launch-ultracode-workflow.ts";
import { ok } from "#src/workflows/result.ts";
import * as launcher from "#src/workflows/launch/launcher.ts";

vi.mock("#src/workflows/launch/launcher.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/launch/launcher.ts")>();
  return { ...actual, launchWorkflow: vi.fn<(...args: any[]) => any>() };
});

const mockedLaunchWorkflow = vi.mocked(launcher.launchWorkflow);

function launchResult() {
  return ok({
    taskId: "task_1",
    runId: "run_1",
    scriptPath: "/tmp/run/script.ts",
    transcriptDir: "/tmp/run/transcript",
    confirmation: "launched",
    completion: Promise.resolve(undefined as never),
  });
}

describe("BUNDLED_ULTRACODE_WORKFLOW_SCRIPT", () => {
  it("should describe an ultracode workflow with explore and synthesize phases", () => {
    expect(BUNDLED_ULTRACODE_WORKFLOW_SCRIPT).toContain('name: "ultracode"');
    expect(BUNDLED_ULTRACODE_WORKFLOW_SCRIPT).toContain('phase("Explore")');
    expect(BUNDLED_ULTRACODE_WORKFLOW_SCRIPT).toContain('phase("Synthesize")');
  });
});

describe("withUltracodeContinuationPrompt", () => {
  it("should wrap the notification content with continuation guidance", () => {
    const wrapped = withUltracodeContinuationPrompt(
      { content: "the workflow result", title: "done" } as any,
      "audit repo",
    );

    expect(wrapped.content).toContain("background ultracode dynamic workflow completed");
    expect(wrapped.content).toContain("Original user request: ultracode audit repo");
    expect(wrapped.content).toContain("the workflow result");
    expect((wrapped as any).title).toBe("done");
  });
});

describe("launchUltracodeWorkflow", () => {
  it("should use an injected launchWorkflow dependency with the bundled script and goal args", async () => {
    const injected = vi.fn<typeof launcher.launchWorkflow>(async () => launchResult());

    const result = await launchUltracodeWorkflow(
      "audit repo",
      { cwd: "/repo" },
      { launchWorkflow: injected },
    );

    expect(result.status).toBe("ok");
    expect(injected).toHaveBeenCalledTimes(1);
    const [request, options] = injected.mock.calls[0]!;
    expect(request).toEqual({
      script: BUNDLED_ULTRACODE_WORKFLOW_SCRIPT,
      args: { goal: "audit repo" },
      description: "audit repo",
    });
    expect(options.triggerSource).toBe("ultracode");
    expect(options.cwd).toBe("/repo");
    expect(options.notifyTerminal).toBeUndefined();
  });

  it("should leave notifyTerminal undefined when no sendMessage is provided", async () => {
    const injected = vi.fn<typeof launcher.launchWorkflow>(async () => launchResult());

    await launchUltracodeWorkflow("explore", { cwd: "/repo" }, { launchWorkflow: injected });

    expect(injected.mock.calls[0]![1].notifyTerminal).toBeUndefined();
  });

  it("should wire notifyTerminal to sendMessage with a continuation prompt", async () => {
    const injected = vi.fn<typeof launcher.launchWorkflow>(async () => launchResult());
    const sendMessage = vi.fn<(...args: unknown[]) => void>();

    await launchUltracodeWorkflow(
      "audit repo",
      { cwd: "/repo", sendMessage },
      { launchWorkflow: injected },
    );

    const notifyTerminal = injected.mock.calls[0]![1].notifyTerminal;
    expect(notifyTerminal).toBeInstanceOf(Function);

    await notifyTerminal!({ content: "result body" } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [notification, deliveryOptions] = sendMessage.mock.calls[0]!;
    expect((notification as any).content).toContain("result body");
    expect((notification as any).content).toContain("Original user request: ultracode audit repo");
    expect(deliveryOptions).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("should fall back to the real launchWorkflow when no dependency is injected", async () => {
    mockedLaunchWorkflow.mockResolvedValueOnce(launchResult());

    const result = await launchUltracodeWorkflow("default goal", { cwd: "/repo" });

    expect(result.status).toBe("ok");
    expect(mockedLaunchWorkflow).toHaveBeenCalledTimes(1);
  });
});
