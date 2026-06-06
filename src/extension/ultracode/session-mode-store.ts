import { transitionUltracodeMode, type UltracodeModeState } from "./mode-state-machine.ts";

export const ULTRACODE_MODE_CUSTOM_TYPE = "ultracode-mode";
export const ULTRACODE_MODE_ENTRY_VERSION = 1;

export interface UltracodeModeEntryData {
  readonly version: typeof ULTRACODE_MODE_ENTRY_VERSION;
  readonly mode: UltracodeModeState;
}

export interface EntryLike {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export function createUltracodeModeEntryData(mode: UltracodeModeState): UltracodeModeEntryData {
  return {
    version: ULTRACODE_MODE_ENTRY_VERSION,
    mode,
  };
}

export function restoreUltracodeModeFromEntries(
  entries: readonly EntryLike[] | undefined,
): UltracodeModeState {
  let mode: UltracodeModeState = { state: "off" };

  for (const entry of entries ?? []) {
    const restored = readUltracodeModeEntry(entry);
    if (restored === undefined) continue;
    mode = transitionUltracodeMode(mode, { type: "restore", state: restored });
  }

  return mode;
}

function readUltracodeModeEntry(entry: EntryLike): UltracodeModeState | undefined {
  if (entry.type !== "custom" || entry.customType !== ULTRACODE_MODE_CUSTOM_TYPE) {
    return undefined;
  }

  const data = entry.data;
  if (!isObject(data) || data.version !== ULTRACODE_MODE_ENTRY_VERSION) {
    return undefined;
  }

  const mode = data.mode;
  if (!isObject(mode) || typeof mode.state !== "string") return undefined;

  switch (mode.state) {
    case "off":
      return { state: "off" };
    case "arming":
    case "on":
      if (typeof mode.activatedBy !== "string" || typeof mode.goal !== "string") {
        return undefined;
      }
      return {
        state: mode.state,
        activatedBy: mode.activatedBy,
        goal: mode.goal,
      };
    case "disabled":
      return typeof mode.reason === "string"
        ? { state: "disabled", reason: mode.reason }
        : { state: "disabled" };
    default:
      return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
