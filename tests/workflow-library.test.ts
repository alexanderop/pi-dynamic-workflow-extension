import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileWorkflowLibrary } from "../src/index.js";

test("file workflow library saves scripts as reusable command entries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-library-"));
	const library = createFileWorkflowLibrary(dir);
	const script = `export const meta = { name: 'saved_audit', description: 'Audit the project' }
return await agent('audit ' + (args ?? ''))
`;

	const entry = library.save(script);

	assert.equal(entry.name, "saved_audit");
	assert.equal(entry.description, "Audit the project");
	assert.equal(entry.path, join(dir, "saved_audit.workflow.js"));
	assert.equal(await readFile(entry.path, "utf8"), script);
	assert.deepEqual(
		library.list().map((item) => item.name),
		["saved_audit"],
	);
	assert.equal(library.get("saved_audit")?.script, script);
});
