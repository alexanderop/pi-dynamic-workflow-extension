import { describe, expect, it, vi } from "vitest";
import {
  registerWorkflowTool,
  type RegisterWorkflowToolOptions,
  WORKFLOW_SCRIPT_MAX_LENGTH,
  WORKFLOW_TOOL_DESCRIPTION,
} from "#src/extension/tools/workflow-tool.ts";
import { ok } from "#src/workflows/result.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowTaskNotification } from "#src/workflows/launch/launcher.ts";
import { fakePi } from "../../support.ts";

interface RegisteredTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  renderCall(
    args: unknown,
    theme: RenderTheme,
    context?: unknown,
  ): { render(width: number): string[] };
  renderResult(
    result: unknown,
    options: unknown,
    theme: RenderTheme,
    context?: unknown,
  ): { render(width: number): string[] };
}

interface RenderTheme {
  fg(_name: string, text: string): string;
  bold(text: string): string;
}

describe("Workflow tool", () => {
  it("should register the Claude-like Workflow tool schema and description", () => {
    let tool: RegisteredTool | undefined;
    const pi = {
      registerTool: vi.fn<(registered: RegisteredTool) => void>((registered) => {
        tool = registered;
      }),
      sendMessage: vi.fn<(...args: unknown[]) => void>(),
    };

    registerWorkflowTool(fakePi(pi));

    expect(tool).toEqual(
      expect.objectContaining({
        name: "Workflow",
        label: "Workflow",
        description: WORKFLOW_TOOL_DESCRIPTION,
      }),
    );
    expect(tool?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        script: { type: "string", maxLength: WORKFLOW_SCRIPT_MAX_LENGTH },
        scriptPath: { type: "string" },
        name: { type: "string" },
        resumeFromRunId: { type: "string", pattern: "^wf_[a-z0-9-]{6,}$" },
        title: { type: "string" },
        description: { type: "string" },
      },
    });
    const parameters = tool?.parameters as
      | {
          readonly required?: unknown;
          readonly properties: { readonly args: { readonly type?: unknown } };
        }
      | undefined;
    expect(parameters?.required).toBeUndefined();
    expect(parameters?.properties.args.type).toBeUndefined();
    expect(tool?.description).toContain("phases must be an array of objects");
    expect(tool?.description).toContain('never strings such as ["Generate"]');
    expect(tool?.description).toContain("opts.schema");
    expect(tool?.description).toContain("plain JSON object schema");
    expect(tool?.description).toContain("model and thinking hints");
    expect(tool?.description).toContain("cheap fan-out");
    expect(tool?.description).toContain("heavy synthesis");
    expect(tool?.description).toContain("fall back to the current Pi model");
    expect(tool?.description).toContain("at most 4096 items");
    expect(tool?.description).not.toContain("nested workflow");
    expect(tool?.description).not.toContain("Do not pass schema yet");
  });

  it("should render the Workflow call and launch result without execution logic", () => {
    let tool: RegisteredTool | undefined;
    const pi = {
      registerTool: vi.fn<(registered: RegisteredTool) => void>((registered) => {
        tool = registered;
      }),
      sendMessage: vi.fn<(...args: unknown[]) => void>(),
    };
    const theme: RenderTheme = {
      fg: (_name, text) => text,
      bold: (text) => text,
    };

    registerWorkflowTool(fakePi(pi));

    expect(
      tool?.renderCall({ scriptPath: "/repo/workflow.js" }, theme).render(120).join("\n"),
    ).toContain("Workflow scriptPath /repo/workflow.js · ready to launch");
    const launchRender = tool
      ?.renderResult(
        {
          content: [{ type: "text", text: "Workflow launched" }],
          details: { runId: "wf_test", scriptPath: "/repo/.pi/workflows/wf_test/script.js" },
        },
        {},
        theme,
      )
      .render(120)
      .join("\n");
    expect(launchRender).toContain("launched wf_test");
    expect(launchRender).toContain("script: /repo/.pi/workflows/wf_test/script.js");
  });

  it("should render inline authoring, parsed metadata, and validation errors", () => {
    let tool: RegisteredTool | undefined;
    const pi = {
      registerTool: vi.fn<(registered: RegisteredTool) => void>((registered) => {
        tool = registered;
      }),
      sendMessage: vi.fn<(...args: unknown[]) => void>(),
    };
    const theme: RenderTheme = {
      fg: (_name, text) => text,
      bold: (text) => text,
    };

    registerWorkflowTool(fakePi(pi));

    const validScript = [
      "export const meta = { name: 'audit', description: 'Audit the code', phases: [{ title: 'Inspect' }, { title: 'Verify' }] }",
      "phase('Inspect')",
      "return 'ok'",
    ].join("\n");
    const authoringRender = tool
      ?.renderCall({ script: validScript }, theme, {
        argsComplete: false,
        executionStarted: false,
      })
      .render(120)
      .join("\n");
    expect(authoringRender).toContain("authoring…");
    expect(authoringRender).toContain("drafting inline script");
    expect(
      tool
        ?.renderCall({ script: validScript }, theme, {
          argsComplete: true,
          executionStarted: false,
        })
        .render(120)
        .join("\n"),
    ).toContain("audit ·");
    expect(
      tool
        ?.renderCall(
          {
            script:
              "export const meta = { name: 'bad', description: 'Bad', phases: ['Inspect'] }\nreturn 'ok'",
          },
          theme,
          { argsComplete: true, executionStarted: false },
        )
        .render(120)
        .join("\n"),
    ).toContain("invalid before launch: Workflow meta.phases[0] must be an object.");
  });

  it("should launch through launchWorkflow and ignore cosmetic title/description params", async () => {
    let tool: RegisteredTool | undefined;
    const launchWorkflow = vi.fn<NonNullable<RegisterWorkflowToolOptions["launchWorkflow"]>>(
      async () =>
        ok({
          taskId: "task_test",
          runId: "wf_test",
          scriptPath: "/repo/.pi/workflows/wf_test/script.js",
          transcriptDir: "/repo/.pi/workflows/wf_test/transcripts",
          confirmation: "Workflow launched in background. Task ID: task_test",
          completion: Promise.resolve(ok({ runId: "wf_test" } as WorkflowRunState)),
        }),
    );
    const sendMessage = vi.fn<(...args: unknown[]) => void>();
    const pi = {
      registerTool: vi.fn<(registered: RegisteredTool) => void>((registered) => {
        tool = registered;
      }),
      sendMessage,
    };

    registerWorkflowTool(fakePi(pi), {
      getTriggerSource: () => "ultracode",
      launchWorkflow,
      operations: "operations" as unknown as NonNullable<RegisterWorkflowToolOptions["operations"]>,
    });

    const onUpdate = vi.fn<(update: unknown) => void>();
    const result = await tool?.execute(
      "tool_call_1",
      {
        script: "export const meta = { name: 'demo', description: 'Demo' }\nreturn 'ok'",
        args: { target: "src" },
        title: "ignored title",
        description: "ignored description",
      },
      undefined,
      onUpdate,
      {
        cwd: "/repo/subdir",
        sessionManager: { getSessionId: () => "session_test" },
        model: { provider: "anthropic", id: "claude-sonnet-4-6" },
        modelRegistry: "registry",
      },
    );

    expect(launchWorkflow).toHaveBeenCalledWith(
      {
        script: "export const meta = { name: 'demo', description: 'Demo' }\nreturn 'ok'",
        scriptPath: undefined,
        name: undefined,
        resumeFromRunId: undefined,
        args: { target: "src" },
      },
      expect.objectContaining({
        rootDir: "/repo/subdir/.pi/workflows",
        sessionId: "session_test",
        triggerSource: "ultracode",
        cwd: "/repo/subdir",
        notifyTerminal: expect.any(Function),
        schedulerRunner: expect.any(Function),
        defaultModel: "anthropic/claude-sonnet-4-6",
        operations: "operations",
      }),
    );
    expect(onUpdate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: [
          expect.objectContaining({
            text: "Validating inline script and preparing background run storage…",
          }),
        ],
        details: { stage: "validating" },
      }),
    );
    expect(onUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: [
          expect.objectContaining({
            text: "Workflow wf_test launched; writing confirmation and running in background…",
          }),
        ],
        details: expect.objectContaining({ stage: "launching", runId: "wf_test" }),
      }),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Workflow launched in background. Task ID: task_test" }],
      details: {
        taskId: "task_test",
        runId: "wf_test",
        scriptPath: "/repo/.pi/workflows/wf_test/script.js",
        transcriptDir: "/repo/.pi/workflows/wf_test/transcripts",
      },
    });
  });

  it("should not trigger a main-agent turn when a workflow was stopped by the user", async () => {
    let tool: RegisteredTool | undefined;
    const launchWorkflow = vi.fn<NonNullable<RegisterWorkflowToolOptions["launchWorkflow"]>>(
      async () =>
        ok({
          taskId: "task_test",
          runId: "wf_test",
          scriptPath: "/repo/.pi/workflows/wf_test/script.js",
          transcriptDir: "/repo/.pi/workflows/wf_test/transcripts",
          confirmation: "Workflow launched in background. Task ID: task_test",
          completion: Promise.resolve(ok({ runId: "wf_test" } as WorkflowRunState)),
        }),
    );
    const sendMessage = vi.fn<(...args: unknown[]) => void>();

    registerWorkflowTool(
      fakePi({
        registerTool: vi.fn<(registered: RegisteredTool) => void>((registered) => {
          tool = registered;
        }),
        sendMessage,
      }),
      { launchWorkflow },
    );

    await tool?.execute(
      "tool_call_1",
      { script: "export const meta = { name: 'demo', description: 'Demo' }\nreturn 'ok'" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );

    const launchOptions = launchWorkflow.mock.calls[0]?.[1];
    await launchOptions?.notifyTerminal?.(notificationForTest("stopped"));

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Do not rerun, resume, or replace it yourself"),
      }),
      { deliverAs: "followUp", triggerTurn: false },
    );
  });

  it("should trigger a main-agent turn for completed workflow notifications", async () => {
    let tool: RegisteredTool | undefined;
    const launchWorkflow = vi.fn<NonNullable<RegisterWorkflowToolOptions["launchWorkflow"]>>(
      async () =>
        ok({
          taskId: "task_test",
          runId: "wf_test",
          scriptPath: "/repo/.pi/workflows/wf_test/script.js",
          transcriptDir: "/repo/.pi/workflows/wf_test/transcripts",
          confirmation: "Workflow launched in background. Task ID: task_test",
          completion: Promise.resolve(ok({ runId: "wf_test" } as WorkflowRunState)),
        }),
    );
    const sendMessage = vi.fn<(...args: unknown[]) => void>();

    registerWorkflowTool(
      fakePi({
        registerTool: vi.fn<(registered: RegisteredTool) => void>((registered) => {
          tool = registered;
        }),
        sendMessage,
      }),
      { launchWorkflow },
    );

    await tool?.execute(
      "tool_call_1",
      { script: "export const meta = { name: 'demo', description: 'Demo' }\nreturn 'ok'" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );

    const launchOptions = launchWorkflow.mock.calls[0]?.[1];
    await launchOptions?.notifyTerminal?.(notificationForTest("completed"));

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "<task-notification />" }),
      { deliverAs: "followUp", triggerTurn: true },
    );
  });

  it("should pass available Pi models and current thinking into workflow launch options", async () => {
    let tool: RegisteredTool | undefined;
    const launchWorkflow = vi.fn<NonNullable<RegisterWorkflowToolOptions["launchWorkflow"]>>(
      async () =>
        ok({
          taskId: "task_test",
          runId: "wf_test",
          scriptPath: "/repo/.pi/workflows/wf_test/script.js",
          transcriptDir: "/repo/.pi/workflows/wf_test/transcripts",
          confirmation: "Workflow launched in background. Task ID: task_test",
          completion: Promise.resolve(ok({ runId: "wf_test" } as WorkflowRunState)),
        }),
    );
    const availableModels = [
      { provider: "openai-codex", id: "gpt-5.4-mini" },
      { provider: "openai-codex", id: "gpt-5.5" },
    ];
    const pi = {
      registerTool: vi.fn<(registered: RegisteredTool) => void>((registered) => {
        tool = registered;
      }),
      sendMessage: vi.fn<(...args: unknown[]) => void>(),
      getThinkingLevel: vi.fn<() => string>(() => "high"),
    };

    registerWorkflowTool(fakePi(pi), {
      launchWorkflow,
    });

    await tool?.execute(
      "tool_call_1",
      { script: "export const meta = { name: 'demo', description: 'Demo' }\nreturn 'ok'" },
      undefined,
      undefined,
      {
        cwd: "/repo",
        model: { provider: "openai-codex", id: "gpt-5.5" },
        modelRegistry: {
          getAvailable: () => availableModels,
        },
      },
    );

    expect(launchWorkflow).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        defaultModel: "openai-codex/gpt-5.5",
        defaultThinkingLevel: "high",
        availableModels,
      }),
    );
  });
});

function notificationForTest(
  status: WorkflowTaskNotification["details"]["status"],
): WorkflowTaskNotification {
  return {
    customType: "workflow-task-notification",
    display: true,
    content: "<task-notification />",
    details: {
      taskId: "task_test",
      runId: "wf_test",
      outputFile: "/repo/.pi/workflows/wf_test/output.json",
      status,
      summary: `Dynamic workflow ${status}`,
      result: "",
      usage: {
        agentCount: 0,
        subagentTokens: 0,
        toolUses: 0,
        durationMs: 0,
      },
    },
  };
}
