import { describe, expect, it } from "vitest";
import { formatDuration, formatIdle, formatTokens } from "#src/workflows/view/layout.ts";

describe("layout formatters", () => {
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
});
