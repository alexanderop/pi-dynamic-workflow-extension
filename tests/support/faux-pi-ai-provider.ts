// The faux provider is intentionally not part of @earendil-works/pi-ai's public exports.
// WorkflowAgent tests must register the provider in pi-coding-agent's nested pi-ai copy
// so createAgentSession can discover the same in-memory API registration. Keep the
// package-topology workaround isolated here instead of deep-importing it from tests.
import {
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";

export type { FauxProviderRegistration, FauxResponseStep };
export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, registerFauxProvider };
