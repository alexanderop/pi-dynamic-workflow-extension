import { describe, expect, it } from "vitest";
import { array, assert, integer, property } from "fast-check";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  headerSummaryLine,
  padTo,
  truncateEllipsis,
  twoPaneBox,
  wordWrap,
} from "#src/workflows/view/layout.ts";

const propertyRuns = { numRuns: 200 };

const printableAsciiText = array(integer({ min: 32, max: 126 }), { maxLength: 200 }).map((codes) =>
  codes.map((code) => String.fromCharCode(code)).join(""),
);

describe("layout properties", () => {
  it("should never let truncated text exceed the requested width", () => {
    assert(
      property(printableAsciiText, integer({ min: 0, max: 120 }), (text, width) => {
        const truncated = truncateEllipsis(text, width);

        expect(visibleWidth(truncated)).toBeLessThanOrEqual(width);
      }),
      propertyRuns,
    );
  });

  it("should pad text to exactly the requested visible width", () => {
    assert(
      property(printableAsciiText, integer({ min: 1, max: 120 }), (text, width) => {
        const padded = padTo(text, width);

        expect(visibleWidth(padded)).toBe(width);
      }),
      propertyRuns,
    );
  });

  it("should keep header summary lines within the requested width", () => {
    assert(
      property(
        printableAsciiText,
        printableAsciiText,
        integer({ min: 1, max: 160 }),
        (left, right, width) => {
          const line = headerSummaryLine(left, right, width);

          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        },
      ),
      propertyRuns,
    );
  });

  it("should build two-pane boxes where every line equals the requested width", () => {
    assert(
      property(
        printableAsciiText,
        printableAsciiText,
        array(printableAsciiText, { maxLength: 20 }),
        array(printableAsciiText, { maxLength: 20 }),
        integer({ min: 20, max: 160 }),
        integer({ min: 1, max: 60 }),
        (leftTitle, rightTitle, leftLines, rightLines, width, requestedLeftWidth) => {
          const lines = twoPaneBox({
            leftTitle,
            rightTitle,
            leftLines,
            rightLines,
            leftWidth: requestedLeftWidth,
            width,
          });

          expect(lines.length).toBeGreaterThanOrEqual(2);
          expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
        },
      ),
      propertyRuns,
    );
  });

  it("should wrap plain text without losing characters or exceeding width", () => {
    assert(
      property(printableAsciiText, integer({ min: 1, max: 80 }), (text, width) => {
        const lines = wordWrap(text, width);

        expect(lines.join("")).toBe(text);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }),
      propertyRuns,
    );
  });
});
