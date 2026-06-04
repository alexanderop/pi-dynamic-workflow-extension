import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowExtension } from "../src/extension/register-workflow-extension.js";
import { createDefaultWorkflowExtensionDeps } from "../src/extension/workflow-extension-deps.js";

export default function extension(pi: ExtensionAPI) {
	return registerWorkflowExtension(pi, createDefaultWorkflowExtensionDeps());
}
