import { IProvider, Message, ChatOptions, ChatResult, Tool } from '../providers/IProvider';
import { Recommendation } from './Recommender';
import { healthMonitor } from './HealthMonitor';
import { estimateMessagesTokens, fitMessagesToContext } from './TaskDecomposer';
import { parseRetryAfter } from '../providers/OpenAICompatibleProvider';
import { debugLog, safeSerialize } from '../debug';

export function isProviderLevelError(errReason: string): boolean {
	const lower = errReason.toLowerCase();
	return (
		lower.includes('429') ||
		lower.includes('rate limit') ||
		lower.includes('401') ||
		lower.includes('403') ||
		lower.includes('unauthorized') ||
		lower.includes('forbidden') ||
		lower.includes('timeout') ||
		lower.includes('fetch failed') ||
		lower.includes('network') ||
		lower.includes('econnrefused')
	);
}

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
			// Large input -> DeepSeek R1 or models with 128k+ context length
			filteredRecs = candidateRecs.filter(rec => 
				rec.model.id.includes('deepseek-r1') || rec.model.contextLength >= 128000
			);
		} else if (totalInputTokens >= 2000) {
			// Medium input -> filter to models with 8k+ context length
			filteredRecs = candidateRecs.filter(rec => rec.model.contextLength >= 8000);
		}
		if (filteredRecs.length > 0) {
			candidateRecs = filteredRecs;
		}

		// Sort candidate recommendations: healthy and active (no cooldown) first, then shortest cooldown, then unhealthy.
		// Use the original recommendation rank (index) as a tie-breaker to ensure stable sorting.
		const getCooldown = (providerName: string): number => {
			const p = this.getProvider(providerName);
			return p ? p.getCooldownRemainingMs() : 0;
		};

		const indexedRecs = candidateRecs.map((rec, index) => ({ rec, index }));
		indexedRecs.sort((a, b) => {
			const aHealthy = healthMonitor.isHealthy(a.rec.model.provider);
			const bHealthy = healthMonitor.isHealthy(b.rec.model.provider);
			if (aHealthy !== bHealthy) {
				return aHealthy ? -1 : 1;
			}

			const aCooldown = getCooldown(a.rec.model.provider);
			const bCooldown = getCooldown(b.rec.model.provider);
			if (aCooldown !== bCooldown) {
				return aCooldown - bCooldown;
			}

			return a.index - b.index;
		});
		candidateRecs = indexedRecs.map(item => item.rec);

		debugLog('openai_compatible', `[ROUTER] Sorted Candidates: ${safeSerialize(candidateRecs.map(r => ({ model: `${r.model.provider}::${r.model.id}`, healthy: healthMonitor.isHealthy(r.model.provider), cooldown: getCooldown(r.model.provider) })))}`);

		const errors: string[] = [];

		const tier1Recs = candidateRecs.filter(rec => rec.model.provider === 'groq' || rec.model.provider === 'cerebras' || rec.model.provider === 'google');
		const tier2Recs = candidateRecs.filter(rec => rec.model.provider !== 'groq' && rec.model.provider !== 'cerebras' && rec.model.provider !== 'google');

		const executeRoutingPass = async (recs: Recommendation[]): Promise<ChatResult> => {
			for (let i = 0; i < recs.length; i++) {
				const rec = recs[i];
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
					errors.push(`${rec.model.displayName || rec.model.id}: ${reason}`);

					const next = recs[i + 1];
					if (next && onFallback) {
						onFallback(rec.model.displayName || rec.model.id, next.model.displayName || next.model.id, reason);
					}

					// Skip subsequent models of the same provider on provider-level failure
					if (isProviderLevelError(reason)) {
						let nextIndex = i + 1;
						while (nextIndex < recs.length && recs[nextIndex].model.provider === rec.model.provider) {
							nextIndex++;
						}
						if (nextIndex > i + 1) {
							const skippedCount = nextIndex - (i + 1);
							errors.push(`Skipped ${skippedCount} subsequent ${rec.model.provider} models on provider-level failure.`);
							i = nextIndex - 1;
						}
					}
				}
			}
			throw new Error('All candidates in this pass failed');
		};

		let tier1Succeeded = false;
		let tier1Result: ChatResult | undefined = undefined;

		if (tier1Recs.length > 0) {
			try {
				tier1Result = await executeRoutingPass(tier1Recs);
				tier1Succeeded = true;
			} catch (firstPassErr) {
				// All initial Tier 1 attempts failed. Let's do up to 2 retry passes (making 3 attempts total).
				for (let attempt = 2; attempt <= 3; attempt++) {
					// Check if any failed candidates have short rate-limit cooldowns (<= 15 seconds)
					const retryableCandidates: { rec: Recommendation; delayMs: number }[] = [];
					for (const rec of tier1Recs) {
						const prefix = `${rec.model.displayName || rec.model.id}:`;
						const errorMsg = errors.find(e => e.startsWith(prefix) && !e.includes('(retry'));
						if (!errorMsg) { continue; }
						// Skip retrying if it's an explicit 401/403 auth error
						if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.toLowerCase().includes('unauthorized') || errorMsg.toLowerCase().includes('forbidden')) {
							continue;
						}

						const retryDelaySec = parseRetryAfter(errorMsg);
						const hasDurationPattern = /try again in|retry in|wait|after|retry_after_seconds|ratelimit-reset/i.test(errorMsg);
						if (hasDurationPattern && retryDelaySec > 0 && retryDelaySec <= 15) {
							retryableCandidates.push({ rec, delayMs: retryDelaySec * 1000 });
						} else if (!hasDurationPattern || errorMsg.toLowerCase().includes('timeout') || errorMsg.toLowerCase().includes('fetch failed')) {
							// For timeouts or network errors with no specific delay, retry with a small 500ms fallback delay
							retryableCandidates.push({ rec, delayMs: 500 });
						}
					}

					if (retryableCandidates.length === 0) {
						// No retryable candidates
						break;
					}

					// Wait for the shortest cooldown among retryable candidates
					const shortestDelay = Math.min(...retryableCandidates.map(c => c.delayMs));
					const retryProviderNames = [...new Set(retryableCandidates.map(c => c.rec.model.provider))];

					if (onFallback) {
						onFallback(
							'Tier 1 models',
							retryProviderNames.join(', '),
							`Retrying Tier 1 (attempt ${attempt}/3) after ${Math.ceil(shortestDelay / 1000)}s cooldown...`
						);
					}

					// Wait with abort-aware timeout
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
						}, shortestDelay + Math.floor(Math.random() * 500));
						if (options.abortSignal) {
							options.abortSignal.addEventListener('abort', onAbort);
						}
					});

					// Retry the candidates in this pass
					let passSucceeded = false;
					for (const { rec } of retryableCandidates) {
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
							tier1Result = response;
							tier1Succeeded = true;
							passSucceeded = true;
							break;
						} catch (retryErr) {
							healthMonitor.recordFailure(rec.model.provider);
							const retryReason = retryErr instanceof Error ? retryErr.message : String(retryErr);
							errors.push(`${rec.model.displayName} (retry ${attempt}): ${retryReason}`);
						}
					}

					if (passSucceeded) {
						break;
					}
				}
			}
		}

		if (tier1Succeeded && tier1Result) {
			return tier1Result;
		}

		// Proceed to Tier 2 fallback if Tier 1 is exhausted or not configured
		if (tier2Recs.length > 0) {
			if (onFallback && tier1Recs.length > 0) {
				onFallback('Tier 1 models', tier2Recs[0].model.displayName, 'Tier 1 exhausted. Falling back to Tier 2...');
			}
			try {
				return await executeRoutingPass(tier2Recs);
			} catch (tier2Err) {
				// handled by the executeRoutingPass pushing to errors
			}
		}

		throw new Error(`All recommended models failed:\n${errors.map(e => `- ${e}`).join('\n')}`);
	}
}
