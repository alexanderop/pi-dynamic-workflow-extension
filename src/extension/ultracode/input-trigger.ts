export interface UltracodeTrigger {
  readonly goal: string;
}

const ULTRACODE_EMPTY_TRIGGER = /^[ \t\r\n]*ultracode[ \t\r\n]*$/i;
const ULTRACODE_LEADING_TRIGGER = /^[ \t\r\n]*ultracode\s+([\s\S]*?)\s*$/i;
const ULTRACODE_WORD = /\bultracode\b/i;

export function parseUltracodeInput(text: string): UltracodeTrigger | undefined {
  const leadingMatch = ULTRACODE_LEADING_TRIGGER.exec(text);
  if (leadingMatch !== null) {
    const goal = leadingMatch[1]?.trim();
    if (goal === undefined || goal.length === 0) return undefined;
    return { goal };
  }

  if (!ULTRACODE_WORD.test(text)) return undefined;

  const goal = text.trim();
  if (goal.length === 0 || ULTRACODE_EMPTY_TRIGGER.test(goal)) return undefined;
  return { goal };
}

export function isEmptyUltracodeInput(text: string): boolean {
  return ULTRACODE_EMPTY_TRIGGER.test(text);
}
