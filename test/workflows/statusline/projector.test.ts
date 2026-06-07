import { describe, expect, it } from "vitest";
import { workflowAgent } from "../../builders/workflow-agent.ts";
import { WORKFLOW_NOW, workflowRun } from "../../builders/workflow-run.ts";
import {
  formatWorkflowStatusline,
  selectWorkflowStatuslineRun,
} from "#src/workflows/statusline/projector.ts";

describe("workflow statusline projector", () => {
  it("should format a compact active workflow statusline with progress, elapsed time, and token usage", () => {
    const run = workflowRun.running("pi-workflow-extension-review", {
      description: "In-depth quality review of the pi dynamic workflow extension",
      startTime: WORKFLOW_NOW - 258_000,
      agents: [
        workflowAgent.done("scan", { phase: "Review" }),
        workflowAgent.done("review", { phase: "Review" }),
        workflowAgent.running("verify", { phase: "Verify" }),
      ],
      phases: ["Review", "Verify"],
      totalTokens: 832_600,
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW })).toBe(
      "○ pi-workflow-extension-review  2/3 · 4m18s · Verify · verify · ↓832.6k",
    );
  });

  it("should omit description and token usage when formatting the footer cue", () => {
    const run = workflowRun.running("quick-review", {
      startTime: WORKFLOW_NOW - 2_000,
      agents: [workflowAgent.running("scan")],
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW })).toBe(
      "○ quick-review  0/1 · 2s · scan",
    );
  });

  it("should keep the right-side summary visible when truncating long statusline text", () => {
    const run = workflowRun.running("very-long-workflow-name", {
      description: "A very long workflow description that will not fit",
      startTime: WORKFLOW_NOW - 1_000,
      agents: [workflowAgent.running("scan")],
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW, maxWidth: 40 })).toBe(
      "○ very-long-workflow-n…  0/1 · 1s · scan",
    );
  });

  it("should keep the default footer cue short even with many running agents", () => {
    const agents = [
      ...Array.from({ length: 10 }, (_, index) => workflowAgent.done(`done-${index}`)),
      ...Array.from({ length: 31 }, (_, index) => workflowAgent.running(`running-${index}`)),
    ];
    const run = workflowRun.running("pi-workflow-extension-review", {
      description:
        "In-depth quality review of the pi dynamic-workflow extension statusline behavior",
      startTime: WORKFLOW_NOW - 258_000,
      agents,
      totalTokens: 832_600,
    });

    const statusline = formatWorkflowStatusline(run, { now: WORKFLOW_NOW });

    expect(statusline).toBe(
      "○ pi-workflow-extension-review  10/41 · 4m18s · running-30 +30 · ↓832.6k",
    );
    expect(statusline.length).toBeLessThanOrEqual(80);
    expect(statusline).not.toContain("In-depth quality review");
  });

  it("should cap long workflow, phase, and agent labels in the default footer cue", () => {
    const run = workflowRun.running("deep-research-alexander-opalic", {
      description: "Public-source deep research status details should stay out of the footer",
      startTime: WORKFLOW_NOW - 119_000,
      agents: Array.from({ length: 6 }, (_, index) =>
        workflowAgent.running(
          index === 5 ? "discover-identity-disambiguation" : `public-source-${index}`,
          { phase: "Discover public sources" },
        ),
      ),
      phases: ["Discover public sources"],
    });

    const statusline = formatWorkflowStatusline(run, { now: WORKFLOW_NOW });

    expect(statusline).toBe(
      "○ deep-research-ale…  0/6 · 1m59s · Discover public s… · discover-identity-d… +5",
    );
    expect(statusline.length).toBeLessThanOrEqual(80);
    expect(statusline).not.toContain("Public-source deep research status details");
  });

  it("should select the newest active workflow for the current session", () => {
    const completed = workflowRun.completed("done", { runId: "wf_done", startTime: 300 });
    const otherSession = workflowRun.running("other", {
      runId: "wf_other",
      sessionId: "other_session",
      startTime: 400,
    });
    const currentOlder = workflowRun.running("older", {
      runId: "wf_older",
      sessionId: "session_current",
      startTime: 100,
    });
    const currentNewer = workflowRun.running("newer", {
      runId: "wf_newer",
      sessionId: "session_current",
      startTime: 200,
    });

    expect(
      selectWorkflowStatuslineRun([completed, otherSession, currentOlder, currentNewer], {
        sessionId: "session_current",
      })?.runId,
    ).toBe("wf_newer");
  });
});
