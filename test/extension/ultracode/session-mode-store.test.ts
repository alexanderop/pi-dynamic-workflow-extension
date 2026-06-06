import { describe, expect, it } from "vitest";
import {
  createUltracodeModeEntryData,
  restoreUltracodeModeFromEntries,
} from "#src/extension/ultracode/session-mode-store.ts";

describe("restoreUltracodeModeFromEntries", () => {
  it("should restore the latest valid ultracode custom entry", () => {
    const restored = restoreUltracodeModeFromEntries([
      {
        type: "custom",
        customType: "ultracode-mode",
        data: createUltracodeModeEntryData({
          state: "on",
          activatedBy: "session_1",
          goal: "audit repo",
        }),
      },
      {
        type: "custom",
        customType: "other",
        data: { enabled: false },
      },
      {
        type: "custom",
        customType: "ultracode-mode",
        data: createUltracodeModeEntryData({ state: "off" }),
      },
    ]);

    expect(restored).toEqual({ state: "off" });
  });

  it("should ignore malformed entries", () => {
    expect(
      restoreUltracodeModeFromEntries([
        {
          type: "custom",
          customType: "ultracode-mode",
          data: { version: 1, mode: { state: "on", goal: "missing activatedBy" } },
        },
      ]),
    ).toEqual({ state: "off" });
  });
});
