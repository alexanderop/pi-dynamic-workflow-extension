/**
 * Pure, TUI-agnostic value formatters for workflow views.
 *
 * ADR 0010 keeps `src/workflows/view/` free of Pi TUI dependencies so it can be
 * unit-tested without a terminal. Column-aware rendering helpers that need
 * terminal width measurement live in `src/extension/tui/layout.ts` instead.
 */

/** Compact token count, e.g. `900`, `41.1k`, `266.1k`. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const thousands = Math.floor(count / 100) / 10;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return formatSeconds(Math.floor(durationMs / 1000));
}

/** Idle duration in the same minute/second shape, flooring sub-second to `0s`. */
export function formatIdle(durationMs: number): string {
  return formatSeconds(Math.floor(Math.max(0, durationMs) / 1000));
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m ${seconds}s`;

  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}
