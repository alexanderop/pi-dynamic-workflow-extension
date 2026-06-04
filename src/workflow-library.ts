import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseWorkflowScript } from "./workflow.js";

export interface SavedWorkflowEntry {
	name: string;
	description: string;
	path: string;
	script: string;
}

export interface WorkflowLibrary {
	list(): SavedWorkflowEntry[];
	get(name: string): SavedWorkflowEntry | undefined;
	save(script: string, name?: string): SavedWorkflowEntry;
	update(name: string, script: string): SavedWorkflowEntry;
	delete(name: string): boolean;
}

export function normalizeWorkflowCommandName(name: string): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/^[^a-z]+/, "")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!/^[a-z][a-z0-9_-]{1,63}$/.test(normalized)) {
		throw new Error(
			"saved workflow command name must start with a letter and contain 2-64 lowercase letters, numbers, underscores, or hyphens",
		);
	}
	return normalized;
}

export function createFileWorkflowLibrary(rootDir: string): WorkflowLibrary {
	mkdirSync(rootDir, { recursive: true });
	const pathFor = (name: string) => join(rootDir, `${name}.workflow.js`);
	const readEntry = (path: string): SavedWorkflowEntry | undefined => {
		const script = readFileSync(path, "utf8");
		try {
			const parsed = parseWorkflowScript(script);
			const filename = basename(path);
			const name = normalizeWorkflowCommandName(
				filename.endsWith(".workflow.js") ? filename.slice(0, -".workflow.js".length) : parsed.meta.name,
			);
			return {
				name,
				description: parsed.meta.description,
				path,
				script,
			};
		} catch {
			return undefined;
		}
	};
	return {
		list() {
			if (!existsSync(rootDir)) return [];
			return readdirSync(rootDir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.endsWith(".workflow.js"))
				.map((entry) => readEntry(join(rootDir, entry.name)))
				.filter((entry): entry is SavedWorkflowEntry => Boolean(entry))
				.sort((a, b) => a.name.localeCompare(b.name));
		},
		get(name) {
			const normalized = normalizeWorkflowCommandName(name);
			const path = pathFor(normalized);
			return existsSync(path) ? readEntry(path) : undefined;
		},
		delete(name) {
			const normalized = normalizeWorkflowCommandName(name);
			const path = pathFor(normalized);
			if (!existsSync(path)) return false;
			unlinkSync(path);
			return true;
		},
		update(name, script) {
			const commandName = normalizeWorkflowCommandName(name);
			const parsed = parseWorkflowScript(script);
			const path = pathFor(commandName);
			if (!existsSync(path)) {
				throw new Error(`saved workflow not found: ${commandName}`);
			}
			writeFileSync(path, script, "utf8");
			return {
				name: commandName,
				description: parsed.meta.description,
				path,
				script,
			};
		},
		save(script, name) {
			const parsed = parseWorkflowScript(script);
			const commandName = normalizeWorkflowCommandName(name ?? parsed.meta.name);
			const path = pathFor(commandName);
			writeFileSync(path, script, "utf8");
			return {
				name: commandName,
				description: parsed.meta.description,
				path,
				script,
			};
		},
	};
}
