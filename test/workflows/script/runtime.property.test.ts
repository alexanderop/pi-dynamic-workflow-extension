import { describe, expect, it } from "vitest";
import { array, assert, asyncProperty, boolean, integer } from "fast-check";
import { parallel, pipeline } from "#src/workflows/script/runtime.ts";

const propertyRuns = { numRuns: 100 };

describe("workflow runtime helper properties", () => {
  it("should preserve input order for generated parallel thunk results", async () => {
    await assert(
      asyncProperty(array(integer(), { maxLength: 20 }), async (values) => {
        const results = await parallel(
          values.map((value, index) => async () => {
            await delay(values.length - index);
            return value;
          }),
        );

        expect(results).toEqual(values);
      }),
      propertyRuns,
    );
  });

  it("should resolve generated throwing parallel thunks to null without dropping siblings", async () => {
    await assert(
      asyncProperty(array(boolean(), { maxLength: 20 }), async (shouldThrowByIndex) => {
        const results = await parallel(
          shouldThrowByIndex.map((shouldThrow, index) => async () => {
            if (shouldThrow) throw new Error(`boom:${index}`);
            return index;
          }),
        );

        expect(results).toEqual(
          shouldThrowByIndex.map((shouldThrow, index) => (shouldThrow ? null : index)),
        );
      }),
      propertyRuns,
    );
  });

  it("should keep pipeline output length equal to the generated input length", async () => {
    await assert(
      asyncProperty(array(integer(), { maxLength: 20 }), async (items) => {
        const results = await pipeline(
          items,
          async (_previous, item, index) => ({ item, index }),
          async (previous) => previous,
        );

        expect(results).toHaveLength(items.length);
        expect(results).toEqual(items.map((item, index) => ({ item, index })));
      }),
      propertyRuns,
    );
  });

  it("should stop later pipeline stages for generated failed items only", async () => {
    await assert(
      asyncProperty(array(boolean(), { maxLength: 20 }), async (shouldFailByIndex) => {
        const laterStageIndexes: number[] = [];
        const results = await pipeline(
          shouldFailByIndex,
          async (_previous, shouldFail, index) => {
            if (shouldFail) throw new Error(`failed:${index}`);
            return index;
          },
          async (previous, _item, index) => {
            laterStageIndexes.push(index);
            return previous;
          },
        );

        expect(results).toEqual(
          shouldFailByIndex.map((shouldFail, index) => (shouldFail ? null : index)),
        );
        expect(laterStageIndexes).toEqual(
          shouldFailByIndex.flatMap((shouldFail, index) => (shouldFail ? [] : [index])),
        );
      }),
      propertyRuns,
    );
  });

  it("should reject generated non-thunk inputs passed to parallel", async () => {
    await assert(
      asyncProperty(array(integer(), { minLength: 1, maxLength: 20 }), async (values) => {
        const startedPromises = values.map((value) => Promise.resolve(value));

        await expect(parallel(startedPromises as any)).rejects.toThrow(/thunks/);
      }),
      propertyRuns,
    );
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
