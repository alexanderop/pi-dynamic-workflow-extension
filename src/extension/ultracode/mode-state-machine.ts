export type UltracodeModeState =
  | { readonly state: "off" }
  | {
      readonly state: "arming";
      readonly activatedBy: string;
      readonly goal: string;
    }
  | {
      readonly state: "on";
      readonly activatedBy: string;
      readonly goal: string;
    }
  | {
      readonly state: "disabled";
      readonly reason?: string;
    };

export type UltracodeModeEvent =
  | {
      readonly type: "valid_trigger";
      readonly goal: string;
      readonly activatedBy: string;
    }
  | { readonly type: "policy_injected" }
  | { readonly type: "session_shutdown" }
  | { readonly type: "disable"; readonly reason?: string }
  | { readonly type: "restore"; readonly state: UltracodeModeState };

export const ULTRACODE_MODE_OFF: UltracodeModeState = { state: "off" };

export function transitionUltracodeMode(
  current: UltracodeModeState,
  event: UltracodeModeEvent,
): UltracodeModeState {
  switch (event.type) {
    case "valid_trigger":
      if (current.state === "disabled") return current;
      return {
        state: "on",
        activatedBy: event.activatedBy,
        goal: event.goal,
      };
    case "policy_injected":
      if (current.state !== "arming") return current;
      return {
        state: "on",
        activatedBy: current.activatedBy,
        goal: current.goal,
      };
    case "session_shutdown":
      return ULTRACODE_MODE_OFF;
    case "disable":
      return {
        state: "disabled",
        reason: event.reason,
      };
    case "restore":
      return event.state;
  }
}

export function isUltracodeModeActive(state: UltracodeModeState): boolean {
  return state.state === "arming" || state.state === "on";
}
