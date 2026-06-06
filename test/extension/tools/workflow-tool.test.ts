import { describe, expect, it, vi } from "vitest";
import {
  registerWorkflowTool,
  type RegisterWorkflowToolOptions,
  WORKFLOW_SCRIPT_MAX_LENGTH,
  WORKFLOW_TOOL_DESCRIPTION,
} from "#src/extension/tools/workflow-tool.ts";
import { ok } from "#src/workflows/result.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";

interface RegisteredTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: any;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: any,
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

    registerWorkflowTool(pi as any);

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
    expect(tool?.parameters.required).toBeUndefined();
    expect(tool?.parameters.properties.args.type).toBeUndefined();
    expect(tool?.description).toContain("phases must be an array of objects");
    expect(tool?.description).toContain('never strings such as ["Generate"]');
    expect(tool?.description).toContain("opts.schema");
    expect(tool?.description).toContain("plain JSON object schema");
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

    registerWorkflowTool(pi as any);

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

    registerWorkflowTool(pi as any);

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

    registerWorkflowTool(pi as any, {
      getTriggerSource: () => "ultracode",
      launchWorkflow,
      operations: "operations" as any,
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
        model: { provider: "anthropic", id: "claude-sonnet-4-6" } as any,
        modelRegistry: "registry" as any,
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
});
