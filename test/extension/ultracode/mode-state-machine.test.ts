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
