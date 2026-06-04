import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const extensionSource = () =>
	readFile(new URL("../src/extension/register-workflow-extension.ts", import.meta.url), "utf8");

test("main agent abort signal does not interrupt background workflows", async () => {
	const source = await extensionSource();

	assert.doesNotMatch(
		source,
		/ctx\.signal[\s\S]{0,800}manager\.interruptAll\(\)/,
		"background workflows must not be tied to the main assistant turn abort signal",
	);
	assert.doesNotMatch(
		source,
		/pi\.on\(\s*["']agent_start["'][\s\S]{0,800}manager\.interruptAll\(\)/,
		"cancelling the main agent turn must not interrupt running workflows",
	);
});

test("session shutdown still interrupts running workflows", async () => {
	const source = await extensionSource();

	assert.match(
		source,
		/pi\.on\(\s*["']session_shutdown["'][\s\S]*manager\.interruptAll\(\)/,
		"session shutdown should still mark persisted running workflows as interrupted",
	);
});
