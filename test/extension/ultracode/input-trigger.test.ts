import { describe, expect, it } from "vitest";
import {
  isEmptyUltracodeInput,
  parseUltracodeInput,
} from "#src/extension/ultracode/input-trigger.ts";

describe("parseUltracodeInput", () => {
  it.each([
    ["ultracode audit repo", "audit repo"],
    ["  Ultracode audit repo", "audit repo"],
    ["ULTRACODE   audit repo", "audit repo"],
    ["\nultracode audit repo\n", "audit repo"],
    ["please ultracode audit repo", "please ultracode audit repo"],
    ["foo ultracode bar", "foo ultracode bar"],
    ["please use ultracode to audit repo", "please use ultracode to audit repo"],
  ])("should parse an ultracode trigger from %j", (input, goal) => {
    expect(parseUltracodeInput(input)).toEqual({ goal });
  });

  it.each(["ultracode", " ultracode ", "ultracoder audit repo", "", "plain task"])(
    "should ignore non-trigger input %j",
    (input) => {
      expect(parseUltracodeInput(input)).toBeUndefined();
    },
  );
});

describe("isEmptyUltracodeInput", () => {
  it.each(["ultracode", " Ultracode ", "ULTRACODE\n"])(
    "should detect an empty ultracode trigger %j",
    (input) => {
      expect(isEmptyUltracodeInput(input)).toBe(true);
    },
  );

  it.each(["ultracode audit", "ultracoder", "please ultracode"])(
    "should not flag non-empty or non-exact input %j",
    (input) => {
      expect(isEmptyUltracodeInput(input)).toBe(false);
    },
  );
});
