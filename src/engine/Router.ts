import { IProvider, Message, ChatOptions, ChatResult, Tool } from '../providers/IProvider';
import { Recommendation } from './Recommender';
import { healthMonitor } from './HealthMonitor';
import { estimateMessagesTokens, fitMessagesToContext } from './TaskDecomposer';

export class Router {
	constructor(private readonly providers: IProvider[]) { }

	private getProvider(providerName: string): IProvider | undefined {
		return this.providers.find(p => p.name === providerName);
	}

	async route(
		recommendations: Recommendation[],
		messages: Message[],
		tools?: Tool[],
		options: ChatOptions = {},
		onFallback?: (from: string, to: string, reason: string) => void,
	): Promise<ChatResult> {
		// Filter out recommendations whose providers are configured
		const configuredRecs = recommendations.filter(rec => {
			const p = this.getProvider(rec.model.provider);
			return p ? p.isConfigured() : false;
		});

		if (configuredRecs.length === 0) {
			throw new Error('No models available. Please configure your API keys first.');
		}

		let candidateRecs = [...configuredRecs];

		const systemTokens = estimateMessagesTokens(
			messages.filter(m => m.role === 'system')
		);

		const totalInputTokens = estimateMessagesTokens(messages);
		let filteredRecs = [...candidateRecs];
		if (totalInputTokens >= 6000) {
			// Large input -> DeepSeek V4 Pro or models with 128k+ context length
			filteredRecs = candidateRecs.filter(rec => 
				rec.model.id.includes('deepseek-v4-pro') || rec.model.contextLength >= 128000
			);
		} else if (totalInputTokens >= 2000) {
			// Medium input -> filter to models with 8k+ context length
			filteredRecs = candidateRecs.filter(rec => rec.model.contextLength >= 8000);
		}
		if (filteredRecs.length > 0) {
			candidateRecs = filteredRecs;
		}

		// Sort candidate recommendations: healthy and active (no cooldown) first, then shortest cooldown, then unhealthy
		const getCooldown = (providerName: string): number => {
			const p = this.getProvider(providerName);
			return p ? p.getCooldownRemainingMs() : 0;
		};

		candidateRecs.sort((a, b) => {
			const aHealthy = healthMonitor.isHealthy(a.model.provider);
			const bHealthy = healthMonitor.isHealthy(b.model.provider);
			if (aHealthy !== bHealthy) {
				return aHealthy ? -1 : 1;
			}

			const aCooldown = getCooldown(a.model.provider);
			const bCooldown = getCooldown(b.model.provider);
			if (aCooldown !== bCooldown) {
				return aCooldown - bCooldown;
			}

			return 0;
		});

		const errors: string[] = [];

		for (let i = 0; i < candidateRecs.length; i++) {
			const rec = candidateRecs[i];
			const provider = this.getProvider(rec.model.provider);
			if (!provider) {
				continue;
			}
			const startTime = Date.now();

			try {
				const safeInput = (rec.model as any).safeInputTokens
					?? Math.floor((rec.model.contextLength / 4) * 0.75);
				const fittedMessages = fitMessagesToContext(
					messages,
					rec.model.provider,
					systemTokens,
					safeInput,
				);
				const response = await provider.chat(rec.model.id, fittedMessages, tools, undefined, options);
				healthMonitor.recordSuccess(rec.model.provider, Date.now() - startTime);
				response.provider = rec.model.provider;
				response.modelId = rec.model.id;
				return response;
			} catch (err) {
				healthMonitor.recordFailure(rec.model.provider);
				const reason = err instanceof Error ? err.message : String(err);
				errors.push(`${rec.model.displayName}: ${reason}`);

				const next = candidateRecs[i + 1];
				if (next && onFallback) {
					onFallback(rec.model.displayName, next.model.displayName, reason);
				}

				// Rate limit hit on NIM -> immediately fall back to Groq / not another NIM model
				if (rec.model.provider === 'nvidia') {
					let nextIndex = i + 1;
					while (nextIndex < candidateRecs.length && candidateRecs[nextIndex].model.provider === 'nvidia') {
						nextIndex++;
					}
					if (nextIndex > i + 1) {
						const skippedCount = nextIndex - (i + 1);
						errors.push(`Skipped ${skippedCount} subsequent NVIDIA NIM models on provider failure.`);
						i = nextIndex - 1;
					}
				}
			}
		}

		throw new Error(`All recommended models failed:\n${errors.map(e => `- ${e}`).join('\n')}`);
	}
}
