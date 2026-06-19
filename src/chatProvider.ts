import * as vscode from 'vscode';
import { ModelRegistry } from './registry/ModelRegistry';
import { SecretsManager } from './secrets';
import { Recommender, Recommendation } from './engine/Recommender';
import { Router } from './engine/Router';
import { NvidiaProvider } from './providers/NvidiaProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { GroqProvider } from './providers/GroqProvider';
import { CerebrasProvider } from './providers/CerebrasProvider';
import { GoogleProvider } from './providers/GoogleProvider';
import { Message, Tool, ToolCall } from './providers/IProvider';
import { estimateMessagesTokens, estimateTokens } from './engine/TaskDecomposer';
import { AnalyticsManager } from './engine/AnalyticsManager';

function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Message[] {
	const result: Message[] = [];
	for (const msg of messages) {
		const role: 'user' | 'assistant' = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
		let content = '';
		const toolCalls: ToolCall[] = [];

		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input)
					}
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let toolContent = '';
				for (const resPart of part.content) {
					if (resPart instanceof vscode.LanguageModelTextPart) {
						toolContent += resPart.value;
					} else if (resPart && typeof resPart === 'object' && 'value' in resPart && typeof (resPart as any).value === 'string') {
						toolContent += (resPart as any).value;
					} else if (typeof resPart === 'string') {
						toolContent += resPart;
					}
				}
				result.push({
					role: 'tool',
					tool_call_id: part.callId,
					content: toolContent
				});
			}
		}

		if (content || toolCalls.length > 0 || (role === 'assistant' && toolCalls.length > 0)) {
			const mappedMsg: Message = {
				role,
				content,
				name: msg.name
			};
			if (toolCalls.length > 0) {
				mappedMsg.tool_calls = toolCalls;
			}
			result.push(mappedMsg);
		}
	}
	return result;
}

export class ModelPilotChatProvider implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

	constructor(
		private readonly registry: ModelRegistry,
		private readonly sm: SecretsManager,
		private readonly analyticsManager: AnalyticsManager,
		private readonly getExpertId: () => string
	) {
		this.registry.onDidChange(() => {
			this.onDidChangeEmitter.fire();
		});
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		const models: vscode.LanguageModelChatInformation[] = [];

		// 1. Add the Auto Router model
		models.push({
			id: 'auto',
			name: 'ModelPilot (Auto Router)',
			family: 'modelpilot',
			detail: 'Auto-recommends & routes requests',
			tooltip: 'Automatically routes your request to the most suitable free provider model.',
			version: '1.0.0',
			maxInputTokens: 32000,
			maxOutputTokens: 4096,
			capabilities: {
				toolCalling: true
			}
		});

		// 2. Add all available models from registry
		const available = this.registry.getAvailable();
		for (const model of available) {
			const safeInput = (model as any).safeInputTokens ?? Math.floor((model.contextLength / 4) * 0.75);
			models.push({
				id: `${model.provider}::${model.id}`,
				name: model.displayName,
				family: model.provider,
				detail: `${model.provider.toUpperCase()} · Context: ${(model.contextLength / 1000).toFixed(0)}k`,
				tooltip: model.description,
				version: model.lastVerified || '1.0.0',
				maxInputTokens: safeInput,
				maxOutputTokens: model.maxOutputTokens || 4096,
				capabilities: {
					toolCalling: model.supportsNativeTools === true
				}
			});
		}

		return models;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const apiMessages = convertMessages(messages);

		const mappedTools: Tool[] = options.tools ? options.tools.map(t => ({
			type: 'function',
			function: {
				name: t.name,
				description: t.description,
				parameters: t.inputSchema || { type: 'object', properties: {} }
			}
		})) : [];

		const abortController = new AbortController();
		const abortListener = token.onCancellationRequested(() => {
			abortController.abort();
		});

		try {
			let recs: Recommendation[] = [];
			if (model.id === 'auto') {
				const expertId = this.getExpertId();
				const recommender = new Recommender(this.registry);
				const inputTokens = estimateMessagesTokens(apiMessages);
				recs = recommender.recommend(expertId, 5, inputTokens);
				if (recs.length === 0) {
					throw new Error('No models available. Please configure your API keys first.');
				}
			} else {
				const parts = model.id.split('::');
				const providerName = parts[0];
				const modelId = parts.slice(1).join('::');
				const targetModel = this.registry.getById(providerName, modelId);
				if (!targetModel) {
					throw new Error(`Model ${model.id} is not configured or available.`);
				}
				recs = [{
					model: targetModel,
					rank: 1,
					reason: 'Selected model'
				}];
			}

			const keys = await this.sm.getAll();
			const providers = [
				new NvidiaProvider(keys.nvidia),
				new OpenRouterProvider(keys.openrouter),
				new GroqProvider(keys.groq),
				new CerebrasProvider(keys.cerebras),
				new GoogleProvider(keys.google),
			];
			const router = new Router(providers);

			const chatResult = await router.route(
				recs,
				apiMessages,
				mappedTools.length > 0 ? mappedTools : undefined,
				{
					stream: true,
					abortSignal: abortController.signal,
					onChunk: (text) => {
						progress.report(new vscode.LanguageModelTextPart(text));
					}
				}
			);

			if (chatResult.toolCalls && chatResult.toolCalls.length > 0) {
				for (const tc of chatResult.toolCalls) {
					let inputObj: any = {};
					try {
						inputObj = JSON.parse(tc.function.arguments);
					} catch {
						// ignore parse error
					}
					progress.report(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, inputObj));
				}
			}

			const finalProvider = chatResult.provider || recs[0].model.provider;
			const finalModelId = chatResult.modelId || recs[0].model.id;
			const promptTokens = chatResult.usage?.promptTokens ?? estimateMessagesTokens(apiMessages);
			const completionTokens = chatResult.usage?.completionTokens ?? estimateTokens(chatResult.content);

			await this.analyticsManager.recordRequest(finalProvider, finalModelId, promptTokens, completionTokens);
		} finally {
			abortListener.dispose();
		}
	}

	async provideTokenCount(
		model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		token: vscode.CancellationToken
	): Promise<number> {
		if (typeof text === 'string') {
			return estimateTokens(text);
		}
		const apiMsgs = convertMessages([text]);
		return estimateMessagesTokens(apiMsgs);
	}
}
