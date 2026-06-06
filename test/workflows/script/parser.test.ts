import { describe, expect, it } from "vitest";
import {
  parseWorkflowScript,
  tryParseWorkflowScript,
  WorkflowParseError,
} from "#src/workflows/script/parser.ts";
import { invalidWorkflowScript, workflowScript } from "./workflow-factory.ts";

describe("parseWorkflowScript", () => {
  it("should extract literal meta and executable body when script starts with exported meta", () => {
    const parsed = parseWorkflowScript(
      workflowScript({
        meta: {
          name: "inspect",
          description: "Inspect the project",
          whenToUse: "When orientation is needed",
          model: "opus",
          phases: [{ title: "Scan", detail: "Read files", model: "fast" }],
        },
        body: `
phase("Scan");
return "done";
`,
      }),
    );

    expect(parsed.meta).toEqual({
      name: "inspect",
      description: "Inspect the project",
      whenToUse: "When orientation is needed",
      model: "opus",
      phases: [{ title: "Scan", detail: "Read files", model: "fast" }],
    });
    expect(parsed.body).not.toContain("export const meta");
    expect(parsed.body).toContain('phase("Scan")');
  });

  it("should require meta as the first statement when script has code before exported meta", () => {
    expect(() =>
      parseWorkflowScript(
        workflowScript({
          beforeMeta: `
const before = true;
`,
          meta: { name: "late" },
          body: `
return before;
`,
        }),
      ),
    ).toThrow(WorkflowParseError);
  });

  it("should require meta.description as a non-empty string", () => {
    expect(() =>
      parseWorkflowScript(invalidWorkflowScript({ metaSource: '{ name: "missing-description" }' })),
    ).toThrow(/meta\.description/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource: '{ name: "empty-description", description: "" }',
        }),
      ),
    ).toThrow(/meta\.description/);
  });

  it("should reject non-literal meta values when exported meta uses dynamic expressions", () => {
    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          beforeMeta: `
const name = "dynamic";
`,
          metaSource: "{ name }",
        }),
      ),
    ).toThrow(/start with/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource: '{ name: "dynamic", description: buildDescription() }',
        }),
      ),
    ).toThrow(/literal/);
  });

  it("should reject spreads, computed keys, and template interpolation when parsing workflow meta", () => {
    expect(() =>
      parseWorkflowScript(invalidWorkflowScript({ metaSource: '{ name: "spread", ...extra }' })),
    ).toThrow(/spreads/);

    expect(() =>
      parseWorkflowScript(invalidWorkflowScript({ metaSource: '{ ["name"]: "computed" }' })),
    ).toThrow(/computed/);

    expect(() =>
      parseWorkflowScript(invalidWorkflowScript({ metaSource: "{ name: `templated` }" })),
    ).toThrow(/literal/);
  });

  it("should reject nondeterministic workflow primitives when parsing script body", () => {
    expect(() =>
      parseWorkflowScript(
        workflowScript({
          meta: { name: "clock" },
          body: `
return Date.now();
`,
        }),
      ),
    ).toThrow(/Date.now/);

    expect(() =>
      parseWorkflowScript(
        workflowScript({
          meta: { name: "random" },
          body: `
return Math.random();
`,
        }),
      ),
    ).toThrow(/Math.random/);

    expect(() =>
      parseWorkflowScript(
        workflowScript({
          meta: { name: "date" },
          body: `
return new Date();
`,
        }),
      ),
    ).toThrow(/new Date/);
  });

  it("should reject forbidden nondeterministic text even inside prompt strings", () => {
    expect(() =>
      parseWorkflowScript(
        workflowScript({
          meta: { name: "prompt-text" },
          body: `
return await agent("Audit code that mentions Date.now in docs");
`,
        }),
      ),
    ).toThrow(/Date.now.*inside strings/);
  });

  it("should return parse errors as Result values when workflow script is invalid", () => {
    const result = tryParseWorkflowScript("return null;");

    expect(result).toMatchObject({
      status: "error",
      error: { name: "WorkflowParseError" },
    });
  });

  it("should wrap a non-workflow parse Error from acorn as a WorkflowParseError", () => {
    const result = tryParseWorkflowScript("export const meta = {");

    expect(result).toMatchObject({
      status: "error",
      error: { name: "WorkflowParseError" },
    });
  });

  it("should reject a non-const meta export and a multi-declarator meta export", () => {
    expect(() =>
      parseWorkflowScript('export let meta = { name: "x", description: "d" };\nreturn null;'),
    ).toThrow(/start with/);

    expect(() =>
      parseWorkflowScript(
        'export const meta = { name: "x", description: "d" }, other = 1;\nreturn null;',
      ),
    ).toThrow(/start with/);
  });

  it("should reject sparse array holes inside meta literals", () => {
    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource: '{ name: "holes", description: "d", phases: [,] }',
        }),
      ),
    ).toThrow(/must not be empty/);
  });

  it("should reject getters, methods, and numeric keys in meta objects", () => {
    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({ metaSource: '{ name: "m", get description() { return "d"; } }' }),
      ),
    ).toThrow(/plain data properties/);

    expect(() =>
      parseWorkflowScript(invalidWorkflowScript({ metaSource: '{ name: "m", describe() {} }' })),
    ).toThrow(/plain data properties/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({ metaSource: '{ name: "m", description: "d", 1: "x" }' }),
      ),
    ).toThrow(/identifiers or string literals/);
  });

  it("should reject meta.name that is missing or empty", () => {
    expect(() =>
      parseWorkflowScript(invalidWorkflowScript({ metaSource: '{ description: "d" }' })),
    ).toThrow(/meta\.name must be a non-empty string/);

    expect(() =>
      parseWorkflowScript(invalidWorkflowScript({ metaSource: '{ name: "", description: "d" }' })),
    ).toThrow(/meta\.name must be a non-empty string/);
  });

  it("should accept and validate optional meta fields when present", () => {
    const parsed = parseWorkflowScript(
      workflowScript({
        meta: {
          name: "opt",
          description: "d",
          whenToUse: "sometimes",
          model: "opus",
          phases: [{ title: "Scan", detail: "look", model: "fast" }],
        },
      }),
    );

    expect(parsed.meta).toEqual({
      name: "opt",
      description: "d",
      whenToUse: "sometimes",
      model: "opus",
      phases: [{ title: "Scan", detail: "look", model: "fast" }],
    });
  });

  it("should reject non-string optional meta fields and malformed phases", () => {
    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({ metaSource: '{ name: "m", description: "d", whenToUse: 1 }' }),
      ),
    ).toThrow(/meta\.whenToUse must be a string/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({ metaSource: '{ name: "m", description: "d", phases: "nope" }' }),
      ),
    ).toThrow(/meta\.phases must be an array/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({ metaSource: '{ name: "m", description: "d", phases: ["nope"] }' }),
      ),
    ).toThrow(/meta\.phases\[0\] must be an object/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource: '{ name: "m", description: "d", phases: [{ title: "t", detail: 2 }] }',
        }),
      ),
    ).toThrow(/meta\.phases\[0\]\.detail must be a string/);
  });

  it("should accept phases that omit the optional detail and model fields", () => {
    const parsed = parseWorkflowScript(
      workflowScript({
        meta: { name: "bare-phase", description: "d", phases: [{ title: "Only title" }] },
      }),
    );

    expect(parsed.meta.phases).toEqual([{ title: "Only title" }]);
  });

  it("should reject aliased nondeterminism that evades the substring guard via AST analysis", () => {
    expect(() =>
      parseWorkflowScript(
        workflowScript({ meta: { name: "spaced-now" }, body: "return Date . now();" }),
      ),
    ).toThrow(/Date\.now/);

    expect(() =>
      parseWorkflowScript(
        workflowScript({ meta: { name: "spaced-random" }, body: "return Math . random();" }),
      ),
    ).toThrow(/Math\.random/);

    expect(() =>
      parseWorkflowScript(
        workflowScript({ meta: { name: "spaced-date" }, body: "return new Date ();" }),
      ),
    ).toThrow(/argument-less new Date/);
  });

  it("should allow new Date with arguments and unrelated member calls", () => {
    const parsed = parseWorkflowScript(
      workflowScript({
        meta: { name: "allowed" },
        body: 'const at = new Date (args.ts);\nreturn at.toISOString() + console.log("ok");',
      }),
    );

    expect(parsed.meta.name).toBe("allowed");
  });
});
