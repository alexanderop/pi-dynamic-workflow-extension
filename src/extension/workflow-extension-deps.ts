import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkflowBrowser, type WorkflowBrowserActions } from "../workflow-browser.js";
import { createFileWorkflowLibrary, type WorkflowLibrary } from "../workflow-library.js";
import {
	createFileWorkflowStore,
	createWorkflowManager,
	type StartWorkflowJobOptions,
	type WorkflowJobStore,
	type WorkflowManager,
} from "../workflow-manager.js";
import { createWorkflowTool } from "../workflow-tool.js";
import { formatWorkflowCompletion } from "./workflow-extension-format.js";

export interface WorkflowExtensionDeps {
	manager: WorkflowManager;
	workflowTool: ToolDefinition;
	globalWorkflowLibrary: WorkflowLibrary;
	createWorkflowStore(cwd: string): WorkflowJobStore;
	createBrowser(
		manager: WorkflowManager,
		tui: ConstructorParameters<typeof WorkflowBrowser>[1],
		theme: ConstructorParameters<typeof WorkflowBrowser>[2],
		done: () => void,
		actions: WorkflowBrowserActions,
	): WorkflowBrowser;
	formatCompletion(job: Parameters<typeof formatWorkflowCompletion>[0]): string;
	startOptions?: Pick<StartWorkflowJobOptions, "agent" | "concurrency" | "maxEstimatedTokens" | "journal">;
}

export function createDefaultWorkflowExtensionDeps(): WorkflowExtensionDeps {
	const manager = createWorkflowManager();
	return {
		manager,
		workflowTool: createWorkflowTool({ manager }),
		globalWorkflowLibrary: createFileWorkflowLibrary(join(homedir(), ".pi", "agent", "workflows")),
		createWorkflowStore(cwd) {
			return createFileWorkflowStore(join(cwd, ".pi", "workflows"));
		},
		createBrowser(manager, tui, theme, done, actions) {
			return new WorkflowBrowser(manager, tui, theme, done, actions);
		},
		formatCompletion: formatWorkflowCompletion,
	};
}
