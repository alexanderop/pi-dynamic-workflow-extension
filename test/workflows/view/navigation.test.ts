import { describe, expect, it } from "vitest";
import {
  clampMonitorNavigation,
  enterMonitor,
  escapeMonitor,
  focusInMonitor,
  initialMonitorNavigation,
  moveMonitorSelection,
  type MonitorBounds,
  type MonitorNavigationState,
} from "#src/workflows/view/navigation.ts";

const bounds = (overrides: Partial<MonitorBounds> = {}): MonitorBounds => ({
  runCount: 1,
  phaseCount: 2,
  agentCount: 3,
  ...overrides,
});

const state = (overrides: Partial<MonitorNavigationState> = {}): MonitorNavigationState => ({
  screen: "overview",
  selectedRunIndex: 0,
  selectedPhaseIndex: 0,
  selectedAgentIndex: 0,
  ...overrides,
});

describe("monitor navigation", () => {
  it("should start at overview for one active workflow and chooser for many", () => {
    expect(initialMonitorNavigation(1).screen).toBe("overview");
    expect(initialMonitorNavigation(2).screen).toBe("chooser");
    expect(initialMonitorNavigation(0).screen).toBe("chooser");
  });

  it("should move the phase selection in the overview and reset the agent index", () => {
    const next = moveMonitorSelection(state({ selectedAgentIndex: 2 }), bounds(), 1);

    expect(next.selectedPhaseIndex).toBe(1);
    expect(next.selectedAgentIndex).toBe(0);
    expect(moveMonitorSelection(next, bounds(), 1).selectedPhaseIndex).toBe(1);
  });

  it("should open agent detail from overview with left when agents exist", () => {
    expect(focusInMonitor(state(), bounds(), "left").screen).toBe("agentDetail");
    expect(focusInMonitor(state(), bounds({ agentCount: 0 }), "left").screen).toBe("overview");
  });

  it("should return to overview from agent detail with right", () => {
    expect(focusInMonitor(state({ screen: "agentDetail" }), bounds(), "right").screen).toBe(
      "overview",
    );
  });

  it("should move the agent selection in the detail view", () => {
    const next = moveMonitorSelection(state({ screen: "agentDetail" }), bounds(), 1);

    expect(next.selectedAgentIndex).toBe(1);
    expect(moveMonitorSelection(next, bounds({ agentCount: 2 }), 1).selectedAgentIndex).toBe(1);
  });

  it("should open the prompt reader from detail with enter", () => {
    const next = enterMonitor(state({ screen: "agentDetail" }), bounds());

    expect(next.screen).toBe("promptReader");
  });

  it("should walk back chooser to overview to detail to prompt and esc to unwind", () => {
    const many = bounds({ runCount: 2 });
    expect(escapeMonitor(state({ screen: "promptReader" }), many).state?.screen).toBe(
      "agentDetail",
    );
    expect(escapeMonitor(state({ screen: "agentDetail" }), many).state?.screen).toBe("overview");
    expect(escapeMonitor(state({ screen: "overview" }), many).state?.screen).toBe("chooser");
    expect(escapeMonitor(state({ screen: "overview" }), bounds({ runCount: 1 })).close).toBe(true);
    expect(escapeMonitor(state({ screen: "chooser" }), many).close).toBe(true);
  });

  it("should select a run from the chooser and open overview on enter", () => {
    const chooser = state({ screen: "chooser", selectedPhaseIndex: 3, selectedAgentIndex: 4 });
    const moved = moveMonitorSelection(chooser, bounds({ runCount: 3 }), 1);
    expect(moved.selectedRunIndex).toBe(1);

    const opened = enterMonitor(moved, bounds({ runCount: 3 }));
    expect(opened.screen).toBe("overview");
    expect(opened.selectedPhaseIndex).toBe(0);
    expect(opened.selectedAgentIndex).toBe(0);
  });

  it("should clamp stale monitor selections after the run list refreshes", () => {
    const stale = state({
      screen: "agentDetail",
      selectedRunIndex: 9,
      selectedPhaseIndex: 9,
      selectedAgentIndex: 9,
    });

    const clamped = clampMonitorNavigation(
      stale,
      bounds({ runCount: 2, phaseCount: 2, agentCount: 0 }),
    );

    expect(clamped.screen).toBe("overview");
    expect(clamped.selectedRunIndex).toBe(1);
    expect(clamped.selectedPhaseIndex).toBe(1);
    expect(clamped.selectedAgentIndex).toBe(0);
  });
});
