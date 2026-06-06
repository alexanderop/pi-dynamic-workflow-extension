import { describe, expect, it } from "vitest";
import { workflowAgent } from "../../builders/workflow-agent.ts";
import { WORKFLOW_NOW, workflowRun } from "../../builders/workflow-run.ts";
import {
  formatWorkflowStatusline,
  selectWorkflowStatuslineRun,
} from "#src/workflows/statusline/projector.ts";

describe("workflow statusline projector", () => {
  it("should format an active workflow statusline with progress, elapsed time, and token usage", () => {
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
      "○ pi-workflow-extension-review  2/3 agents · 4m 18s · phase Verify · agent verify · ↓ 832.6k tokens  In-depth quality review of the pi dynamic workf…",
    );
  });

  it("should omit optional description and token usage when they are not available", () => {
    const run = workflowRun.running("quick-review", {
      startTime: WORKFLOW_NOW - 2_000,
      agents: [workflowAgent.running("scan")],
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW })).toBe(
      "○ quick-review  0/1 agents · 2s · agent scan",
    );
  });

  it("should keep the right-side summary visible when truncating long statusline text", () => {
    const run = workflowRun.running("very-long-workflow-name", {
      description: "A very long workflow description that will not fit",
      startTime: WORKFLOW_NOW - 1_000,
      agents: [workflowAgent.running("scan")],
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW, maxWidth: 40 })).toBe(
      "○ very-lo…  0/1 agents · 1s · agent scan",
    );
  });

  it("should match the active-workflow statusline reference screen shape", () => {
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

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW, maxWidth: 133 })).toBe(
      "○ pi-workflow-extensi…  In-depth quality review of the pi dynamic-wo…  10/41 agents · 4m 18s · agent running-30 +30 · ↓ 832.6k tokens",
    );
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
