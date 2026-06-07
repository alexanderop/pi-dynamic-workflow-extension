import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKFLOW_FEATURE_SESSION_ENTRY_TYPE } from "#src/extension/features/resolve.ts";
import { buildWorkflowLaunchOptions } from "#src/extension/workflow-launch-options.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-launch-options-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("buildWorkflowLaunchOptions", () => {
  it("should carry resolved workflow features from config, CLI, and session sources", async () => {
    const rootDir = join(tempDir, ".pi", "workflows");
    const userConfigPath = join(tempDir, "user.json");
    const projectConfigPath = join(rootDir, "config.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({ features: { experimentalModelRouting: true } }),
    );

    const options = await buildWorkflowLaunchOptions(
      {
        cwd: tempDir,
        featureConfigPaths: { userConfigPath, projectConfigPath },
        env: { PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING: "0" },
        sessionManager: {
          getSessionId: () => "session_current",
          getEntries: () => [
            {
              type: "custom",
              customType: WORKFLOW_FEATURE_SESSION_ENTRY_TYPE,
              data: { key: "experimentalModelRouting", action: "enable" },
            },
          ],
        },
      },
      {
        getFlag: (name) => name === "workflow-experimental-model-routing",
        getThinkingLevel: () => "high",
      },
      { rootDir, triggerSource: "manual" },
    );

    expect(options.features).toEqual({ experimentalModelRouting: true });
    expect(options.featureDecisions).toEqual([
      { key: "experimentalModelRouting", value: true, source: "session" },
    ]);
    expect(options.sessionId).toBe("session_current");
    expect(options.defaultThinkingLevel).toBe("high");
  });
});
