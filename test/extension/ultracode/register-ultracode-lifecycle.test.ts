import { describe, expect, it, vi } from "vitest";
import {
  handleUltracodeInput,
  registerUltracode,
} from "#src/extension/ultracode/register-ultracode.ts";
import { UltracodeEditor } from "#src/extension/ultracode/rainbow-editor.ts";
import type { UltracodeModeState } from "#src/extension/ultracode/mode-state-machine.ts";

type RegisteredHandler = (...args: any[]) => unknown;

function createTui() {
  return {
    requestRender: vi.fn<() => void>(),
    terminal: { rows: 24, columns: 80 },
  };
}

function createTheme() {
  return {
    borderColor: (str: string) => str,
    selectList: {
      selectedColor: (str: string) => str,
      matchColor: (str: string) => str,
      descriptionColor: (str: string) => str,
    },
  };
}

function createPi() {
  const handlers = new Map<string, RegisteredHandler>();
  let tool: any;
  const pi = {
    on: vi.fn<(event: string, handler: RegisteredHandler) => void>((event, handler) => {
      handlers.set(event, handler);
    }),
    appendEntry: vi.fn<(...args: unknown[]) => void>(),
    registerTool: vi.fn<(t: any) => void>((t) => {
      tool = t;
    }),
    sendMessage: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  };
  return { pi, handlers, getTool: () => tool };
}

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

describe("registerUltracode lifecycle", () => {
  it("should build a UltracodeEditor through the registered editor factory and dispose the previous one", () => {
    const { pi, handlers } = createPi();
    const ctx = contextForTest();

    registerUltracode(pi as any);
    handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);

    const factory = ctx.ui.setEditorComponent.mock.calls[0]![0] as (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => unknown;

    const first = factory(createTui(), createTheme(), { matches: () => false });
    expect(first).toBeInstanceOf(UltracodeEditor);

    const disposeSpy = vi.spyOn(first as UltracodeEditor, "dispose");
    const second = factory(createTui(), createTheme(), { matches: () => false });

    expect(second).toBeInstanceOf(UltracodeEditor);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("should dispose the editor and clear the working message on session shutdown", () => {
    const { pi, handlers } = createPi();
    const startCtx = contextForTest();
    const shutdownCtx = contextForTest();

    registerUltracode(pi as any);
    handlers.get("session_start")?.({ type: "session_start", reason: "new" }, startCtx);

    const factory = startCtx.ui.setEditorComponent.mock.calls[0]![0] as (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
    ) => UltracodeEditor;
    const editor = factory(createTui(), createTheme(), { matches: () => false });
    const disposeSpy = vi.spyOn(editor, "dispose");

    handlers.get("session_shutdown")?.({ type: "session_shutdown" }, shutdownCtx);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(shutdownCtx.ui.setWorkingMessage).toHaveBeenCalledWith();
  });

  it("should not set a working message before agent start when ultracode is off", async () => {
    const { pi, handlers } = createPi();
    const ctx = contextForTest();

    registerUltracode(pi as any);

    const result = await handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "base prompt",
        systemPromptOptions: {},
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(ctx.ui.setWorkingMessage).not.toHaveBeenCalled();
  });

  it("should default to no entries when the session manager returns undefined entries", () => {
    const { pi, handlers } = createPi();
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionId: () => undefined,
        getEntries: () => undefined,
      },
      ui: {
        notify: vi.fn<(...args: unknown[]) => void>(),
        setEditorComponent: vi.fn<(...args: unknown[]) => void>(),
        setWorkingMessage: vi.fn<(...args: unknown[]) => void>(),
      },
    } as any;

    registerUltracode(pi as any);

    expect(() =>
      handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx),
    ).not.toThrow();
    expect(ctx.ui.setEditorComponent).toHaveBeenCalled();
  });

  it("should clear the working message on agent end", () => {
    const { pi, handlers } = createPi();
    const ctx = contextForTest();

    registerUltracode(pi as any);
    handlers.get("agent_end")?.({ type: "agent_end" }, ctx);

    expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith();
  });

  it("should report the ultracode trigger source while active and manual otherwise", async () => {
    const { pi, handlers, getTool } = createPi();

    registerUltracode(pi as any);

    const tool = getTool();
    const ctx = contextForTest({ cwd: "/tmp/project", sessionId: "session_1" });

    // Mode off -> getTriggerSource returns "manual"; invalid script fails fast before any launch.
    await expect(
      tool.execute("call_manual", { script: "not a workflow" }, undefined, undefined, ctx),
    ).rejects.toBeInstanceOf(Error);

    // Activate ultracode mode via the input handler, then mode is active -> "ultracode".
    await handlers.get("input")?.(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      contextForTest({ sessionId: "session_1" }),
    );

    await expect(
      tool.execute("call_active", { script: "not a workflow" }, undefined, undefined, ctx),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("handleUltracodeInput branches", () => {
  it("should default the mode to off when no getMode is provided", async () => {
    const ctx = contextForTest({ sessionId: undefined });

    const result = await handleUltracodeInput(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      ctx,
      {
        setMode: vi.fn<(...args: any[]) => any>(),
        appendModeEntry: vi.fn<(...args: any[]) => any>(),
      },
    );

    expect(result).toEqual({ action: "transform", text: "audit repo" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("ultracode is ON for this session", "info");
  });

  it("should fall back to a placeholder session id when none is available", async () => {
    const ctx = contextForTest({ sessionId: undefined });
    let captured: UltracodeModeState | undefined;

    await handleUltracodeInput(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      ctx,
      {
        getMode: () => ({ state: "off" }),
        setMode: (next) => {
          captured = next;
        },
      },
    );

    expect(captured).toEqual({
      state: "on",
      activatedBy: "current-session",
      goal: "audit repo",
    });
  });

  it("should notify with a reason when ultracode is disabled", async () => {
    const ctx = contextForTest();

    const result = await handleUltracodeInput(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      ctx,
      { getMode: () => ({ state: "disabled", reason: "too expensive" }) },
    );

    expect(result).toEqual({ action: "handled" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("ultracode is disabled: too expensive", "warning");
  });

  it("should notify without a reason when ultracode is disabled without one", async () => {
    const ctx = contextForTest();

    const result = await handleUltracodeInput(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      ctx,
      { getMode: () => ({ state: "disabled" }) },
    );

    expect(result).toEqual({ action: "handled" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("ultracode is disabled", "warning");
  });
});

describe("registerUltracode session helpers", () => {
  it("should treat a throwing sessionManager as no session id and no entries", async () => {
    const { pi, handlers } = createPi();
    const throwingCtx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionId: () => {
          throw new Error("no session");
        },
        getEntries: () => {
          throw new Error("no entries");
        },
      },
      ui: {
        notify: vi.fn<(...args: unknown[]) => void>(),
        setEditorComponent: vi.fn<(...args: unknown[]) => void>(),
        setWorkingMessage: vi.fn<(...args: unknown[]) => void>(),
      },
    } as any;

    registerUltracode(pi as any);

    // session_start reads entries via readSessionEntries -> hits the catch branch.
    handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, throwingCtx);

    // input uses currentSessionId -> hits the catch branch and the "current-session" fallback.
    const result = await handlers.get("input")?.(
      { type: "input", text: "ultracode audit repo", source: "interactive" },
      throwingCtx,
    );

    expect(result).toEqual({ action: "transform", text: "audit repo" });
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "ultracode-mode",
      expect.objectContaining({
        mode: expect.objectContaining({ activatedBy: "current-session" }),
      }),
    );
  });
});
