import { describe, expect, it } from "vitest";
import {
  ultracodeBeforeAgentSystemPrompt,
  ultracodePolicyMessage,
  ultracodeSystemReminder,
} from "#src/extension/ultracode/system-reminder.ts";

describe("ultracodeSystemReminder", () => {
  it("should include the activating goal when mode is on", () => {
    const reminder = ultracodeSystemReminder({
      state: "on",
      activatedBy: "session_1",
      goal: "audit repo",
    });

    expect(reminder).toContain("ultracode is ON");
    expect(reminder).toContain("Activated by task: audit repo");
  });

  it("should include the activating goal when mode is arming", () => {
    const reminder = ultracodeSystemReminder({
      state: "arming",
      activatedBy: "session_1",
      goal: "fix bug",
    });

    expect(reminder).toContain("Activated by task: fix bug");
  });

  it("should omit the activating goal when mode is off", () => {
    const reminder = ultracodeSystemReminder({ state: "off" });

    expect(reminder).toContain("ultracode is ON");
    expect(reminder).not.toContain("Activated by task:");
  });

  it("should omit the activating goal when mode is disabled", () => {
    const reminder = ultracodeSystemReminder({ state: "disabled", reason: "nope" });

    expect(reminder).not.toContain("Activated by task:");
  });
});

describe("ultracodeBeforeAgentSystemPrompt", () => {
  it("should append the reminder and authoring guidance to the current prompt", () => {
    const prompt = ultracodeBeforeAgentSystemPrompt("base prompt", {
      state: "on",
      activatedBy: "session_1",
      goal: "audit repo",
    });

    expect(prompt).toContain("base prompt");
    expect(prompt).toContain("ultracode is ON");
  });
});

describe("ultracodePolicyMessage", () => {
  it("should build a non-displayed policy message with the reminder content", () => {
    const message = ultracodePolicyMessage({ state: "off" });

    expect(message).toEqual({
      customType: "ultracode-policy",
      content: expect.stringContaining("ultracode is ON"),
      display: false,
    });
  });
});
