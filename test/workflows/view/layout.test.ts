import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatDuration,
  formatIdle,
  formatTokens,
  headerSummaryLine,
  padTo,
  paneInnerWidths,
  titleSegment,
  truncateEllipsis,
  twoPaneBox,
  wordWrap,
} from "#src/workflows/view/layout.ts";

describe("layout helpers", () => {
  it("should right-align the summary within the width", () => {
    const line = headerSummaryLine("repo-audit", "1/8 agents · 1m 12s", 50);

    expect(visibleWidth(line)).toBe(50);
    expect(line.startsWith("repo-audit")).toBe(true);
    expect(line.endsWith("1/8 agents · 1m 12s")).toBe(true);
  });

  it("should truncate the left side with an ellipsis when summary does not fit", () => {
    const line = headerSummaryLine("x".repeat(80), "1/8 · 1m 12s", 40);

    expect(visibleWidth(line)).toBe(40);
    expect(line).toContain("…");
    expect(line.endsWith("1/8 · 1m 12s")).toBe(true);
  });

  it("should pad text to an exact visible width", () => {
    expect(visibleWidth(padTo("abc", 10))).toBe(10);
    expect(padTo("abc", 10).startsWith("abc")).toBe(true);
  });

  it("should truncate with an ellipsis only when text exceeds the width", () => {
    expect(truncateEllipsis("hello", 10)).toBe("hello");
    expect(truncateEllipsis("hello world", 8)).toContain("…");
    expect(visibleWidth(truncateEllipsis("hello world", 8))).toBe(8);
  });

  it("should build a two-pane box where every line equals the width", () => {
    const lines = twoPaneBox({
      leftTitle: "Phases",
      rightTitle: "Slice · 7 agents",
      leftLines: ["› 1 Slice 0/7"],
      rightLines: ["● slice:P0.1 41.1k tok · 11 tools"],
      leftWidth: 23,
      width: 42,
    });

    expect(lines.every((line) => visibleWidth(line) === 42)).toBe(true);
    expect(lines[0]).toContain("┌ Phases");
    expect(lines[0]).toContain("┬");
    expect(lines.at(-1)).toContain("└");
    expect(lines.at(-1)).toContain("┴");
  });

  it("should never let pane content cross the divider border", () => {
    const lines = twoPaneBox({
      leftTitle: "L",
      rightTitle: "R",
      leftLines: ["x".repeat(80)],
      rightLines: ["y".repeat(80)],
      leftWidth: 10,
      width: 42,
    });

    const body = lines.slice(1, -1);
    expect(body.every((line) => visibleWidth(line) === 42)).toBe(true);
    expect(body.every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
  });

  it("should format tokens compactly as k", () => {
    expect(formatTokens(41_100)).toBe("41.1k");
    expect(formatTokens(900)).toBe("900");
    expect(formatTokens(266_100)).toBe("266.1k");
  });

  it("should format idle duration as a minute second label", () => {
    expect(formatIdle(72_000)).toBe("1m 12s");
    expect(formatIdle(42_000)).toBe("42s");
  });

  it("should format duration with a space between minutes and seconds", () => {
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(42_000)).toBe("42s");
  });

  it("should compute pane inner widths that sum with borders to the total width", () => {
    const { leftWidth, rightWidth } = paneInnerWidths(42, 16);

    expect(leftWidth).toBe(16);
    expect(rightWidth).toBe(42 - 16 - 7);
    expect(rightWidth).toBeGreaterThanOrEqual(1);
  });

  it("should keep the summary within the width even when the right side is too long", () => {
    const line = headerSummaryLine("Workflow", "5/8 agents · 2m 3s", 10);

    expect(visibleWidth(line)).toBeLessThanOrEqual(10);
  });

  it("should wrap a long unbroken line without losing any characters", () => {
    const wrapped = wordWrap("a".repeat(20), 7);

    expect(wrapped.join("")).toBe("a".repeat(20));
    expect(wrapped.every((line) => visibleWidth(line) <= 7)).toBe(true);
    expect(wrapped.length).toBe(3);
  });

  it("should preserve newlines and blank lines when wrapping", () => {
    const wrapped = wordWrap("one\n\ntwo words here", 8);

    expect(wrapped.join("\n")).toContain("one");
    expect(wrapped).toContain("");
    expect(wrapped.join("").replace(/\s/g, "")).toContain("twowordshere");
  });

  it("should emit a single wide grapheme that cannot fit within the width", () => {
    const wrapped = wordWrap("漢字", 1);

    expect(wrapped).toEqual(["漢", "字"]);
    expect(wrapped.join("")).toBe("漢字");
  });

  it("should fill a fitting title segment using the default identity style", () => {
    const segment = titleSegment("Phases", 12);

    expect(segment).toBe(" Phases ────");
    expect(visibleWidth(segment)).toBe(12);
  });

  it("should format an exact thousands token count without a fractional part", () => {
    expect(formatTokens(2000)).toBe("2k");
    expect(formatTokens(20_000)).toBe("20k");
  });
});
