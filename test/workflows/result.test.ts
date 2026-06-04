import { describe, expect, it } from "vitest";
import { err, isErr, isOk, match, ok, tryPromise, tryResult } from "../../src/workflows/result.ts";

describe("Result", () => {
  it("represents success and error as return values", () => {
    const success = ok(42);
    const failure = err(new Error("boom"));

    expect(isOk(success)).toBe(true);
    expect(isErr(failure)).toBe(true);
    expect(match(success, { ok: (value) => value + 1, err: () => 0 })).toBe(43);
  });

  it("captures thrown sync and async failures with caller-defined error types", async () => {
    const parsed = tryResult(
      () => JSON.parse("{"),
      (cause) => ({
        _tag: "JsonParseError" as const,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    const loaded = await tryPromise(
      async () => {
        throw new Error("missing");
      },
      (cause) => ({
        _tag: "LoadError" as const,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );

    expect(parsed).toMatchObject({ status: "error", error: { _tag: "JsonParseError" } });
    expect(loaded).toMatchObject({ status: "error", error: { _tag: "LoadError" } });
  });
});
