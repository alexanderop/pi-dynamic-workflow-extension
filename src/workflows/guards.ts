/**
 * Shared single-purpose guards for the workflow domain (sibling to result.ts,
 * the precedent for small shared modules). These helpers were previously
 * copy-pasted per module; one home means a reader never has to diff
 * near-identical local copies to find out whether a divergence is intentional.
 */

/**
 * Plain-object guard. Arrays are excluded: every caller feeds JSON-derived
 * values and then reads named properties, which a JSON array can never carry,
 * so the stricter check is behavior-equivalent where the looser copies lived.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (hasMessage(cause)) return cause.message;
  return String(cause);
}

export function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}
