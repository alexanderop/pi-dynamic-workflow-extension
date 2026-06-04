import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
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

test("file workflow library deletes saved command entries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-library-"));
	const library = createFileWorkflowLibrary(dir);
	const script = `export const meta = { name: 'saved_audit', description: 'Audit the project' }
return await agent('audit')
`;

	library.save(script);

	assert.equal(library.delete("saved_audit"), true);
	assert.equal(library.get("saved_audit"), undefined);
	assert.deepEqual(library.list(), []);
	assert.equal(library.delete("saved_audit"), false);
});

test("file workflow library updates an existing saved command script", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-library-"));
	const library = createFileWorkflowLibrary(dir);
	const original = `export const meta = { name: 'saved_audit', description: 'Audit the project' }
return await agent('audit')
`;
	const updated = `export const meta = { name: 'saved_audit_v2', description: 'Audit with verification' }
return await agent('audit and verify ' + (args ?? ''))
`;

	const entry = library.save(original);
	const updatedEntry = library.update("saved_audit", updated);

	assert.equal(updatedEntry.name, "saved_audit");
	assert.equal(updatedEntry.description, "Audit with verification");
	assert.equal(updatedEntry.path, entry.path);
	assert.equal(await readFile(entry.path, "utf8"), updated);
	assert.equal(library.get("saved_audit")?.script, updated);
});
