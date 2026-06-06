import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Truncate `text` to `width`, appending `…` when it would overflow. */
export function truncateEllipsis(text: string, width: number): string {
  if (width < 1) return "";
  if (visibleWidth(text) <= width) return text;
  return `${truncateToWidth(text, Math.max(0, width - 1), "")}…`;
}

/** Truncate then right-pad with spaces so the result is exactly `width` wide. */
export function padTo(text: string, width: number): string {
  const truncated = truncateEllipsis(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** A single line with `left` flush-left and `right` flush-right within `width`. */
export function headerSummaryLine(left: string, right: string, width: number): string {
  const clampedRight = truncateEllipsis(right, width);
  const rightWidth = visibleWidth(clampedRight);
  if (rightWidth >= width) return clampedRight;
  const leftMax = Math.max(0, width - rightWidth - 1);
  return `${padTo(left, leftMax)} ${clampedRight}`;
}

// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Wrap `text` to `width`-wide lines, preserving every character (including
 * newlines as separate entries). A token wider than `width` is hard-broken; a
 * grapheme that cannot fit at all is still emitted so no character is lost.
 */
export function wordWrap(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const result: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let remaining = rawLine;
    if (remaining === "") {
      result.push("");
      continue;
    }
    while (visibleWidth(remaining) > safeWidth) {
      const head = stripAnsi(truncateToWidth(remaining, safeWidth, ""));
      if (head.length === 0) {
        const grapheme = [...remaining][0] ?? remaining;
        result.push(grapheme);
        remaining = remaining.slice(grapheme.length);
        continue;
      }
      result.push(head);
      remaining = remaining.slice(head.length);
    }
    if (remaining.length > 0) result.push(remaining);
  }
  return result;
}

export interface TwoPaneBoxOptions {
  readonly leftTitle: string;
  readonly rightTitle: string;
  readonly leftLines: string[];
  readonly rightLines: string[];
  readonly leftWidth: number;
  readonly width: number;
  readonly styleBorder?: (text: string) => string;
}

/** Inner content widths of the two panes for a given total `width`. */
export function paneInnerWidths(
  width: number,
  requestedLeftWidth: number,
): { leftWidth: number; rightWidth: number } {
  const leftWidth = Math.max(1, Math.min(requestedLeftWidth, width - 8));
  return { leftWidth, rightWidth: Math.max(1, width - leftWidth - 7) };
}

/**
 * Render a bordered two-pane box. Every produced line has a visible width
 * exactly equal to `width`; pane content is truncated, never wrapped across the
 * divider. `leftWidth` is the inner content width of the left pane.
 */
export function twoPaneBox(options: TwoPaneBoxOptions): string[] {
  const { leftTitle, rightTitle, leftLines, rightLines, width } = options;
  const { leftWidth, rightWidth } = paneInnerWidths(width, options.leftWidth);
  const border = options.styleBorder ?? ((text: string): string => text);

  const top = `${border("┌")}${titleSegment(leftTitle, leftWidth + 2, border)}${border("┬")}${titleSegment(rightTitle, rightWidth + 2, border)}${border("┐")}`;
  const bottom = `${border("└")}${border("─".repeat(leftWidth + 2))}${border("┴")}${border("─".repeat(rightWidth + 2))}${border("┘")}`;

  const rowCount = Math.max(leftLines.length, rightLines.length);
  const body: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const left = padTo(leftLines[index] ?? "", leftWidth);
    const right = padTo(rightLines[index] ?? "", rightWidth);
    body.push(`${border("│")} ${left} ${border("│")} ${right} ${border("│")}`);
  }

  return [top, ...body, bottom];
}

/** A `┌`/`┬`-adjacent border segment: ` title ` then `─` fill to `segmentWidth`. */
export function titleSegment(
  title: string,
  segmentWidth: number,
  styleFill: (text: string) => string = (text) => text,
): string {
  const label = ` ${title} `;
  if (visibleWidth(label) >= segmentWidth) return truncateToWidth(label, segmentWidth, "");
  return label + styleFill("─".repeat(segmentWidth - visibleWidth(label)));
}

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
