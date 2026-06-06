import { describe, expect, it, vi } from "vitest";
import {
  handleUltracodeBeforeAgentStart,
  handleUltracodeInput,
  handleUltracodeToolCall,
  registerUltracode,
} from "#src/extension/ultracode/register-ultracode.ts";
import { createUltracodeModeEntryData } from "#src/extension/ultracode/session-mode-store.ts";
import type { UltracodeModeState } from "#src/extension/ultracode/mode-state-machine.ts";

describe("registerUltracode", () => {
  it("should register the Workflow tool plus session editor lifecycle, input, and before-agent handlers", () => {
    const pi = {
      on: vi.fn<(...args: unknown[]) => void>(),
      appendEntry: vi.fn<(...args: unknown[]) => void>(),
      registerTool: vi.fn<(...args: unknown[]) => void>(),
    };

    registerUltracode(pi as any);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "Workflow" }));
  });

  it("should block a Workflow tool call when ultracode is not active for the session", async () => {
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn<(event: string, handler: RegisteredHandler) => void>((event, handler) => {
        handlers.set(event, handler);
      }),
      appendEntry: vi.fn<(...args: unknown[]) => void>(),
      registerTool: vi.fn<(...args: unknown[]) => void>(),
    };

    registerUltracode(pi as any);

    const result = await handlers.get("tool_call")?.({
      type: "tool_call",
      toolCallId: "call_1",
      toolName: "Workflow",
      input: {},
    });

    expect(result).toEqual({ block: true, reason: expect.stringContaining("ultracode") });
  });

  it("should allow a Workflow tool call once ultracode is active for the session", async () => {
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn<(event: string, handler: RegisteredHandler) => void>((event, handler) => {
        handlers.set(event, handler);
      }),
      appendEntry: vi.fn<(...args: unknown[]) => void>(),
      registerTool: vi.fn<(...args: unknown[]) => void>(),
    };
    const ctx = contextForTest({ sessionId: "session_current" });

    registerUltracode(pi as any);
    await handlers.get("input")?.(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      ctx,
    );

    const result = await handlers.get("tool_call")?.({
      type: "tool_call",
      toolCallId: "call_1",
      toolName: "Workflow",
      input: {},
    });

    expect(result).toBeUndefined();
  });
});

describe("handleUltracodeToolCall", () => {
  it("should block the Workflow tool when mode is off", () => {
    const result = handleUltracodeToolCall(workflowToolCallEvent(), { state: "off" });

    expect(result).toEqual({ block: true, reason: expect.stringContaining("ultracode") });
  });

  it("should allow the Workflow tool when mode is on", () => {
    expect(
      handleUltracodeToolCall(workflowToolCallEvent(), {
        state: "on",
        activatedBy: "session_1",
        goal: "audit repo",
      }),
    ).toBeUndefined();
  });

  it("should ignore non-Workflow tool calls regardless of mode", () => {
    expect(
      handleUltracodeToolCall(
        { type: "tool_call", toolCallId: "call_1", toolName: "bash", input: {} },
        { state: "off" },
      ),
    ).toBeUndefined();
  });

  it("should restore mode from session entries and inject policy on later turns", async () => {
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn<(event: string, handler: RegisteredHandler) => void>((event, handler) => {
        handlers.set(event, handler);
      }),
      appendEntry: vi.fn<(...args: unknown[]) => void>(),
      registerTool: vi.fn<(...args: unknown[]) => void>(),
    };

    registerUltracode(pi as any);

    handlers.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      contextForTest({
        entries: [
          {
            type: "custom",
            customType: "ultracode-mode",
            data: createUltracodeModeEntryData({
              state: "on",
              activatedBy: "session_1",
              goal: "audit repo",
            }),
          },
        ],
      }),
    );

    const ctx = contextForTest();
    const result = await handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "audit auth",
        systemPrompt: "base prompt",
        systemPromptOptions: {},
      },
      ctx,
    );

    expect(result).toEqual({
      message: expect.objectContaining({
        customType: "ultracode-policy",
        content: expect.stringContaining("ultracode is ON"),
        display: false,
      }),
      systemPrompt: expect.stringContaining("Task: Launch a Workflow"),
    });
    expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith("Authoring and launching a Workflow…");
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

  it("should transform a valid trigger, persist mode, and not launch a workflow", async () => {
    let mode: UltracodeModeState = { state: "off" };
    const appendModeEntry = vi.fn<(mode: UltracodeModeState) => void>();
    const launchWorkflow = vi.fn<() => void>();
    const ctx = contextForTest({ cwd: "/repo", sessionId: "session_current" });

    const result = await handleUltracodeInput(
      { type: "input", text: "Ultracode audit repo", source: "interactive" },
      ctx,
      {
        getMode: () => mode,
        setMode: (next) => {
          mode = next;
        },
        appendModeEntry,
      },
    );

    expect(result).toEqual({ action: "transform", text: "audit repo" });
    expect(mode).toEqual({
      state: "on",
      activatedBy: "session_current",
      goal: "audit repo",
    });
    expect(appendModeEntry).toHaveBeenCalledWith(mode);
    expect(launchWorkflow).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("ultracode is ON for this session", "info");
  });

  it("should append a mode entry when wired through the registered input handler", async () => {
    const handlers = new Map<string, RegisteredHandler>();
    const pi = {
      on: vi.fn<(event: string, handler: RegisteredHandler) => void>((event, handler) => {
        handlers.set(event, handler);
      }),
      appendEntry: vi.fn<(...args: unknown[]) => void>(),
      registerTool: vi.fn<(...args: unknown[]) => void>(),
    };
    const ctx = contextForTest({ sessionId: "session_current" });

    registerUltracode(pi as any);

    const result = await handlers.get("input")?.(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      ctx,
    );

    expect(result).toEqual({ action: "transform", text: "audit repo" });
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "ultracode-mode",
      createUltracodeModeEntryData({
        state: "on",
        activatedBy: "session_current",
        goal: "audit repo",
      }),
    );
  });
});

describe("handleUltracodeBeforeAgentStart", () => {
  it("should inject policy when mode is on", () => {
    const result = handleUltracodeBeforeAgentStart(beforeAgentEvent(), {
      state: "on",
      activatedBy: "session_1",
      goal: "audit repo",
    });

    expect(result?.message).toEqual(
      expect.objectContaining({
        customType: "ultracode-policy",
        content: expect.stringContaining("Adversarially verify"),
        display: false,
      }),
    );
    expect(result?.systemPrompt).toContain("base prompt");
    expect(result?.systemPrompt).toContain("Token cost is not a constraint");
    expect(result?.systemPrompt).toContain("Task: Launch a Workflow");
    expect(result?.systemPrompt).toContain('phases: [{ title: "Generate jokes" }');
    expect(result?.systemPrompt).toContain(
      'NEVER use string phases like `phases: ["Generate jokes"]`',
    );
    expect(result?.systemPrompt).toContain("call the `Workflow` tool");
  });

  it("should do nothing when mode is off", () => {
    expect(handleUltracodeBeforeAgentStart(beforeAgentEvent(), { state: "off" })).toBeUndefined();
  });
});

type RegisteredHandler = (...args: any[]) => unknown;

function contextForTest(
  options: { cwd?: string; sessionId?: string; entries?: readonly unknown[] } = {},
) {
  return {
    cwd: options.cwd ?? "/tmp/project",
    sessionManager: {
      getSessionId: () => options.sessionId,
      getEntries: () => options.entries ?? [],
    },
    ui: {
      notify: vi.fn<(...args: unknown[]) => void>(),
      setEditorComponent: vi.fn<(...args: unknown[]) => void>(),
      setWorkingMessage: vi.fn<(...args: unknown[]) => void>(),
    },
  } as any;
}

function workflowToolCallEvent() {
  return {
    type: "tool_call",
    toolCallId: "call_1",
    toolName: "Workflow",
    input: {},
  } as any;
}

function beforeAgentEvent() {
  return {
    type: "before_agent_start",
    prompt: "audit auth",
    systemPrompt: "base prompt",
    systemPromptOptions: {},
  } as any;
}
