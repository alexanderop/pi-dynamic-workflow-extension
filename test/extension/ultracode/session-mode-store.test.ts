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

  it("should default to off when entries is undefined", () => {
    expect(restoreUltracodeModeFromEntries(undefined)).toEqual({ state: "off" });
  });

  it("should ignore entries that are not ultracode-mode custom entries", () => {
    expect(
      restoreUltracodeModeFromEntries([
        { type: "message" },
        { type: "custom", customType: "other" },
      ]),
    ).toEqual({ state: "off" });
  });

  it("should ignore entries whose data is not an object or has a wrong version", () => {
    expect(
      restoreUltracodeModeFromEntries([
        { type: "custom", customType: "ultracode-mode", data: "not-an-object" },
        { type: "custom", customType: "ultracode-mode", data: { version: 99, mode: {} } },
      ]),
    ).toEqual({ state: "off" });
  });

  it("should ignore entries whose mode is not an object or lacks a string state", () => {
    expect(
      restoreUltracodeModeFromEntries([
        { type: "custom", customType: "ultracode-mode", data: { version: 1, mode: null } },
        { type: "custom", customType: "ultracode-mode", data: { version: 1, mode: { state: 7 } } },
      ]),
    ).toEqual({ state: "off" });
  });

  it("should restore an off mode entry", () => {
    expect(
      restoreUltracodeModeFromEntries([
        {
          type: "custom",
          customType: "ultracode-mode",
          data: createUltracodeModeEntryData({ state: "off" }),
        },
      ]),
    ).toEqual({ state: "off" });
  });

  it("should restore an arming mode entry", () => {
    expect(
      restoreUltracodeModeFromEntries([
        {
          type: "custom",
          customType: "ultracode-mode",
          data: createUltracodeModeEntryData({
            state: "arming",
            activatedBy: "session_1",
            goal: "audit repo",
          }),
        },
      ]),
    ).toEqual({ state: "arming", activatedBy: "session_1", goal: "audit repo" });
  });

  it("should restore a disabled mode entry with a reason", () => {
    expect(
      restoreUltracodeModeFromEntries([
        {
          type: "custom",
          customType: "ultracode-mode",
          data: createUltracodeModeEntryData({ state: "disabled", reason: "too expensive" }),
        },
      ]),
    ).toEqual({ state: "disabled", reason: "too expensive" });
  });

  it("should restore a disabled mode entry without a reason", () => {
    expect(
      restoreUltracodeModeFromEntries([
        {
          type: "custom",
          customType: "ultracode-mode",
          data: { version: 1, mode: { state: "disabled" } },
        },
      ]),
    ).toEqual({ state: "disabled" });
  });

  it("should ignore a mode entry with an unknown state", () => {
    expect(
      restoreUltracodeModeFromEntries([
        {
          type: "custom",
          customType: "ultracode-mode",
          data: { version: 1, mode: { state: "bogus" } },
        },
      ]),
    ).toEqual({ state: "off" });
  });
});
