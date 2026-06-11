import { describe, expect, it } from "vitest";
import { toTaskNotification } from "#src/workflows/launch/notification.ts";
import { workflowRun } from "../../builders/workflow-run.ts";

describe("toTaskNotification", () => {
  const outputPath = "/tmp/wf_test/wf_test/output.json";

  describe("inline result truncation", () => {
    it("should keep a head, a tail, and a gap marker within the char budget", () => {
      const maxChars = 300;
      const head = "HEAD_MARKER_START";
      const tail = "TAIL_SYNTHESIS_END";
      const result = `${head}${"x".repeat(2000)}${tail}`;

      const state = workflowRun.completed("trunc", { result, outputPath });
      const notification = toTaskNotification(state, outputPath, "trunc", maxChars);
      const inline = notification.details.result;

      expect(inline.length).toBeLessThanOrEqual(maxChars);
      // Head is preserved (synthesis context start).
      expect(inline).toContain(head);
      // Tail is preserved (synthesis lives at the end).
      expect(inline).toContain(tail);
      // Gap marker states omitted chars and points to the full file.
      expect(inline).toContain("truncated");
      expect(inline).toContain("chars");
      expect(inline).toContain(outputPath);
    });

    it("should bias the kept content toward the tail", () => {
      const maxChars = 400;
      const result = "x".repeat(5000);

      const state = workflowRun.completed("bias", { result, outputPath });
      const inline = toTaskNotification(state, outputPath, "bias", maxChars).details.result;

      const marker = inline.indexOf("\n[…");
      expect(marker).toBeGreaterThan(0);
      const head = inline.slice(0, marker);
      const tail = inline.slice(inline.indexOf("…]\n") + "…]\n".length);

      // ~40% head / ~60% tail split of the content budget.
      expect(tail.length).toBeGreaterThan(head.length);
    });

    it("should return the result unchanged when it fits within the budget", () => {
      const result = "short result";
      const state = workflowRun.completed("fits", { result, outputPath });

      const inline = toTaskNotification(state, outputPath, "fits", 4000).details.result;

      expect(inline).toBe(result);
    });

    it("should fall back to a bounded slice when maxChars is too small for head+marker+tail", () => {
      const result = "x".repeat(2000);
      const state = workflowRun.completed("tiny", { result, outputPath });

      const inline = toTaskNotification(state, outputPath, "tiny", 20).details.result;

      expect(inline.length).toBeLessThanOrEqual(20);
    });
  });

  describe("XML escaping of the result text node", () => {
    it("should escape & and < but leave quotes raw", () => {
      const result = `a "double" and 'single' with <tag> & ampersand`;
      const state = workflowRun.completed("esc", { result, outputPath });

      const content = toTaskNotification(state, outputPath, "esc", 4000).content;

      // Quotes are not entity-encoded in a text node.
      expect(content).not.toContain("&quot;");
      expect(content).not.toContain("&apos;");
      expect(content).toContain(`"double"`);
      expect(content).toContain(`'single'`);
      // `<` and `&` are still escaped.
      expect(content).toContain("&lt;tag&gt;");
      expect(content).toContain("&amp; ampersand");
    });
  });
});
