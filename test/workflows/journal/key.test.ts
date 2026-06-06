import { describe, expect, it } from "vitest";
import { canonicalJson, computeWorkflowAgentKey } from "#src/workflows/journal/key.ts";

const baseInput = {
  prompt: "review src",
  schema: { type: "object", properties: { ok: { type: "boolean" } } },
  label: "review:src",
  phase: "Review",
  agentType: "general-purpose",
  model: "claude-opus-4-8",
  cwd: "/repo",
};

describe("computeWorkflowAgentKey", () => {
  it("should produce a v2 sha256-width key for an effective agent call", () => {
    expect(computeWorkflowAgentKey(baseInput)).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it("should return the same key when object fields use different insertion order", () => {
    const left = computeWorkflowAgentKey({
      ...baseInput,
      schema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
    });
    const right = computeWorkflowAgentKey({
      ...baseInput,
      schema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" },
    });

    expect(left).toBe(right);
  });

  it("should change the key when effective call inputs change", () => {
    const original = computeWorkflowAgentKey(baseInput);

    expect(computeWorkflowAgentKey({ ...baseInput, prompt: "review tests" })).not.toBe(original);
    expect(computeWorkflowAgentKey({ ...baseInput, schema: { type: "string" } })).not.toBe(
      original,
    );
    expect(computeWorkflowAgentKey({ ...baseInput, label: "review:tests" })).not.toBe(original);
    expect(computeWorkflowAgentKey({ ...baseInput, phase: "Verify" })).not.toBe(original);
    expect(computeWorkflowAgentKey({ ...baseInput, agentType: "security-reviewer" })).not.toBe(
      original,
    );
    expect(computeWorkflowAgentKey({ ...baseInput, model: "claude-haiku" })).not.toBe(original);
    expect(computeWorkflowAgentKey({ ...baseInput, cwd: "/other" })).not.toBe(original);
  });
});

describe("canonicalJson", () => {
  it("should reject cyclic values before hashing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(cyclic)).toThrow(/acyclic/);
  });

  it("should reject non-finite numbers", () => {
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite/);
  });

  it("should accept finite numbers and primitive scalars", () => {
    expect(canonicalJson({ n: 1, s: "x", b: true, z: null })).toBe(
      JSON.stringify({ b: true, n: 1, s: "x", z: null }),
    );
  });

  it("should reject bigint values that are not JSON serializable", () => {
    expect(() => canonicalJson({ count: 1n })).toThrow(/bigint/);
  });

  it("should normalize function and symbol object values to null", () => {
    expect(
      canonicalJson({
        b: () => undefined,
        c: Symbol("s"),
        d: "keep",
      }),
    ).toBe(JSON.stringify({ b: null, c: null, d: "keep" }));
  });

  it("should normalize undefined, function, and symbol array items to null", () => {
    expect(canonicalJson([undefined, () => undefined, Symbol("s"), "keep"])).toBe(
      JSON.stringify([null, null, null, "keep"]),
    );
  });

  it("should canonicalize nested array and object values", () => {
    expect(canonicalJson([{ b: 2, a: 1 }, true, null])).toBe(
      JSON.stringify([{ a: 1, b: 2 }, true, null]),
    );
  });
});

describe("computeWorkflowAgentKey optional fields", () => {
  it("should default missing optional fields to null in the preimage", () => {
    expect(
      computeWorkflowAgentKey({
        prompt: "p",
        agentType: "general-purpose",
        model: "m",
        cwd: "/repo",
      }),
    ).toMatch(/^v2:[0-9a-f]{64}$/);
  });
});
