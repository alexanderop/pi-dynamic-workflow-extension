import { describe, expect, it } from "vitest";
import { assert, asyncProperty, integer, property } from "fast-check";
import {
  calculateDefaultMaxConcurrent,
  WorkflowAgentScheduler,
} from "#src/workflows/agent/scheduler.ts";

const asyncPropertyRuns = { numRuns: 50 };
const propertyRuns = { numRuns: 200 };

describe("workflow agent scheduler properties", () => {
  it("should keep default concurrency between one and sixteen for generated CPU counts", () => {
    assert(
      property(integer({ min: 1, max: 256 }), (cpuCores) => {
        const concurrency = calculateDefaultMaxConcurrent(cpuCores);

        expect(concurrency).toBeGreaterThanOrEqual(1);
        expect(concurrency).toBeLessThanOrEqual(16);
        expect(concurrency).toBe(Math.min(16, Math.max(1, cpuCores - 2)));
      }),
      propertyRuns,
    );
  });

  it("should never exceed the generated concurrency cap", async () => {
    await assert(
      asyncProperty(
        integer({ min: 1, max: 5 }),
        integer({ min: 1, max: 20 }),
        async (maxConcurrent, taskCount) => {
          let running = 0;
          let peak = 0;
          const scheduler = new WorkflowAgentScheduler({
            maxConcurrent,
            runner: async ({ prompt }) => {
              running += 1;
              peak = Math.max(peak, running);
              await delay(0);
              running -= 1;
              return prompt;
            },
          });

          const prompts = Array.from({ length: taskCount }, (_value, index) => `task:${index}`);
          const results = await Promise.all(prompts.map((prompt) => scheduler.schedule(prompt)));

          expect(peak).toBeLessThanOrEqual(maxConcurrent);
          expect(results).toEqual(prompts);
          expect(scheduler.progress()).toHaveLength(taskCount);
          expect(scheduler.progress().every((agent) => agent.state === "done")).toBe(true);
        },
      ),
      asyncPropertyRuns,
    );
  });

  it("should enforce the generated total-agent cap", async () => {
    await assert(
      asyncProperty(integer({ min: 1, max: 20 }), async (maxTotalAgents) => {
        const scheduler = new WorkflowAgentScheduler({
          maxTotalAgents,
          runner: async ({ prompt }) => prompt,
        });

        for (let index = 0; index < maxTotalAgents; index += 1) {
          await expect(scheduler.schedule(`allowed:${index}`)).resolves.toBe(`allowed:${index}`);
        }
        await expect(scheduler.schedule("blocked")).rejects.toThrow(/maxTotalAgents/);
        expect(scheduler.progress()).toHaveLength(maxTotalAgents);
      }),
      asyncPropertyRuns,
    );
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
