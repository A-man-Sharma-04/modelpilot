import { IProvider, Message, ChatOptions, ChatResult, Tool } from '../providers/IProvider';
import { Recommendation } from './Recommender';
import { healthMonitor } from './HealthMonitor';

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

		// Try to prioritize healthy providers first, fallback to unhealthy if none are healthy
		const healthyRecs = configuredRecs.filter(rec => healthMonitor.isHealthy(rec.model.provider));
		const candidateRecs = healthyRecs.length > 0 ? healthyRecs : configuredRecs;

		const errors: string[] = [];

		for (let i = 0; i < candidateRecs.length; i++) {
			const rec = candidateRecs[i];
			const provider = this.getProvider(rec.model.provider);
			if (!provider) {
				continue;
			}
			const startTime = Date.now();

			try {
				const response = await provider.chat(rec.model.id, messages, tools, undefined, options);
				healthMonitor.recordSuccess(rec.model.provider, Date.now() - startTime);
				return response;
			} catch (err) {
				healthMonitor.recordFailure(rec.model.provider);
				const reason = err instanceof Error ? err.message : String(err);
				errors.push(`${rec.model.displayName}: ${reason}`);

				const next = candidateRecs[i + 1];
				if (next && onFallback) {
					onFallback(rec.model.displayName, next.model.displayName, reason);
				}
			}
		}

		throw new Error(`All recommended models failed:\n${errors.map(e => `- ${e}`).join('\n')}`);
	}
}
