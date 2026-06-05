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

  it("should return parse errors as Result values when workflow script is invalid", () => {
    const result = tryParseWorkflowScript("return null;");

    expect(result).toMatchObject({
      status: "error",
      error: { name: "WorkflowParseError" },
    });
  });
});
