import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_FEATURE_SESSION_ENTRY_TYPE,
  resolveWorkflowFeatures,
} from "#src/extension/features/resolve.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-feature-resolve-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("resolveWorkflowFeatures", () => {
  it("should resolve feature sources by precedence and record the winning decision", async () => {
    const userConfigPath = join(tempDir, "user.json");
    const projectConfigPath = join(tempDir, "project.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({ features: { experimentalModelRouting: true } }),
      "utf8",
    );
    await writeFile(
      projectConfigPath,
      JSON.stringify({ features: { experimentalModelRouting: false } }),
      "utf8",
    );
    const events = {
      emit: vi.fn<(event: string, payload: unknown) => void>((event, payload) => {
        expect(event).toBe("dynamic-workflows:features:resolve");
        (
          payload as {
            set: (key: "experimentalModelRouting", value: boolean, source: string) => void;
          }
        ).set("experimentalModelRouting", true, "test-policy");
      }),
    };

    const resolved = await resolveWorkflowFeatures({
      cwd: tempDir,
      workflowRoot: join(tempDir, ".pi", "workflows"),
      userConfigPath,
      projectConfigPath,
      env: { PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING: "0" },
      cliFlags: { "workflow-experimental-model-routing": true },
      sessionEntries: [
        {
          type: "custom",
          customType: WORKFLOW_FEATURE_SESSION_ENTRY_TYPE,
          data: { key: "experimentalModelRouting", action: "disable" },
        },
      ],
      overrides: { experimentalModelRouting: true },
      events,
    });

    expect(events.emit).toHaveBeenCalledOnce();
    expect(resolved).toEqual({
      features: { experimentalModelRouting: true },
      decisions: [
        {
          key: "experimentalModelRouting",
          value: true,
          source: "override",
        },
      ],
      warnings: [],
    });
  });

  it("should ignore invalid env values with a warning and let later session reset reveal config", async () => {
    const userConfigPath = join(tempDir, "user.json");
    const projectConfigPath = join(tempDir, "project.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({ features: { experimentalModelRouting: true } }),
      "utf8",
    );

    const resolved = await resolveWorkflowFeatures({
      cwd: tempDir,
      workflowRoot: join(tempDir, ".pi", "workflows"),
      userConfigPath,
      projectConfigPath,
      env: { PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING: "maybe" },
      sessionEntries: [
        {
          type: "custom",
          customType: WORKFLOW_FEATURE_SESSION_ENTRY_TYPE,
          data: { key: "experimentalModelRouting", action: "disable" },
        },
        {
          type: "custom",
          customType: WORKFLOW_FEATURE_SESSION_ENTRY_TYPE,
          data: { key: "experimentalModelRouting", action: "reset" },
        },
      ],
    });

    expect(resolved.features.experimentalModelRouting).toBe(true);
    expect(resolved.decisions).toEqual([
      { key: "experimentalModelRouting", value: true, source: "user", detail: userConfigPath },
    ]);
    expect(resolved.warnings).toEqual([
      expect.stringContaining("PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING"),
    ]);
  });
});
