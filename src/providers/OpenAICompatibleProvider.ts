import { IProvider, Message, LiveModel, ChatOptions, Tool, ToolCall, ChatResult } from './IProvider';
import { getModelProfile } from '../data/modelProfiles';

function formatMessagesForNonNativeTools(messages: Message[]): Message[] {
	return messages.map(m => {
		const newMsg: Message = { ...m };
		if (newMsg.role === 'tool') {
			newMsg.role = 'user';
			newMsg.content = `[Tool Output for "${newMsg.name || 'tool'}"]:\n${newMsg.content}`;
			newMsg.tool_call_id = undefined;
			newMsg.name = undefined;
		} else if (newMsg.role === 'assistant') {
			if (newMsg.tool_calls && newMsg.tool_calls.length > 0) {
				let xmlBlocks = '';
				for (const tc of newMsg.tool_calls) {
					const name = tc.function.name;
					const args = tc.function.arguments;
					xmlBlocks += `\n\n<use_tool>\n<name>${name}</name>\n<arguments>\n${args}\n</arguments>\n</use_tool>`;
				}
				if (!newMsg.content) {
					newMsg.content = xmlBlocks.trim();
				} else if (!newMsg.content.includes('use_tool') && !newMsg.content.includes('<use_tool>')) {
					newMsg.content += xmlBlocks;
				}
			}
			newMsg.tool_calls = undefined;
		}
		return newMsg;
	});
}

function parseDuration(val: string): number | undefined {
	val = val.trim().toLowerCase();
	// Check compound formats first (e.g. 2m15s, 1h30m)
	const match = val.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/);
	if (match && (match[1] || match[2] || match[3] || match[4])) {
		let totalSec = 0;
		if (match[1]) {
			totalSec += parseInt(match[1], 10) * 3600;
		}
		if (match[2]) {
			totalSec += parseInt(match[2], 10) * 60;
		}
		if (match[3]) {
			totalSec += parseFloat(match[3]);
		}
		if (match[4]) {
			totalSec += parseFloat(match[4]) / 1000;
		}
		return Math.ceil(totalSec);
	}
	// Fall back to simple float/integer
	const raw = parseFloat(val);
	return !isNaN(raw) ? Math.ceil(raw) : undefined;
}

export function parseRetryAfter(errText: string, headers?: { get(name: string): string | null }): number {
	if (headers) {
		const retryAfterHeader = headers.get('retry-after');
		if (retryAfterHeader) {
			const seconds = parseInt(retryAfterHeader, 10);
			if (!isNaN(seconds) && seconds > 0) {
				return seconds;
			}
			const date = Date.parse(retryAfterHeader);
			if (!isNaN(date)) {
				const diffSec = Math.ceil((date - Date.now()) / 1000);
				if (diffSec > 0) {
					return diffSec;
				}
			}
		}

		const xResetSec = headers.get('x-ratelimit-reset');
		if (xResetSec) {
			const seconds = parseFloat(xResetSec);
			if (!isNaN(seconds) && seconds > 0) {
				return Math.ceil(seconds);
			}
		}

		const xResetReqs = headers.get('x-ratelimit-reset-requests');
		if (xResetReqs) {
			const parsed = parseDuration(xResetReqs);
			if (parsed !== undefined && parsed > 0) {
				return parsed;
			}
		}

		const xResetTokens = headers.get('x-ratelimit-reset-tokens');
		if (xResetTokens) {
			const parsed = parseDuration(xResetTokens);
			if (parsed !== undefined && parsed > 0) {
				return parsed;
			}
		}
	}

	try {
		const parsed = JSON.parse(errText);
		const val = parsed.error?.retry_after_seconds ?? parsed.retry_after_seconds;
		if (val !== undefined) {
			const parsedVal = parseFloat(val);
			if (!isNaN(parsedVal) && parsedVal > 0) {
				return Math.ceil(parsedVal);
			}
		}
	} catch {}

	const match = errText.match(/(?:try again in|retry in|wait|after)[\s:]*([0-9\.]+(?:\s*(?:ms|s|m|h|seconds|minutes|hours|milliseconds))?(?:\s*\d+(?:\s*(?:ms|s|m|h|seconds|minutes|hours|milliseconds))?)?)/i);
	if (match) {
		const normalized = match[1].toLowerCase()
			.replace(/milliseconds?/g, 'ms')
			.replace(/seconds?/g, 's')
			.replace(/minutes?/g, 'm')
			.replace(/hours?/g, 'h')
			.replace(/\s+/g, '');
		const parsed = parseDuration(normalized);
		if (parsed !== undefined && parsed > 0) {
			return parsed;
		}
	}

	return 10;
}

export abstract class OpenAICompatibleProvider implements IProvider {
	abstract readonly name: string;
	abstract readonly baseUrl: string;
	abstract readonly apiKeys: string[];

	private static activeKeyIndices = new Map<string, number>();
	private static providerKeyCooldowns = new Map<string, Map<string, number>>();

	public static getActiveKeyIndex(providerName: string): number {
		return OpenAICompatibleProvider.activeKeyIndices.get(providerName) ?? 0;
	}

	private get activeKeyIndex(): number {
		return OpenAICompatibleProvider.activeKeyIndices.get(this.name) ?? 0;
	}

	private set activeKeyIndex(val: number) {
		OpenAICompatibleProvider.activeKeyIndices.set(this.name, val);
	}

	private get keyCooldowns(): Map<string, number> {
		let map = OpenAICompatibleProvider.providerKeyCooldowns.get(this.name);
		if (!map) {
			map = new Map<string, number>();
			OpenAICompatibleProvider.providerKeyCooldowns.set(this.name, map);
		}
		return map;
	}

	public static getProviderCooldowns(providerName: string): { key: string; remainingMs: number }[] {
		const cooldowns: { key: string; remainingMs: number }[] = [];
		const map = OpenAICompatibleProvider.providerKeyCooldowns.get(providerName);
		if (map) {
			const now = Date.now();
			for (const [key, end] of map.entries()) {
				const remaining = end - now;
				if (remaining > 0) {
					cooldowns.push({ key, remainingMs: remaining });
				}
			}
		}
		return cooldowns;
	}

	isConfigured(): boolean {
		return this.apiKeys.some(k => k.trim().length > 0);
	}

	abstract listModels(): Promise<LiveModel[]>;

	protected getHeaders(key: string): Record<string, string> {
		return {
			'Authorization': `Bearer ${key}`,
			'Content-Type': 'application/json',
		};
	}

	getCooldownRemainingMs(): number {
		const activeKeys = this.apiKeys.filter(k => k.trim().length > 0);
		if (activeKeys.length === 0) {
			return 0;
		}
		const now = Date.now();
		let minRemaining = Infinity;
		let hasAvailableKey = false;
		for (const key of activeKeys) {
			const cooldownEnd = this.keyCooldowns.get(key) ?? 0;
			const remaining = cooldownEnd - now;
			if (remaining <= 0) {
				hasAvailableKey = true;
				break;
			}
			if (remaining < minRemaining) {
				minRemaining = remaining;
			}
		}
		return hasAvailableKey ? 0 : minRemaining;
	}

	async chat(
		modelId: string,
		messages: Message[],
		tools?: Tool[],
		context?: any,
		options: ChatOptions = {},
	): Promise<ChatResult> {
		const activeKeys = this.apiKeys.filter(k => k.trim().length > 0);
		if (activeKeys.length === 0) {
			throw new Error(`Provider ${this.name} has no API keys configured.`);
		}

		const profile = getModelProfile(this.name, modelId);
		const useNativeTools = tools && tools.length > 0 && this.name !== 'groq' && profile?.supportsNativeTools === true;

		const executeWithKey = async (keyIndex: number): Promise<ChatResult> => {
			const activeKey = activeKeys[keyIndex];
			const makeRequest = async (withTools: boolean): Promise<ChatResult> => {
				const body: any = {
					model: modelId,
					messages: withTools ? messages : formatMessagesForNonNativeTools(messages),
					max_tokens: options.maxTokens ?? 4096,
					stream: options.stream ?? false,
				};
				if (withTools) {
					body.tools = tools;
				}
				if (options.stream) {
					body.stream_options = { include_usage: true };
				}

				const attemptController = new AbortController();
				let attemptTimedOut = false;
				const attemptTimeout = setTimeout(() => {
					attemptTimedOut = true;
					attemptController.abort();
				}, options.timeout ?? 30000);

				const abortListener = () => {
					attemptController.abort();
				};

				if (options.abortSignal) {
					if (options.abortSignal.aborted) {
						attemptController.abort();
					} else {
						options.abortSignal.addEventListener('abort', abortListener);
					}
				}

				try {
					let response = await fetch(`${this.baseUrl}/chat/completions`, {
						method: 'POST',
						headers: this.getHeaders(activeKey),
						body: JSON.stringify(body),
						signal: attemptController.signal,
					});

					clearTimeout(attemptTimeout);
					if (options.abortSignal) {
						options.abortSignal.removeEventListener('abort', abortListener);
					}

					if (response.status === 429) {
						const errText = await response.text();
						const retryAfter = parseRetryAfter(errText, response.headers);

						const err = new Error(`Rate limit exceeded (429): ${errText}`);
						(err as any).status = 429;
						(err as any).retryAfter = retryAfter;
						throw err;
					}

					if (response.status === 400 && options.stream && body.stream_options) {
						console.warn(`Provider ${this.name} failed with stream_options. Retrying without stream_options...`);
						delete body.stream_options;
						response = await fetch(`${this.baseUrl}/chat/completions`, {
							method: 'POST',
							headers: this.getHeaders(activeKey),
							body: JSON.stringify(body),
							signal: attemptController.signal,
						});
					}

					if (options.stream && options.onChunk) {
						return await this.handleStream(response, options.onChunk, options.abortSignal);
					}

					const data = await response.json() as {
						choices: {
							message: {
								content: string;
								tool_calls?: ToolCall[];
							}
						}[];
						usage?: {
							prompt_tokens?: number;
							completion_tokens?: number;
							total_tokens?: number;
						};
					};
					const msg = data.choices?.[0]?.message;
					if (!msg || (!msg.content && (!msg.tool_calls || msg.tool_calls.length === 0))) {
						throw new Error('Empty response received from model.');
					}
					const chatResult: ChatResult = {
						content: msg.content ?? '',
						toolCalls: msg.tool_calls,
					};
					if (data.usage) {
						chatResult.usage = {
							promptTokens: data.usage.prompt_tokens ?? 0,
							completionTokens: data.usage.completion_tokens ?? 0,
							totalTokens: data.usage.total_tokens ?? 0,
						};
					}
					return chatResult;
				} catch (err: any) {
					clearTimeout(attemptTimeout);
					if (options.abortSignal) {
						options.abortSignal.removeEventListener('abort', abortListener);
					}
					if (attemptTimedOut) {
						throw new Error(`Request timed out after ${(options.timeout ?? 30000) / 1000} seconds.`);
					}
					throw err;
				}
			};

			if (useNativeTools) {
				try {
					return await makeRequest(true);
				} catch (nativeErr: any) {
					if (options.abortSignal?.aborted || nativeErr.message === 'Aborted' || nativeErr.status === 429) {
						throw nativeErr;
					}
					console.warn(`Provider ${this.name} failed with native tools: ${nativeErr.message}. Retrying without native tools...`);
					return await makeRequest(false);
				}
			} else {
				return await makeRequest(false);
			}
		};

		// Pass 1: Try keys that are not in cooldown
		const triedKeyIndices = new Set<number>();
		let lastError: any = undefined;

		const startKeyIndex = this.activeKeyIndex;
		const attempts = activeKeys.length;
		for (let i = 0; i < attempts; i++) {
			const keyIndex = (startKeyIndex + i) % activeKeys.length;
			if (triedKeyIndices.has(keyIndex)) {
				break;
			}

			const activeKey = activeKeys[keyIndex];
			const cooldownEnd = this.keyCooldowns.get(activeKey) ?? 0;
			if (cooldownEnd > Date.now()) {
				continue;
			}
			
			triedKeyIndices.add(keyIndex);

			try {
				const result = await executeWithKey(keyIndex);
				this.activeKeyIndex = keyIndex;
				this.keyCooldowns.delete(activeKey);
				return result;
			} catch (err: any) {
				console.warn(`Key index ${keyIndex} for provider ${this.name} failed (${err.message || err}). Rotating to next key...`);
				
				let cooldownMs = 10000;
				if (err.status === 401 || err.status === 403) {
					cooldownMs = 3600 * 1000;
				} else if (err.status === 429) {
					cooldownMs = (err.retryAfter ?? 10) * 1000;
				} else if (err.message && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'))) {
					cooldownMs = parseRetryAfter(err.message) * 1000;
				}
				this.keyCooldowns.set(activeKey, Date.now() + cooldownMs);
				
				this.activeKeyIndex = (keyIndex + 1) % activeKeys.length;
				lastError = err;

				if (options.abortSignal?.aborted || err.message === 'Aborted') {
					throw err;
				}
			}
		}

		// Pass 2: If we didn't succeed, see if we can wait for a key with a short cooldown
		const now = Date.now();
		let minDelayMs = Infinity;
		let bestKeyIndex = -1;

		for (let i = 0; i < activeKeys.length; i++) {
			const key = activeKeys[i];
			const cooldownEnd = this.keyCooldowns.get(key) ?? 0;
			const delay = cooldownEnd - now;
			if (delay > 0 && delay < minDelayMs) {
				minDelayMs = delay;
				bestKeyIndex = i;
			}
		}

		if (bestKeyIndex !== -1 && minDelayMs <= 30000) {
			console.warn(`All API keys for provider ${this.name} are rate-limited/in cooldown. Waiting ${Math.ceil(minDelayMs / 1000)}s for the shortest cooldown...`);
			const bestKey = activeKeys[bestKeyIndex];
			
			try {
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
					}, minDelayMs + Math.floor(Math.random() * 500));
					if (options.abortSignal) {
						options.abortSignal.addEventListener('abort', onAbort);
					}
				});

				const result = await executeWithKey(bestKeyIndex);
				this.activeKeyIndex = bestKeyIndex;
				this.keyCooldowns.delete(bestKey);
				return result;
			} catch (err: any) {
				let cooldownMs = 10000;
				if (err.status === 401 || err.status === 403) {
					cooldownMs = 3600 * 1000;
				} else if (err.status === 429) {
					cooldownMs = (err.retryAfter ?? 10) * 1000;
				} else if (err.message && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit'))) {
					cooldownMs = parseRetryAfter(err.message) * 1000;
				}
				this.keyCooldowns.set(bestKey, Date.now() + cooldownMs);
				
				this.activeKeyIndex = (bestKeyIndex + 1) % activeKeys.length;
				lastError = err;
			}
		}

		throw lastError || new Error(`All configured API keys for ${this.name} failed.`);
	}

	private async handleStream(
		response: Response,
		onChunk: (text: string) => void,
		abortSignal?: AbortSignal,
	): Promise<ChatResult> {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let fullText = '';
		const accumulatedToolCalls: ToolCall[] = [];

		const abortListener = () => {
			reader.cancel().catch(() => {});
		};

		if (abortSignal) {
			if (abortSignal.aborted) {
				reader.cancel().catch(() => {});
				throw new Error('Aborted');
			}
			abortSignal.addEventListener('abort', abortListener);
		}

		let buffer = '';
		let usage: ChatResult['usage'] = undefined;
		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) { return; }
			if (!trimmed.startsWith('data: ')) { return; }
			const payload = trimmed.slice(6).trim();
			if (payload === '[DONE]') { return; }

			try {
				const parsed = JSON.parse(payload);
				if (parsed.error) {
					throw new Error(parsed.error.message || JSON.stringify(parsed.error));
				}
				const chunk = parsed as {
					choices?: {
						delta: {
							content?: string;
							tool_calls?: {
								index: number;
								id?: string;
								type?: 'function';
								function?: {
									name?: string;
									arguments?: string;
								};
							}[];
						}
					}[];
					usage?: {
						prompt_tokens?: number;
						completion_tokens?: number;
						total_tokens?: number;
					};
				};
				if (chunk.usage) {
					usage = {
						promptTokens: chunk.usage.prompt_tokens ?? 0,
						completionTokens: chunk.usage.completion_tokens ?? 0,
						totalTokens: chunk.usage.total_tokens ?? 0,
					};
				}
				const delta = chunk.choices?.[0]?.delta;
				if (delta) {
					const text = delta.content ?? '';
					if (text) {
						fullText += text;
						onChunk(text);
					}
					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index;
							if (!accumulatedToolCalls[idx]) {
								accumulatedToolCalls[idx] = {
									id: tc.id ?? '',
									type: 'function',
									function: {
										name: tc.function?.name ?? '',
										arguments: tc.function?.arguments ?? '',
									}
								};
							} else {
								if (tc.id) { accumulatedToolCalls[idx].id += tc.id; }
								if (tc.function?.name) { accumulatedToolCalls[idx].function.name += tc.function.name; }
								if (tc.function?.arguments) { accumulatedToolCalls[idx].function.arguments += tc.function.arguments; }
							}
						}
					}
				}
			} catch (err: any) {
				if (err instanceof Error && err.message.includes('API error')) {
					throw err;
				}
				// malformed chunk — skip
			}
		};

		try {
			while (true) {
				if (abortSignal?.aborted) {
					throw new Error('Aborted');
				}
				const { done, value } = await reader.read();
				if (done) { break; }

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					processLine(line);
				}
			}

			// Process remaining text in buffer after stream ends
			buffer += decoder.decode();
			if (buffer.trim()) {
				const lines = buffer.split('\n');
				for (const line of lines) {
					processLine(line);
				}
			}

		} finally {
			if (abortSignal) {
				abortSignal.removeEventListener('abort', abortListener);
			}
		}

		const toolCalls = accumulatedToolCalls.filter(Boolean);
		if (!fullText && toolCalls.length === 0) {
			throw new Error('Empty response received from model.');
		}
		return {
			content: fullText,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			usage,
		};
	}
}
