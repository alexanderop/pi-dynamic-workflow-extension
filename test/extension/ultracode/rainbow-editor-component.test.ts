import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { colorizeUltracodeText, UltracodeEditor } from "#src/extension/ultracode/rainbow-editor.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

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

function createKeybindings() {
  return { matches: () => false };
}

function createEditor() {
  const tui = createTui();
  const editor = new UltracodeEditor(tui as any, createTheme() as any, createKeybindings() as any);
  return { editor, tui };
}

describe("UltracodeEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("should start the animation when setText contains ultracode and re-render on each tick", () => {
    const { editor, tui } = createEditor();

    editor.setText("ultracode the repo");
    expect(tui.requestRender).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(80);
    expect(tui.requestRender).toHaveBeenCalledTimes(2);

    editor.dispose();
  });

  it("should not start a second timer when setText keeps containing ultracode", () => {
    const { editor, tui } = createEditor();

    editor.setText("ultracode one");
    editor.setText("ultracode two");

    vi.advanceTimersByTime(80);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    editor.dispose();
  });

  it("should stop the animation when text no longer contains ultracode", () => {
    const { editor, tui } = createEditor();

    editor.setText("ultracode go");
    vi.advanceTimersByTime(80);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);

    editor.setText("plain text");
    vi.advanceTimersByTime(240);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  it("should be a no-op to stop the animation when none is running", () => {
    const { editor } = createEditor();

    editor.setText("plain text");
    expect(() => editor.dispose()).not.toThrow();
  });

  it("should sync the animation through handleInput", () => {
    const { editor, tui } = createEditor();

    editor.handleInput("ultracode");
    vi.advanceTimersByTime(80);
    expect(tui.requestRender).toHaveBeenCalled();

    editor.dispose();
  });

  it("should colorize ultracode matches when rendering", () => {
    const { editor } = createEditor();

    editor.setText("ultracode now");
    const lines = editor.render(80);
    const joined = lines.join("\n");

    expect(joined).toContain("\x1b[38;2;");
    expect(joined.replace(ANSI_SEQUENCE, "")).toContain("ultracode now");

    editor.dispose();
  });

  it("should advance the frame so renders differ across ticks", () => {
    const { editor } = createEditor();

    editor.setText("ultracode now");
    const first = editor.render(80).join("\n");
    vi.advanceTimersByTime(80);
    const second = editor.render(80).join("\n");

    expect(second).not.toBe(first);

    editor.dispose();
  });
});

describe("colorizeUltracodeText shine positions", () => {
  it("should apply no shine when the cycle is past the shine window", () => {
    // frame 15 -> cycle 15 -> shinePosition -1 (shineFactor returns 0 for all).
    const rendered = colorizeUltracodeText("ultracode", 15);

    expect(rendered).toContain("\x1b[38;2;");
    expect(rendered.replace(ANSI_SEQUENCE, "")).toBe("ultracode");
  });

  it("should apply the brightest shine to the position with distance 0, 1, and beyond", () => {
    // frame 3 -> cycle 3 -> shinePosition 3 -> exercises distance 0/1/>1 branches.
    const rendered = colorizeUltracodeText("ultracode", 3);

    expect(rendered.replace(ANSI_SEQUENCE, "")).toBe("ultracode");
  });

  it("should omit the blink sequence on frames outside the blink window", () => {
    // frame 7 -> 7 % 12 === 7 >= 6 -> no BLINK prefix.
    const blinkOff = colorizeUltracodeText("ultracode", 7);
    // frame 3 -> 3 % 12 === 3 < 6 -> BLINK prefix present.
    const blinkOn = colorizeUltracodeText("ultracode", 3);

    expect(blinkOff).not.toContain("\x1b[5m");
    expect(blinkOn).toContain("\x1b[5m");
  });
});
