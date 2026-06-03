import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowScript } from "../src/workflow.js";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  phases: [{ title: 'Scan' }]
}

phase('Scan')
return { ok: true }
`;

test("parseWorkflowScript accepts literal workflow metadata", () => {
	const parsed = parseWorkflowScript(validScript);
	assert.equal(parsed.meta.name, "demo_workflow");
	assert.match(parsed.body, /phase\('Scan'\)/);
	assert.doesNotMatch(parsed.body, /export const meta/);
});

test("parseWorkflowScript rejects non-literal metadata", () => {
	assert.throws(
		() =>
			parseWorkflowScript(
				"export const meta = { name: makeName(), description: 'desc' }",
			),
		/non-literal node type CallExpression/,
	);
});

test("parseWorkflowScript rejects scripts without metadata first", () => {
	assert.throws(
		() =>
			parseWorkflowScript(
				"const x = 1;\nexport const meta = { name: 'demo', description: 'desc' }",
			),
		/must be the first statement/,
	);
});

test("parseWorkflowScript rejects nondeterministic APIs", () => {
	for (const expression of [
		"Date.now()",
		"Date['now']()",
		"Date['n' + 'ow']()",
		"Math.random()",
		"new Date()",
	]) {
		assert.throws(
			() =>
				parseWorkflowScript(
					`export const meta = { name: 'demo', description: 'desc' }\nreturn ${expression}`,
				),
			/must be deterministic/,
		);
	}
});

test("parseWorkflowScript allows deterministic Date and Math APIs", () => {
	assert.doesNotThrow(() =>
		parseWorkflowScript(
			`export const meta = { name: 'demo', description: 'desc' }\nreturn Date.parse('2020-01-01T00:00:00Z') + Math.max(1, 2)`,
		),
	);
});
