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

  it("should default the elapsed-time clock to the current time when now is omitted", () => {
    const run = workflowRun.running("now-default", {
      startTime: Date.now(),
      agents: [workflowAgent.running("scan")],
    });

    expect(formatWorkflowStatusline(run)).toContain("○ now-default");
  });

  it("should return an empty string when the available width is below one column", () => {
    const run = workflowRun.running("anything", { agents: [workflowAgent.running("scan")] });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW, maxWidth: 0 })).toBe("");
  });

  it("should truncate to just the summary when the summary already fills the width", () => {
    const run = workflowRun.running("very-long-workflow-name", {
      description: "Some description text",
      startTime: WORKFLOW_NOW - 1_000,
      agents: [workflowAgent.running("scan")],
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW, maxWidth: 12 })).toBe("0/1 agents …");
  });

  it("should drop the left column when there is no room beside the summary", () => {
    const run = workflowRun.running("name", {
      startTime: WORKFLOW_NOW - 1_000,
      agents: [workflowAgent.running("scan")],
    });
    const summary = "0/1 agents · 1s · agent scan";

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW, maxWidth: summary.length + 2 })).toBe(
      summary,
    );
  });

  it("should fall back to the newest queued agent when none are running", () => {
    const run = workflowRun.running("queued-only", {
      startTime: WORKFLOW_NOW - 1_000,
      agents: [
        workflowAgent.queued("first", { index: 0, queuedAt: WORKFLOW_NOW - 5_000 }),
        workflowAgent.queued("second", { index: 1, queuedAt: WORKFLOW_NOW - 1_000 }),
      ],
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW })).toContain("agent second");
  });

  it("should use the last recorded phase entry as the current phase title", () => {
    const run = workflowRun.running("phased", {
      startTime: WORKFLOW_NOW - 1_000,
      phases: ["Plan", "Build"],
      agents: [workflowAgent.running("scan")],
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW })).toContain("phase Build");
  });

  it("should use the single declared phase title when no phase entries are recorded", () => {
    const run = workflowRun.running("single-phase", {
      startTime: WORKFLOW_NOW - 1_000,
      phases: ["Only"],
      agents: [workflowAgent.running("scan")],
      workflowProgress: [workflowAgent.running("scan")],
    });

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW })).toContain("phase Only");
  });

  it("should render glyphs for completed, failed, stopped, and paused statuses", () => {
    const base = { now: WORKFLOW_NOW };
    expect(formatWorkflowStatusline(workflowRun.completed("done"), base)).toContain("✓ done");
    expect(formatWorkflowStatusline(workflowRun.failed("oops"), base)).toContain("! oops");
    expect(formatWorkflowStatusline(workflowRun.stopped("halt"), base)).toContain("■ halt");
    expect(formatWorkflowStatusline(workflowRun.paused("hold"), base)).toContain("○ hold");
  });

  it("should fall back to the default glyph for non-terminal, non-active statuses", () => {
    const run = { ...workflowRun.running("fresh"), status: "created" as const };

    expect(formatWorkflowStatusline(run, { now: WORKFLOW_NOW })).toContain("○ fresh");
  });

  it("should break run ordering ties using the run id when sort times are equal", () => {
    const first = workflowRun.running("a", { runId: "wf_aaa", startTime: 500 });
    const second = workflowRun.running("b", { runId: "wf_bbb", startTime: 500 });

    expect(selectWorkflowStatuslineRun([first, second])?.runId).toBe("wf_bbb");
  });

  it("should order runs by parsed timestamp when start times are unavailable", () => {
    const older = workflowRun.running("older", {
      runId: "wf_old",
      startTime: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    const newer = workflowRun.running("newer", {
      runId: "wf_new",
      startTime: 0,
      timestamp: "2026-02-01T00:00:00.000Z",
    });
    const undated = workflowRun.running("undated", {
      runId: "wf_undated",
      startTime: 0,
      timestamp: "not-a-date",
    });
    const noTimestamp = workflowRun.running("none", { runId: "wf_none", startTime: 0 });

    expect(selectWorkflowStatuslineRun([older, undated, noTimestamp, newer])?.runId).toBe("wf_new");
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
