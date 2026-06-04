import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
// @ts-expect-error The local Oxlint plugin is plain JavaScript so Oxlint can load it directly.
import localPlugin from "../../tools/oxlint-plugin-local.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester();
const rule = localPlugin.rules["test-name-should"];

describe("local/test-name-should", () => {
  tester.run("local/test-name-should", rule, {
    valid: [
      'it("should register command when extension loads", () => {});',
      'it.only("should focus matching test when debugging", () => {});',
      'it.skip("should document skipped behavior when dependency is missing", () => {});',
      'test("should parse workflow meta when script is valid", () => {});',
      "it(dynamicName, () => {});",
    ],
    invalid: [
      {
        code: 'it("registers command", () => {});',
        errors: [{ messageId: "missingShould" }],
      },
      {
        code: 'test.skip("parses workflow meta", () => {});',
        errors: [{ messageId: "missingShould" }],
      },
    ],
  });
});
