import {
	AuthStorage,
	type CreateAgentSessionOptions,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type FauxProviderRegistration,
	type FauxResponseStep,
	registerFauxProvider,
} from "../support/faux-pi-ai-provider.js";
import { createTempDir } from "../support/temp-dir.js";

export * from "../support/extension-harness.js";
export {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "../support/faux-pi-ai-provider.js";
export * from "../support/faux-workflow-agent.js";
export * from "../support/temp-dir.js";

export interface FauxWorkflowSessionHarness {
	cwd: string;
	agentDir: string;
	faux: FauxProviderRegistration;
	session: Partial<CreateAgentSessionOptions>;
	cleanup(): Promise<void>;
}

export async function createFauxWorkflowSessionHarness(
	options: { responses?: FauxResponseStep[] } = {},
): Promise<FauxWorkflowSessionHarness> {
	const temp = await createTempDir("pi-workflow-agent-suite-");
	const faux = registerFauxProvider();
	faux.setResponses(options.responses ?? []);

	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");

	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	return {
		cwd: temp.path,
		agentDir: temp.path,
		faux,
		session: {
			agentDir: temp.path,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(temp.path),
			model,
		},
		async cleanup() {
			faux.unregister();
			await temp.cleanup();
		},
	};
}
