import { IProvider, Message, ChatOptions, ChatResult, Tool } from '../providers/IProvider';
import { Recommendation } from './Recommender';
import { healthMonitor } from './HealthMonitor';
import { estimateMessagesTokens, fitMessagesToContext } from './TaskDecomposer';
import { parseRetryAfter } from '../providers/OpenAICompatibleProvider';

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

		// ── Cooldown-Aware Retry Pass ──
		// Before giving up, check if any failed candidates had short rate-limit cooldowns
		// that we can wait out (≤30 seconds). This prevents premature task failure.
		const retryableCandidates: { index: number; delayMs: number }[] = [];
		for (let i = 0; i < candidateRecs.length; i++) {
			const errorMsg = errors.find(e => e.startsWith(candidateRecs[i].model.displayName));
			if (!errorMsg) { continue; }

			// Extract retry delay from error messages (429 rate limit responses)
			const retryDelaySec = parseRetryAfter(errorMsg);
			if (retryDelaySec > 0 && retryDelaySec <= 30) {
				retryableCandidates.push({ index: i, delayMs: retryDelaySec * 1000 });
			}
		}

		if (retryableCandidates.length > 0) {
			const shortestDelay = Math.min(...retryableCandidates.map(c => c.delayMs));
			const retryProviderNames = [...new Set(retryableCandidates.map(c => candidateRecs[c.index].model.provider))];

			if (onFallback) {
				onFallback(
					'All models',
					retryProviderNames.join(', '),
					`Rate-limited. Waiting ${Math.ceil(shortestDelay / 1000)}s for cooldown...`
				);
			}

			// Abort-aware wait with 0-1000ms jitter
			await new Promise<void>((resolve, reject) => {
				if (options.abortSignal?.aborted) {
					return reject(new Error('Aborted'));
				}
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error('Aborted'));
				};
				const timer = setTimeout(() => {
					if (options.abortSignal) {
						options.abortSignal.removeEventListener('abort', onAbort);
					}
					resolve();
				}, shortestDelay + Math.floor(Math.random() * 1000));
				if (options.abortSignal) {
					options.abortSignal.addEventListener('abort', onAbort);
				}
			});

			// Retry only the retryable candidates (one pass, no further cooldown waits)
			for (const { index } of retryableCandidates) {
				const rec = candidateRecs[index];
				const provider = this.getProvider(rec.model.provider);
				if (!provider) { continue; }

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
				} catch (retryErr) {
					healthMonitor.recordFailure(rec.model.provider);
					const retryReason = retryErr instanceof Error ? retryErr.message : String(retryErr);
					errors.push(`${rec.model.displayName} (retry): ${retryReason}`);
				}
			}
		}

		throw new Error(`All recommended models failed:\n${errors.map(e => `- ${e}`).join('\n')}`);
	}
}
