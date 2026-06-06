import { describe, expect, it } from "vitest";
import {
  colorizeUltracodeText,
  containsUltracode,
} from "#src/extension/ultracode/rainbow-editor.ts";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("containsUltracode", () => {
  it("should detect ultracode case-insensitively", () => {
    expect(containsUltracode("run Ultracode now")).toBe(true);
    expect(containsUltracode("run normally")).toBe(false);
  });
});

describe("colorizeUltracodeText", () => {
  it("should colorize case-insensitive ultracode matches without changing visible text", () => {
    const rendered = colorizeUltracodeText("try Ultracode and ultracode", 3);

    expect(rendered).toContain("\x1b[38;2;");
    expect(rendered.replace(ANSI_SEQUENCE, "")).toBe("try Ultracode and ultracode");
  });

  it("should leave non-matching text unchanged", () => {
    expect(colorizeUltracodeText("run normally", 3)).toBe("run normally");
  });
});
