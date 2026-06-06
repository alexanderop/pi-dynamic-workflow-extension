import { describe, expect, it, vi } from "vitest";
import { workflowAgent } from "../../builders/workflow-agent.ts";
import { WORKFLOW_NOW, workflowRun } from "../../builders/workflow-run.ts";
import { createWorkflowStatuslineController } from "#src/extension/statusline/workflow-statusline.ts";

describe("workflow statusline controller", () => {
  it("should set a Pi footer status when an active workflow updates", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => WORKFLOW_NOW,
    });

    controller.update(
      workflowRun.running("review", {
        startTime: WORKFLOW_NOW - 3_000,
        agents: [
          workflowAgent.done("scan", { phase: "Review" }),
          workflowAgent.running("verify", { phase: "Verify" }),
        ],
        phases: ["Review", "Verify"],
      }),
    );

    expect(setStatus).toHaveBeenCalledWith(
      "dynamic-workflows",
      "○ review  1/2 agents · 3s · phase Verify · agent verify",
    );
  });

  it("should keep the newest active workflow for the current session", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => WORKFLOW_NOW,
      sessionId: "session_current",
    });

    controller.setRuns([
      workflowRun.running("older", {
        runId: "wf_older",
        sessionId: "session_current",
        startTime: WORKFLOW_NOW - 10_000,
      }),
      workflowRun.running("other", {
        runId: "wf_other",
        sessionId: "session_other",
        startTime: WORKFLOW_NOW - 1_000,
      }),
      workflowRun.running("newer", {
        runId: "wf_newer",
        sessionId: "session_current",
        startTime: WORKFLOW_NOW - 2_000,
      }),
    ]);

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", "○ newer  0/0 agents · 2s");
  });

  it("should clear the footer status when no active workflows remain", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => WORKFLOW_NOW,
    });

    controller.update(workflowRun.running("review"));
    controller.update(workflowRun.completed("review"));

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", undefined);
  });

  it("should refresh elapsed time when ticking an active workflow", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    let now = WORKFLOW_NOW;
    const controller = createWorkflowStatuslineController({
      setStatus,
      now: () => now,
    });

    controller.update(workflowRun.running("review", { startTime: WORKFLOW_NOW }));
    now = WORKFLOW_NOW + 61_000;
    controller.tick();

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", "○ review  0/0 agents · 1m 1s");
  });

  it("should clear the footer status when disposed", () => {
    const setStatus = vi.fn<SetStatusForTest>();
    const controller = createWorkflowStatuslineController({ setStatus });

    controller.update(workflowRun.running("review"));
    controller.dispose();

    expect(setStatus).toHaveBeenLastCalledWith("dynamic-workflows", undefined);
  });
});

type SetStatusForTest = (key: string, text: string | undefined) => void;
