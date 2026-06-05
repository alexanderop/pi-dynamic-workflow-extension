import { describe, expect, it } from "vitest";
import {
  clampWorkflowViewNavigation,
  cycleWorkflowViewFocus,
  enterWorkflowViewSelection,
  initialWorkflowViewNavigation,
  moveWorkflowViewSelection,
} from "#src/workflows/view/navigation.ts";

describe("workflow TUI navigation", () => {
  it("should move the selected run and reset the selected agent", () => {
    const state = moveWorkflowViewSelection(
      { focus: "runs", selectedRunIndex: 0, selectedAgentIndex: 3 },
      { runCount: 3, agentCount: 4 },
      1,
    );

    expect(state).toEqual({ focus: "runs", selectedRunIndex: 1, selectedAgentIndex: 0 });
  });

  it("should clamp run selection at the first and last run", () => {
    const initial = initialWorkflowViewNavigation();
    const atFirst = moveWorkflowViewSelection(initial, { runCount: 2, agentCount: 0 }, -1);
    const atLast = moveWorkflowViewSelection(
      { focus: "runs", selectedRunIndex: 1, selectedAgentIndex: 0 },
      { runCount: 2, agentCount: 0 },
      1,
    );

    expect(atFirst.selectedRunIndex).toBe(0);
    expect(atLast.selectedRunIndex).toBe(1);
  });

  it("should cycle focus between runs agents and details when agents exist", () => {
    const bounds = { runCount: 1, agentCount: 2 };
    const agents = cycleWorkflowViewFocus(initialWorkflowViewNavigation(), bounds);
    const details = cycleWorkflowViewFocus(agents, bounds);
    const runs = cycleWorkflowViewFocus(details, bounds);

    expect(agents.focus).toBe("agents");
    expect(details.focus).toBe("details");
    expect(runs.focus).toBe("runs");
  });

  it("should skip agent focus when the selected run has no agents", () => {
    const next = cycleWorkflowViewFocus(initialWorkflowViewNavigation(), {
      runCount: 1,
      agentCount: 0,
    });

    expect(next.focus).toBe("details");
  });

  it("should enter agent focus from a selected run", () => {
    const state = enterWorkflowViewSelection(initialWorkflowViewNavigation(), {
      runCount: 1,
      agentCount: 1,
    });

    expect(state.focus).toBe("agents");
  });

  it("should clamp stale selections after the run list refreshes", () => {
    const state = clampWorkflowViewNavigation(
      { focus: "agents", selectedRunIndex: 3, selectedAgentIndex: 9 },
      { runCount: 1, agentCount: 0 },
    );

    expect(state).toEqual({ focus: "runs", selectedRunIndex: 0, selectedAgentIndex: 0 });
  });
});
