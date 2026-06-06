import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { array, assert, constantFrom, integer, oneof, property } from "fast-check";
import { savedWorkflowPath, validateSavedWorkflowName } from "#src/workflows/saved/resolver.ts";

const propertyRuns = { numRuns: 200 };

const commandName = array(integer({ min: 33, max: 126 }), { minLength: 1, maxLength: 80 })
  .map((codes) => codes.map((code) => String.fromCharCode(code)).join(""))
  .filter((name) => !name.includes("/") && !name.includes("\\") && basename(name) === name);
const invalidCommandName = oneof(
  constantFrom("", "../escape", "nested/workflow", "nested\\workflow", "/absolute"),
  commandName.map((name) => `${name}/child`),
  commandName.map((name) => `${name}\\child`),
);

describe("saved workflow resolver properties", () => {
  it("should accept generated command names without path separators", () => {
    assert(
      property(commandName, (name) => {
        const result = validateSavedWorkflowName(name);

        expect(result).toMatchObject({ status: "ok" });
      }),
      propertyRuns,
    );
  });

  it("should reject empty names and names containing path separators", () => {
    assert(
      property(invalidCommandName, (name) => {
        const result = validateSavedWorkflowName(name);

        expect(result).toMatchObject({
          status: "error",
          error: { _tag: "WorkflowSavedWorkflowInvalidNameError", name },
        });
      }),
      propertyRuns,
    );
  });

  it("should build saved workflow paths inside the selected workflow directory", () => {
    assert(
      property(commandName, (name) => {
        const dir = "/tmp/project/.pi/workflows";
        const path = savedWorkflowPath(dir, name);

        expect(dirname(path)).toBe(dir);
        expect(path.endsWith(`${name}.js`)).toBe(true);
      }),
      propertyRuns,
    );
  });
});
