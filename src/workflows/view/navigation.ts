import type { WorkflowViewFocus } from "./model.ts";

export interface WorkflowViewNavigationState {
  readonly focus: WorkflowViewFocus;
  readonly selectedRunIndex: number;
  readonly selectedAgentIndex: number;
}

export interface WorkflowViewNavigationBounds {
  readonly runCount: number;
  readonly agentCount: number;
}

export function initialWorkflowViewNavigation(): WorkflowViewNavigationState {
  return {
    focus: "runs",
    selectedRunIndex: 0,
    selectedAgentIndex: 0,
  };
}

export function moveWorkflowViewSelection(
  state: WorkflowViewNavigationState,
  bounds: WorkflowViewNavigationBounds,
  direction: -1 | 1,
): WorkflowViewNavigationState {
  if (state.focus === "agents") {
    return {
      ...state,
      selectedAgentIndex: clampIndex(state.selectedAgentIndex + direction, bounds.agentCount),
    };
  }

  if (state.focus === "runs") {
    return {
      ...state,
      selectedRunIndex: clampIndex(state.selectedRunIndex + direction, bounds.runCount),
      selectedAgentIndex: 0,
    };
  }

  return state;
}

export function cycleWorkflowViewFocus(
  state: WorkflowViewNavigationState,
  bounds: WorkflowViewNavigationBounds,
): WorkflowViewNavigationState {
  const focusOrder: WorkflowViewFocus[] =
    bounds.agentCount > 0 ? ["runs", "agents", "details"] : ["runs", "details"];
  const currentIndex = Math.max(0, focusOrder.indexOf(state.focus));
  const focus = focusOrder[(currentIndex + 1) % focusOrder.length] ?? "runs";
  return { ...state, focus };
}

export function enterWorkflowViewSelection(
  state: WorkflowViewNavigationState,
  bounds: WorkflowViewNavigationBounds,
): WorkflowViewNavigationState {
  if (state.focus === "runs" && bounds.agentCount > 0) {
    return { ...state, focus: "agents" };
  }

  if (state.focus === "agents") {
    return { ...state, focus: "details" };
  }

  return state;
}

export function clampWorkflowViewNavigation(
  state: WorkflowViewNavigationState,
  bounds: WorkflowViewNavigationBounds,
): WorkflowViewNavigationState {
  return {
    focus: state.focus === "agents" && bounds.agentCount === 0 ? "runs" : state.focus,
    selectedRunIndex: clampIndex(state.selectedRunIndex, bounds.runCount),
    selectedAgentIndex: clampIndex(state.selectedAgentIndex, bounds.agentCount),
  };
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
