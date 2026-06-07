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
          phases: [
            {
              title: "Scan",
              detail: "Read files",
              model: "fast",
              agentCount: 3,
              agents: [
                { label: "scan:docs", model: "fast", agentType: "researcher" },
                { label: "scan:code" },
              ],
            },
          ],
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
      phases: [
        {
          title: "Scan",
          detail: "Read files",
          model: "fast",
          agentCount: 3,
          agents: [
            { label: "scan:docs", model: "fast", agentType: "researcher" },
            { label: "scan:code" },
          ],
        },
      ],
    });
    expect(parsed.body).not.toContain("export const meta");
    expect(parsed.body).toContain('phase("Scan")');
  });

  it("should preserve workflow and phase thinking-level hints as literal metadata", () => {
    const parsed = parseWorkflowScript(
      workflowScript({
        meta: {
          name: "thinking-routing",
          description: "Route simple and heavy agents",
          thinkingLevel: "low",
          phases: [
            { title: "Scout", model: "openai-codex/gpt-5.4-mini", thinkingLevel: "low" },
            { title: "Synthesize", model: "openai-codex/gpt-5.5", thinkingLevel: "high" },
          ],
        },
      }),
    );

    expect(parsed.meta).toMatchObject({
      thinkingLevel: "low",
      phases: [
        { title: "Scout", model: "openai-codex/gpt-5.4-mini", thinkingLevel: "low" },
        { title: "Synthesize", model: "openai-codex/gpt-5.5", thinkingLevel: "high" },
      ],
    });
  });

  it("should accept misspelled model and thinking-level strings as soft hints", () => {
    const parsed = parseWorkflowScript(
      workflowScript({
        meta: {
          name: "soft-hints",
          description: "Keep invalid hints soft",
          model: "openai-codex/gpt-5.55",
          thinkingLevel: "hihg",
          phases: [{ title: "Review", model: "not-a-real-model", thinkingLevel: "very-high" }],
        },
      }),
    );

    expect(parsed.meta).toMatchObject({
      model: "openai-codex/gpt-5.55",
      thinkingLevel: "hihg",
      phases: [{ title: "Review", model: "not-a-real-model", thinkingLevel: "very-high" }],
    });
  });

  it("should reject non-string thinking-level metadata before launch", () => {
    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource: '{ name: "bad-thinking", description: "Bad thinking", thinkingLevel: 123 }',
        }),
      ),
    ).toThrow(/meta\.thinkingLevel.*string/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource:
            '{ name: "bad-phase-thinking", description: "Bad phase thinking", phases: [{ title: "Review", thinkingLevel: false }] }',
        }),
      ),
    ).toThrow(/phases\[0\]\.thinkingLevel.*string/);
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

  it("should reject invalid planned phase agent counts", () => {
    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource:
            '{ name: "invalid-count", description: "Invalid count", phases: [{ title: "Scan", agentCount: "six" }] }',
        }),
      ),
    ).toThrow(/agentCount.*non-negative integer/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource:
            '{ name: "fractional-count", description: "Fractional count", phases: [{ title: "Scan", agentCount: 1.5 }] }',
        }),
      ),
    ).toThrow(/agentCount.*non-negative integer/);
  });

  it("should reject invalid planned phase agent rows", () => {
    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource:
            '{ name: "invalid-agent", description: "Invalid agent", phases: [{ title: "Scan", agents: [{ model: "fast" }] }] }',
        }),
      ),
    ).toThrow(/agents\[0\]\.label.*string/);

    expect(() =>
      parseWorkflowScript(
        invalidWorkflowScript({
          metaSource:
            '{ name: "invalid-agents", description: "Invalid agents", phases: [{ title: "Scan", agents: "scan" }] }',
        }),
      ),
    ).toThrow(/agents.*array/);
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
});
