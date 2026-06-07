import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("packaged workflow debugger skill", () => {
  it("should declare the skills directory in the Pi package manifest", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      readonly pi?: { readonly skills?: readonly string[] };
    };

    expect(packageJson.pi?.skills).toContain("./skills");
  });

  it("should include valid trigger metadata and debugging guidance", async () => {
    const skill = await readFile(join("skills", "workflow-debugger", "SKILL.md"), "utf8");
    const frontmatter = parseFrontmatter(skill);
    const description = frontmatterValue(frontmatter, "description");

    expect(frontmatterValue(frontmatter, "name")).toBe("workflow-debugger");
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain("workflow failed");
    expect(description).toContain(".pi/workflows/wf_*");
    expect(skill).toContain("Read `manifest.json` first");
    expect(skill).toContain("workflowRootDirForCwd(...)");
    expect(skill).toContain("structured_output");
    expect(skill).toContain("Completed run with failed branch");
  });
});

function parseFrontmatter(markdown: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (match === null) throw new Error("SKILL.md must start with YAML frontmatter.");
  return match[1] ?? "";
}

function frontmatterValue(frontmatter: string, key: string): string {
  const prefix = `${key}:`;
  const line = frontmatter.split("\n").find((entry) => entry.startsWith(prefix));
  return line?.slice(prefix.length).trim() ?? "";
}
