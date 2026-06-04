import { describe, expect, it } from "vitest";
import {
  parseWorkflowScript,
  tryParseWorkflowScript,
  WorkflowParseError,
} from "../../src/workflows/parser.ts";
import { invalidWorkflowScript, workflowScript } from "./workflow-factory.ts";

describe("parseWorkflowScript", () => {
  it("extracts literal meta and executable body", () => {
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

  it("requires meta as the first statement", () => {
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

  it("rejects non-literal meta values", () => {
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

  it("rejects spreads, computed keys, and template interpolation in meta", () => {
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

  it("rejects nondeterministic workflow primitives", () => {
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

  it("can return parse errors as Result values", () => {
    const result = tryParseWorkflowScript("return null;");

    expect(result).toMatchObject({
      status: "error",
      error: { name: "WorkflowParseError" },
    });
  });
});
