export interface UltracodeTrigger {
  readonly goal: string;
}

const ULTRACODE_PREFIX = /^[ \t\r\n]*ultracode(?=\s|$)/i;
const ULTRACODE_TRIGGER = /^[ \t\r\n]*ultracode\s+([\s\S]*?)\s*$/i;

export function parseUltracodeInput(text: string): UltracodeTrigger | undefined {
  const match = ULTRACODE_TRIGGER.exec(text);
  if (match === null) return undefined;

  const goal = match[1]?.trim();
  if (goal === undefined || goal.length === 0) return undefined;

  return { goal };
}

export function isEmptyUltracodeInput(text: string): boolean {
  return ULTRACODE_PREFIX.test(text) && parseUltracodeInput(text) === undefined;
}
