import { describe, expect, it } from "vitest";
import { array, assert, constantFrom, integer, property, record } from "fast-check";
import { parseWorkflowScript, WorkflowParseError } from "#src/workflows/script/parser.ts";
import type { WorkflowMeta } from "#src/workflows/script/model.ts";

const propertyRuns = { numRuns: 200 };

const printableText = array(integer({ min: 32, max: 126 }), { maxLength: 80 }).map((codes) =>
  codes.map((code) => String.fromCharCode(code)).join(""),
);
const nonEmptyPrintableText = array(integer({ min: 32, max: 126 }), {
  minLength: 1,
  maxLength: 80,
}).map((codes) => codes.map((code) => String.fromCharCode(code)).join(""));
const phaseArbitrary = record({
  title: nonEmptyPrintableText,
  detail: printableText,
  model: printableText,
});
const metaArbitrary = record({
  name: nonEmptyPrintableText,
  description: printableText,
  whenToUse: printableText,
  phases: array(phaseArbitrary, { maxLength: 8 }),
});

describe("workflow parser properties", () => {
  it("should parse generated literal workflow metadata", () => {
    assert(
      property(metaArbitrary, (meta) => {
        const source = workflowScript(meta, 'phase("Run");\nreturn args;');
        const parsed = parseWorkflowScript(source);

        expect(parsed.meta).toEqual(meta);
        expect(parsed.body).not.toContain("export const meta");
        expect(parsed.body).toContain("return args");
      }),
      propertyRuns,
    );
  });

  it("should reject generated non-literal metadata expressions", () => {
    assert(
      property(
        constantFrom(
          "{ name }",
          "{ name: buildName() }",
          "{ name: `templated` }",
          '{ name: "spread", ...extra }',
          '{ ["name"]: "computed" }',
        ),
        (metaSource) => {
          expect(() => parseWorkflowScript(invalidWorkflowScript(metaSource))).toThrow(
            WorkflowParseError,
          );
        },
      ),
      propertyRuns,
    );
  });

  it("should reject forbidden nondeterministic primitives wherever they appear in script body", () => {
    assert(
      property(
        constantFrom("Date.now()", "Math.random()", "new Date()"),
        printableText,
        (forbiddenExpression, suffix) => {
          const source = workflowScript(
            { name: "deterministic" },
            `const value = ${forbiddenExpression};\n${commentLine(suffix)}\nreturn value;`,
          );

          expect(() => parseWorkflowScript(source)).toThrow(WorkflowParseError);
        },
      ),
      propertyRuns,
    );
  });
});

function workflowScript(meta: WorkflowMeta, body: string): string {
  return `export const meta = ${JSON.stringify(meta)};\n${body}`;
}

function invalidWorkflowScript(metaSource: string): string {
  return `export const meta = ${metaSource};\nreturn null;`;
}

function commentLine(text: string): string {
  return `// ${text.replace(/\r?\n/g, " ")}`;
}
