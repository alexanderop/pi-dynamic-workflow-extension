import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "vitest";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const workflowTypes = await readFile(new URL("../types/workflow.d.ts", import.meta.url), "utf8");
const distDir = new URL("../dist/", import.meta.url);
const builtEntry = new URL("../dist/src/index.js", import.meta.url);
const builtExtensionEntry = new URL("../dist/extensions/workflow.js", import.meta.url);
const hasDistDir = await pathExists(distDir);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
	exports?: Record<string, { types?: string }>;
	scripts?: Record<string, string>;
	pi?: { extensions?: string[] };
};

function assertReadmeIncludes(label: string, pattern: RegExp): void {
	assert.match(readme, pattern, `README should document ${label}`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(path: URL): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

test("README documents install, build, test, and Pi extension entry points", () => {
	assert.equal(packageJson.scripts?.build, "tsc -p tsconfig.json");
	assert.equal(packageJson.scripts?.["test:e2e"], "vitest --run tests/e2e/*.test.ts");
	assert.equal(packageJson.scripts?.test, "npm run check && npm run build && vitest --run");
	assert.deepEqual(packageJson.pi?.extensions, ["extensions/workflow.ts"]);

	assertReadmeIncludes("npm install", /npm install/);
	assertReadmeIncludes("npm run build", /npm run build/);
	assertReadmeIncludes("npm test", /npm test/);
	assertReadmeIncludes("pi install", /pi install\s+\/absolute\/path\/to\/pi-dynamic-workflow-extension/);
	assertReadmeIncludes("local extension loading", /pi -e \.\/extensions\/workflow\.ts/);
});

test("README documents user-facing workflow commands and native triggers", () => {
	for (const command of [
		"/workflows",
		"/workflow-save",
		"/workflow-resume",
		"/workflow-list",
		"/workflow-delete",
		"/workflow-edit",
		"/workflow-refresh",
	]) {
		assertReadmeIncludes(command, new RegExp(command.replace("/", "\\/")));
	}

	assertReadmeIncludes("ultracode trigger", /ultracode <task>/i);
	assertReadmeIncludes("quick workflow trigger", /quick workflow <task>/i);
	assertReadmeIncludes("use a workflow trigger", /use \[a\] workflow to <task>/i);
	assertReadmeIncludes("saved workflow slash commands", /saved workflows?.*slash commands?/is);
});

test("README documents workflow artifact outputs", () => {
	assertReadmeIncludes("artifact primitive", /artifact\(name, value, options\?\)/);
	assertReadmeIncludes("artifact safe relative names", /safe relative names/i);
	assertReadmeIncludes("artifact JSON values", /artifact values.*JSON-serializable/is);
	assertReadmeIncludes("artifact dashboard visibility", /Artifacts.*dashboard/is);
});

test("workflow global types expose the artifact contract", () => {
	assert.equal(packageJson.exports?.["./workflow"]?.types, "./types/workflow.d.ts");
	assert.match(workflowTypes, /interface ArtifactOptions/);
	assert.match(workflowTypes, /type\?: ["']markdown["'] \| ["']json["'] \| ["']text["']/);
	assert.match(workflowTypes, /interface WorkflowArtifact/);
	assert.match(
		workflowTypes,
		/function artifact\(\s*name: string,\s*value: unknown,\s*options\?: ArtifactOptions,?\s*\): void/s,
	);
});

test.skipIf(!hasDistDir)("built dist exports and extension entry import after build", async () => {
	await assert.doesNotReject(access(builtEntry), "dist/src/index.js is missing; run npm run build");
	await assert.doesNotReject(access(builtExtensionEntry), "dist/extensions/workflow.js is missing; run npm run build");

	const packageEntry = await import(builtEntry.href);
	const extensionEntry = await import(builtExtensionEntry.href);

	assert.equal(typeof packageEntry.WorkflowAgent, "function");
	assert.equal(typeof packageEntry.createWorkflowManager, "function");
	assert.equal(typeof extensionEntry.default, "function");
});

test("README documents dashboard controls, persistence locations, and runtime limits", () => {
	for (const control of [
		"↑↓ select",
		"←→ focus",
		"j/k scroll",
		"enter expand",
		"c cancel",
		"s save",
		"r rerun",
		"R resume",
		"p/n",
		"[/]",
		"</>",
		"q close",
	]) {
		assertReadmeIncludes(`dashboard control ${control}`, new RegExp(escapeRegExp(control)));
	}

	assertReadmeIncludes("project workflow persistence", /\.pi\/workflows/);
	assertReadmeIncludes("global saved workflow persistence", /~\/\.pi\/agent\/workflows/);
	assertReadmeIncludes("node:vm sandbox caveat", /node:vm[\s\S]*not[\s\S]{0,30}strong security sandbox/i);
	assertReadmeIncludes("async cancellation limitation", /Cancellation and `timeoutMs`[\s\S]*async boundaries/);
	assertReadmeIncludes("CPU-bound limitation", /CPU-bound loops/);
	assertReadmeIncludes("JSON serializable results", /JSON-serializable/);
});
