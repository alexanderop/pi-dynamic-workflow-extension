import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFileWorkflowLibrary, type WorkflowLibraryFileOperations } from "../src/index.js";

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

test("file workflow library can run through injected file operations", () => {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const operations: WorkflowLibraryFileOperations = {
		ensureDir(path) {
			dirs.add(path);
		},
		exists(path) {
			return dirs.has(path) || files.has(path);
		},
		listFiles(path) {
			return Array.from(files.keys())
				.filter((file) => file.startsWith(`${path}/`))
				.map((file) => file.slice(path.length + 1));
		},
		readFile(path) {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing fake file: ${path}`);
			return value;
		},
		writeFile(path, value) {
			files.set(path, value);
		},
		deleteFile(path) {
			files.delete(path);
		},
	};
	const library = createFileWorkflowLibrary("/fake/workflows", operations);
	const script = `export const meta = { name: 'fake_saved', description: 'Fake saved workflow' }
return await agent('fake')
`;

	const saved = library.save(script);

	assert.equal(saved.path, "/fake/workflows/fake_saved.workflow.js");
	assert.equal(files.get(saved.path), script);
	assert.deepEqual(
		library.list().map((entry) => entry.name),
		["fake_saved"],
	);
	assert.equal(library.delete("fake_saved"), true);
	assert.deepEqual(library.list(), []);
});
