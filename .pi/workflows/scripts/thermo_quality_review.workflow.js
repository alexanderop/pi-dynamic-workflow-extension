export const meta = {
  name: "thermo_quality_review",
  description: "Deep code quality review of current working tree changes",
  phases: [{ title: "Map" }, { title: "Review" }, { title: "Synthesize" }],
};

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["area", "findings"],
  properties: {
    area: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line_hint", "title", "evidence", "impact", "remedy"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          file: { type: "string" },
          line_hint: { type: "string" },
          title: { type: "string" },
          evidence: { type: "string" },
          impact: { type: "string" },
          remedy: { type: "string" },
        },
      },
    },
  },
};

phase("Map");
log(
  "Reviewing current working tree changes for structural quality, runtime boundaries, and test/code health.",
);

const prompts = [
  {
    label: "review:architecture",
    area: "architecture",
    prompt:
      "Repo root: " +
      cwd +
      "\nPerform an ambitious structural code-quality review of the current working tree changes. Focus on src/workflows/runtime.ts, parser.ts, types.ts, extension wiring, and docs/backlog/spec alignment. Read relevant files and git status/diff. Return only high-conviction maintainability/abstraction findings with file/line evidence and code-judo remedies.",
  },
  {
    label: "review:sandbox",
    area: "sandbox-boundary",
    prompt:
      "Repo root: " +
      cwd +
      "\nReview the workflow JavaScript sandbox/runtime boundary in current working tree changes. Be adversarial: look for host boundary leaks, vm footguns, nondeterminism guards, and misleading tests. Ground in exact code and propose simpler safer structure. Return high-conviction findings only.",
  },
  {
    label: "review:types-tests",
    area: "types-tests",
    prompt:
      "Repo root: " +
      cwd +
      "\nReview type boundaries and tests in current working tree changes for code-quality regressions. Focus on any/unknown/casts, API contracts vs spec.md, tests that overfit implementation, and file-size/decomposition. Return high-conviction findings only.",
  },
];

phase("Review");
const reviews = await parallel(
  prompts.map(
    (item) => () =>
      agent(item.prompt, {
        label: item.label,
        phase: "Review",
        schema: FINDINGS_SCHEMA,
        agentType: "reviewer",
      }),
  ),
);
log("Collected " + reviews.length + " review reports");

phase("Synthesize");
const report = await agent(
  "Synthesize these review reports into a concise thermo-nuclear code quality review. Deduplicate findings, prioritize structural blockers, include exact file paths and line hints, and do not include low-value nits. Reviews:\n" +
    JSON.stringify(reviews, null, 2),
  { label: "synthesize", phase: "Synthesize", agentType: "reviewer" },
);
artifact("thermo_quality_review_inputs.json", reviews, {
  type: "json",
  description: "Raw parallel review findings",
});
artifact("thermo_quality_review_synthesis.md", report, {
  type: "markdown",
  description: "Synthesized review draft",
});
return { reviews, report };
