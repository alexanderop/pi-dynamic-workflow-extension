import { describe, expect, it } from "vitest";
import { array, assert, dictionary, integer, jsonValue, property, string } from "fast-check";
import { canonicalJson, computeWorkflowAgentKey } from "#src/workflows/journal/key.ts";
import type { JsonValue } from "fast-check";

const propertyRuns = { numRuns: 200 };

const jsonObjectArbitrary = dictionary(
  string({ unit: "grapheme", minLength: 1, maxLength: 16 }).map((key) => `k:${key}`),
  jsonValue({ maxDepth: 3 }),
  { maxKeys: 20 },
);

describe("journal key properties", () => {
  it("should canonicalize JSON values idempotently", () => {
    assert(
      property(jsonValue({ maxDepth: 4 }), (value) => {
        const canonical = canonicalJson(value);
        const reparsed = JSON.parse(canonical) as JsonValue;

        expect(canonicalJson(reparsed)).toBe(canonical);
      }),
      propertyRuns,
    );
  });

  it("should ignore object insertion order when canonicalizing JSON objects", () => {
    assert(
      property(jsonObjectArbitrary, (object) => {
        const reversed = Object.fromEntries(Object.entries(object).toReversed());

        expect(canonicalJson(reversed)).toBe(canonicalJson(object));
      }),
      propertyRuns,
    );
  });

  it("should produce stable keys for equivalent schema objects with different insertion order", () => {
    assert(
      property(jsonObjectArbitrary, (schemaProperties) => {
        const left = computeWorkflowAgentKey({
          prompt: "scan",
          schema: { type: "object", properties: schemaProperties },
          label: "scan",
          phase: "Scan",
          agentType: "general-purpose",
          model: "default",
          cwd: "/repo",
        });
        const right = computeWorkflowAgentKey({
          prompt: "scan",
          schema: {
            properties: Object.fromEntries(Object.entries(schemaProperties).toReversed()),
            type: "object",
          },
          label: "scan",
          phase: "Scan",
          agentType: "general-purpose",
          model: "default",
          cwd: "/repo",
        });

        expect(right).toBe(left);
      }),
      propertyRuns,
    );
  });

  it("should reject cyclic values before canonicalization", () => {
    assert(
      property(array(jsonValue({ maxDepth: 2 }), { maxLength: 20 }), (items) => {
        const cyclic: Record<string, unknown> = { items };
        cyclic.self = cyclic;

        expect(() => canonicalJson(cyclic)).toThrow(/acyclic/);
      }),
      propertyRuns,
    );
  });

  it("should reject non-finite numbers before canonicalization", () => {
    assert(
      property(integer({ min: 0, max: 2 }), (index) => {
        const value = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY][index]!;

        expect(() => canonicalJson(value)).toThrow(/finite/);
      }),
      propertyRuns,
    );
  });
});
