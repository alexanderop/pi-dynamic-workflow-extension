import { describe, expect, it } from "vitest";
import {
  isUltracodeModeActive,
  transitionUltracodeMode,
  type UltracodeModeState,
} from "#src/extension/ultracode/mode-state-machine.ts";

describe("transitionUltracodeMode", () => {
  it("should turn on from a valid trigger", () => {
    const next = transitionUltracodeMode(
      { state: "off" },
      { type: "valid_trigger", goal: "audit repo", activatedBy: "session_1" },
    );

    expect(next).toEqual({
      state: "on",
      activatedBy: "session_1",
      goal: "audit repo",
    });
    expect(isUltracodeModeActive(next)).toBe(true);
  });

  it("should allow arming to become on after policy injection", () => {
    const arming: UltracodeModeState = {
      state: "arming",
      activatedBy: "session_1",
      goal: "audit repo",
    };

    expect(transitionUltracodeMode(arming, { type: "policy_injected" })).toEqual({
      state: "on",
      activatedBy: "session_1",
      goal: "audit repo",
    });
  });

  it("should clear in-memory mode on session shutdown", () => {
    expect(
      transitionUltracodeMode(
        { state: "on", activatedBy: "session_1", goal: "audit repo" },
        { type: "session_shutdown" },
      ),
    ).toEqual({ state: "off" });
  });

  it("should disable the mode with a reason", () => {
    expect(
      transitionUltracodeMode(
        { state: "on", activatedBy: "session_1", goal: "audit repo" },
        { type: "disable", reason: "too expensive" },
      ),
    ).toEqual({ state: "disabled", reason: "too expensive" });
  });

  it("should disable the mode without a reason", () => {
    expect(transitionUltracodeMode({ state: "off" }, { type: "disable" })).toEqual({
      state: "disabled",
      reason: undefined,
    });
  });

  it("should restore an arbitrary state directly", () => {
    const restored: UltracodeModeState = {
      state: "on",
      activatedBy: "session_2",
      goal: "ship it",
    };

    expect(transitionUltracodeMode({ state: "off" }, { type: "restore", state: restored })).toBe(
      restored,
    );
  });

  it("should ignore policy injection when not arming", () => {
    const off: UltracodeModeState = { state: "off" };
    expect(transitionUltracodeMode(off, { type: "policy_injected" })).toBe(off);
  });

  it("should block valid triggers while disabled", () => {
    const disabled: UltracodeModeState = { state: "disabled", reason: "test" };

    expect(
      transitionUltracodeMode(disabled, {
        type: "valid_trigger",
        goal: "audit repo",
        activatedBy: "session_1",
      }),
    ).toBe(disabled);
  });
});
