export type MonitorScreen = "chooser" | "overview" | "agentDetail" | "promptReader";

export interface MonitorNavigationState {
  readonly screen: MonitorScreen;
  readonly selectedRunIndex: number;
  readonly selectedPhaseIndex: number;
  readonly selectedAgentIndex: number;
}

export interface MonitorBounds {
  readonly runCount: number;
  readonly phaseCount: number;
  readonly agentCount: number;
}

export function initialMonitorNavigation(runCount: number): MonitorNavigationState {
  return {
    screen: runCount === 1 ? "overview" : "chooser",
    selectedRunIndex: 0,
    selectedPhaseIndex: 0,
    selectedAgentIndex: 0,
  };
}

export function moveMonitorSelection(
  state: MonitorNavigationState,
  bounds: MonitorBounds,
  direction: -1 | 1,
): MonitorNavigationState {
  if (state.screen === "chooser") {
    return {
      ...state,
      selectedRunIndex: clampIndex(state.selectedRunIndex + direction, bounds.runCount),
      selectedPhaseIndex: 0,
      selectedAgentIndex: 0,
    };
  }

  if (state.screen === "overview") {
    return {
      ...state,
      selectedPhaseIndex: clampIndex(state.selectedPhaseIndex + direction, bounds.phaseCount),
      selectedAgentIndex: 0,
    };
  }

  if (state.screen === "agentDetail") {
    return {
      ...state,
      selectedAgentIndex: clampIndex(state.selectedAgentIndex + direction, bounds.agentCount),
    };
  }

  // The prompt reader scrolls within the component, not through selection state.
  return state;
}

export function focusInMonitor(
  state: MonitorNavigationState,
  bounds: MonitorBounds,
  direction: "left" | "right",
): MonitorNavigationState {
  if (state.screen === "overview" && direction === "left" && bounds.agentCount > 0) {
    return { ...state, screen: "agentDetail" };
  }
  if (state.screen === "agentDetail" && direction === "right") {
    return { ...state, screen: "overview" };
  }
  return state;
}

export function enterMonitor(
  state: MonitorNavigationState,
  bounds: MonitorBounds,
): MonitorNavigationState {
  if (state.screen === "chooser") {
    return { ...state, screen: "overview", selectedPhaseIndex: 0, selectedAgentIndex: 0 };
  }
  if (state.screen === "overview" && bounds.agentCount > 0) {
    return { ...state, screen: "agentDetail" };
  }
  if (state.screen === "agentDetail") {
    return { ...state, screen: "promptReader" };
  }
  return state;
}

export interface MonitorEscapeResult {
  readonly state?: MonitorNavigationState;
  readonly close?: boolean;
}

export function escapeMonitor(
  state: MonitorNavigationState,
  bounds: MonitorBounds,
): MonitorEscapeResult {
  if (state.screen === "promptReader") {
    return { state: { ...state, screen: "agentDetail" } };
  }
  if (state.screen === "agentDetail") {
    return { state: { ...state, screen: "overview" } };
  }
  if (state.screen === "overview") {
    return bounds.runCount > 1 ? { state: { ...state, screen: "chooser" } } : { close: true };
  }
  return { close: true };
}

export function clampMonitorNavigation(
  state: MonitorNavigationState,
  bounds: MonitorBounds,
): MonitorNavigationState {
  let screen = state.screen;
  if (screen === "promptReader" && bounds.agentCount === 0) screen = "overview";
  if (screen === "agentDetail" && bounds.agentCount === 0) screen = "overview";

  return {
    screen,
    selectedRunIndex: clampIndex(state.selectedRunIndex, bounds.runCount),
    selectedPhaseIndex: clampIndex(state.selectedPhaseIndex, bounds.phaseCount),
    selectedAgentIndex: clampIndex(state.selectedAgentIndex, bounds.agentCount),
  };
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
