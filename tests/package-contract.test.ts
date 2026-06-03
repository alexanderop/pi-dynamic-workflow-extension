import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const packageJson = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string>; pi?: { extensions?: string[] } };

function assertReadmeIncludes(label: string, pattern: RegExp): void {
	assert.match(readme, pattern, `README should document ${label}`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("README documents install, build, test, and Pi extension entry points", () => {
	assert.equal(packageJson.scripts?.build, "tsc -p tsconfig.json");
	assert.equal(
		packageJson.scripts?.["test:e2e"],
		"tsx --test tests/e2e/*.test.ts",
	);
	assert.equal(
		packageJson.scripts?.test,
		"npm run check && npm run build && npm run test:unit && npm run test:e2e",
	);
	assert.deepEqual(packageJson.pi?.extensions, ["extensions/workflow.ts"]);

	assertReadmeIncludes("npm install", /npm install/);
	assertReadmeIncludes("npm run build", /npm run build/);
	assertReadmeIncludes("npm test", /npm test/);
	assertReadmeIncludes(
		"pi install",
		/pi install\s+\/absolute\/path\/to\/pi-dynamic-workflow-extension/,
	);
	assertReadmeIncludes(
		"local extension loading",
		/pi -e \.\/extensions\/workflow\.ts/,
	);
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
	assertReadmeIncludes(
		"use a workflow trigger",
		/use \[a\] workflow to <task>/i,
	);
	assertReadmeIncludes(
		"saved workflow slash commands",
		/saved workflows?.*slash commands?/is,
	);
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
		assertReadmeIncludes(
			`dashboard control ${control}`,
			new RegExp(escapeRegExp(control)),
		);
	}

	assertReadmeIncludes("project workflow persistence", /\.pi\/workflows/);
	assertReadmeIncludes(
		"global saved workflow persistence",
		/~\/\.pi\/agent\/workflows/,
	);
	assertReadmeIncludes(
		"node:vm sandbox caveat",
		/node:vm[\s\S]*not[\s\S]{0,30}strong security sandbox/i,
	);
	assertReadmeIncludes(
		"async cancellation limitation",
		/Cancellation and `timeoutMs`[\s\S]*async boundaries/,
	);
	assertReadmeIncludes("CPU-bound limitation", /CPU-bound loops/);
	assertReadmeIncludes("JSON serializable results", /JSON-serializable/);
});
