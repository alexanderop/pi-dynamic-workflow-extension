import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempWorkflowDir } from "../../suite/tmpdir.ts";
import {
  readWorkflowFeatureConfig,
  writeWorkflowFeatureConfig,
} from "#src/extension/features/config.ts";

let tempDir: string;

beforeEach(async () => {
  tempDir = await tempWorkflowDir("pi-workflow-feature-config-");
});

describe("workflow feature config files", () => {
  it("should preserve unknown top-level and feature keys when writing known features", async () => {
    const path = join(tempDir, "dynamic-workflows.json");
    await writeFile(
      path,
      JSON.stringify({
        comment: "keep me",
        features: { experimentalModelRouting: false, futureFlag: true },
      }),
      "utf8",
    );

    const written = await writeWorkflowFeatureConfig(path, {
      experimentalModelRouting: true,
    });
    expect(written).toEqual({ status: "ok", value: undefined });

    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw).toEqual({
      comment: "keep me",
      features: { experimentalModelRouting: true, futureFlag: true },
    });

    const read = await readWorkflowFeatureConfig(path, "user");
    expect(read).toEqual({
      features: { experimentalModelRouting: true },
      warnings: [],
    });
  });

  it("should warn and continue when a config file is invalid", async () => {
    const path = join(tempDir, "invalid.json");
    await mkdir(tempDir, { recursive: true });
    await writeFile(path, "not json", "utf8");

    await expect(readWorkflowFeatureConfig(path, "project")).resolves.toEqual({
      features: {},
      warnings: [expect.stringContaining("project workflow feature config")],
    });
  });
});
