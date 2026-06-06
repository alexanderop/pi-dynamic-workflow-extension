import { describe, expect, it } from "vitest";
import { array, assert, constantFrom, integer, property, record } from "fast-check";
import {
  clampMonitorNavigation,
  enterMonitor,
  escapeMonitor,
  focusInMonitor,
  initialMonitorNavigation,
  moveMonitorSelection,
} from "#src/workflows/view/navigation.ts";
import type {
  MonitorBounds,
  MonitorNavigationState,
  MonitorScreen,
} from "#src/workflows/view/navigation.ts";

const propertyRuns = { numRuns: 200 };

const screenArbitrary = constantFrom<MonitorScreen>(
  "chooser",
  "overview",
  "agentDetail",
  "promptReader",
);
const boundsArbitrary = record({
  runCount: integer({ min: 0, max: 20 }),
  phaseCount: integer({ min: 0, max: 20 }),
  agentCount: integer({ min: 0, max: 20 }),
});
const navigationStateArbitrary = record({
  screen: screenArbitrary,
  selectedRunIndex: integer({ min: -20, max: 40 }),
  selectedPhaseIndex: integer({ min: -20, max: 40 }),
  selectedAgentIndex: integer({ min: -20, max: 40 }),
});
const operationArbitrary = constantFrom<"up" | "down" | "left" | "right" | "enter" | "escape">(
  "up",
  "down",
  "left",
  "right",
  "enter",
  "escape",
);

describe("monitor navigation properties", () => {
  it("should choose the initial monitor screen from the number of runs", () => {
    assert(
      property(integer({ min: 0, max: 20 }), (runCount) => {
        const state = initialMonitorNavigation(runCount);

        expect(state.screen).toBe(runCount === 1 ? "overview" : "chooser");
        expect(state.selectedRunIndex).toBe(0);
        expect(state.selectedPhaseIndex).toBe(0);
        expect(state.selectedAgentIndex).toBe(0);
      }),
      propertyRuns,
    );
  });

  it("should clamp selected indexes into the available bounds", () => {
    assert(
      property(navigationStateArbitrary, boundsArbitrary, (state, bounds) => {
        const clamped = clampMonitorNavigation(state, bounds);

        expectIndexWithin(clamped.selectedRunIndex, bounds.runCount);
        expectIndexWithin(clamped.selectedPhaseIndex, bounds.phaseCount);
        expectIndexWithin(clamped.selectedAgentIndex, bounds.agentCount);
      }),
      propertyRuns,
    );
  });

  it("should not keep agent-only screens when no agents exist", () => {
    assert(
      property(navigationStateArbitrary, boundsArbitrary, (state, bounds) => {
        const clamped = clampMonitorNavigation(state, { ...bounds, agentCount: 0 });

        expect(clamped.screen).not.toBe("agentDetail");
        expect(clamped.screen).not.toBe("promptReader");
      }),
      propertyRuns,
    );
  });

  it("should preserve navigation invariants after arbitrary operation sequences", () => {
    assert(
      property(
        navigationStateArbitrary,
        boundsArbitrary,
        array(operationArbitrary, { maxLength: 30 }),
        (initialState, bounds, operations) => {
          let state = clampMonitorNavigation(initialState, bounds);

          for (const operation of operations) {
            state = applyOperation(state, bounds, operation);
            state = clampMonitorNavigation(state, bounds);

            expectIndexWithin(state.selectedRunIndex, bounds.runCount);
            expectIndexWithin(state.selectedPhaseIndex, bounds.phaseCount);
            expectIndexWithin(state.selectedAgentIndex, bounds.agentCount);
            expect(
              bounds.agentCount !== 0 ||
                (state.screen !== "agentDetail" && state.screen !== "promptReader"),
            ).toBe(true);
          }
        },
      ),
      propertyRuns,
    );
  });
});

function applyOperation(
  state: MonitorNavigationState,
  bounds: MonitorBounds,
  operation: "up" | "down" | "left" | "right" | "enter" | "escape",
): MonitorNavigationState {
  switch (operation) {
    case "up":
      return moveMonitorSelection(state, bounds, -1);
    case "down":
      return moveMonitorSelection(state, bounds, 1);
    case "left":
      return focusInMonitor(state, bounds, "left");
    case "right":
      return focusInMonitor(state, bounds, "right");
    case "enter":
      return enterMonitor(state, bounds);
    case "escape":
      return escapeMonitor(state, bounds).state ?? state;
  }
}

function expectIndexWithin(index: number, length: number): void {
  expect(indexWithin(index, length)).toBe(true);
}

function indexWithin(index: number, length: number): boolean {
  return length <= 0 ? index === 0 : index >= 0 && index < length;
}
