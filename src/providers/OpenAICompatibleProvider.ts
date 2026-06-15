import { IProvider, Message, LiveModel, ChatOptions, Tool, ToolCall, ChatResult } from './IProvider';

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

export abstract class OpenAICompatibleProvider implements IProvider {
	abstract readonly name: string;
	abstract readonly baseUrl: string;
	abstract readonly apiKeys: string[];

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

	async chat(
		modelId: string,
		messages: Message[],
		tools?: Tool[],
		context?: any,
		options: ChatOptions = {},
	): Promise<ChatResult> {
		let lastError: Error | undefined;

		const activeKeys = this.apiKeys.filter(k => k.trim().length > 0);
		if (activeKeys.length === 0) {
			throw new Error(`Provider ${this.name} has no API keys configured.`);
		}

		for (let keyIndex = 0; keyIndex < activeKeys.length; keyIndex++) {
			const activeKey = activeKeys[keyIndex];

			try {
				const useNativeTools = tools && tools.length > 0 && this.name !== 'groq';
				const body: any = {
					model: modelId,
					messages: useNativeTools ? messages : formatMessagesForNonNativeTools(messages),
					max_tokens: options.maxTokens ?? 2048,
					stream: options.stream ?? false,
				};
				if (useNativeTools) {
					body.tools = tools;
				}

				let response: Response | undefined;
				const maxRetries = 2; // Allow up to 2 retries (3 attempts total) per key
				let attempt = 0;

				while (attempt <= maxRetries) {
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
						response = await fetch(`${this.baseUrl}/chat/completions`, {
							method: 'POST',
							headers: this.getHeaders(activeKey),
							body: JSON.stringify(body),
							signal: attemptController.signal,
						});

						clearTimeout(attemptTimeout);
						if (options.abortSignal) {
							options.abortSignal.removeEventListener('abort', abortListener);
						}

						if (response.status === 429 && attempt < maxRetries) {
							const retryAfterHeader = response.headers.get('retry-after') || response.headers.get('Retry-After');
							let retryDelay = 2000;
							if (retryAfterHeader) {
								const seconds = parseInt(retryAfterHeader, 10);
								if (!isNaN(seconds)) {
									retryDelay = seconds * 1000;
								} else {
									const date = Date.parse(retryAfterHeader);
									if (!isNaN(date)) {
										retryDelay = Math.max(0, date - Date.now());
									}
								}
							}

							if (retryDelay > 3000) {
								throw new Error(`Rate limit exceeded (429). Retry-after delay is too long (${Math.round(retryDelay / 1000)}s).`);
							}

							console.warn(`Key index ${keyIndex} for provider ${this.name} hit 429. Retrying attempt ${attempt + 1}/${maxRetries} after ${retryDelay}ms...`);

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
								}, retryDelay);
								if (options.abortSignal) {
									options.abortSignal.addEventListener('abort', onAbort);
								}
							});
							attempt++;
							continue;
						}

						break;
					} catch (err: any) {
						clearTimeout(attemptTimeout);
						if (options.abortSignal) {
							options.abortSignal.removeEventListener('abort', abortListener);
						}

						let reason = err instanceof Error ? err.message : String(err);
						if (err && typeof err === 'object' && 'cause' in err && err.cause) {
							const causeMsg = err.cause.message || String(err.cause);
							reason += ` (${causeMsg})`;
						}
						if (attemptTimedOut) {
							reason = `Request timed out after ${(options.timeout ?? 30000) / 1000} seconds.`;
						}

						if (options.abortSignal?.aborted || reason.includes('Aborted') || reason.includes('AbortError')) {
							throw new Error(reason);
						}

						// If the request timed out, has DNS lookup failures, or hit a long rate limit, fail immediately without retrying
						if (attemptTimedOut || reason.includes('EAI_AGAIN') || reason.includes('ENOTFOUND') || reason.includes('429') || reason.includes('Rate limit')) {
							throw new Error(reason);
						}

						if (attempt < maxRetries) {
							const retryDelay = 2000;
							console.warn(`Key index ${keyIndex} for provider ${this.name} failed (${reason}). Retrying attempt ${attempt + 1}/${maxRetries} after ${retryDelay}ms...`);
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
								}, retryDelay);
								if (options.abortSignal) {
									options.abortSignal.addEventListener('abort', onAbort);
								}
							});
							attempt++;
							continue;
						}

						throw new Error(reason);
					}
				}

				if (!response) {
					throw new Error(`Failed to get response from ${this.name}`);
				}

				if (!response.ok) {
					const errText = await response.text();

					if ((response.status === 400 || response.status === 422 || response.status === 404 || response.status === 501) && tools && tools.length > 0 && this.name !== 'groq') {
						console.warn(`Provider ${this.name} failed with status ${response.status} when passing tools. Retrying without native tools...`);
						const bodyWithoutTools = { ...body };
						delete bodyWithoutTools.tools;
						bodyWithoutTools.messages = formatMessagesForNonNativeTools(
							bodyWithoutTools.messages.filter((m: Message) =>
								!(m.role === 'system' && (m.content.includes('[TOOL CALLING INSTRUCTION]') || m.content.includes('[Current Workspace Context]')))
							)
						);

						const fallbackController = new AbortController();
						let fallbackTimedOut = false;
						const fallbackTimeout = setTimeout(() => {
							fallbackTimedOut = true;
							fallbackController.abort();
						}, options.timeout ?? 30000);

						const fallbackAbortListener = () => {
							fallbackController.abort();
						};
						if (options.abortSignal) {
							if (options.abortSignal.aborted) {
								fallbackController.abort();
							} else {
								options.abortSignal.addEventListener('abort', fallbackAbortListener);
							}
						}

						try {
							const retryResponse = await fetch(`${this.baseUrl}/chat/completions`, {
								method: 'POST',
								headers: this.getHeaders(activeKey),
								body: JSON.stringify(bodyWithoutTools),
								signal: fallbackController.signal,
							});

							clearTimeout(fallbackTimeout);
							if (options.abortSignal) {
								options.abortSignal.removeEventListener('abort', fallbackAbortListener);
							}

							if (retryResponse.ok) {
								if (options.stream && options.onChunk) {
									return await this.handleStream(retryResponse, options.onChunk, options.abortSignal);
								}
								const data = await retryResponse.json() as any;
								const msg = data.choices[0].message;
								return {
									content: msg.content ?? '',
									toolCalls: undefined,
								};
							}

							response = retryResponse;
						} catch (fallbackErr: any) {
							clearTimeout(fallbackTimeout);
							if (options.abortSignal) {
								options.abortSignal.removeEventListener('abort', fallbackAbortListener);
							}
							let fallbackReason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
							if (fallbackErr && typeof fallbackErr === 'object' && 'cause' in fallbackErr && fallbackErr.cause) {
								const causeMsg = fallbackErr.cause.message || String(fallbackErr.cause);
								fallbackReason += ` (${causeMsg})`;
							}
							if (fallbackTimedOut) {
								fallbackReason = `Request timed out after ${(options.timeout ?? 30000) / 1000} seconds.`;
							}
							throw new Error(fallbackReason);
						}
					}

					// If rate-limited (429) or server error (502/503/504) and we have more keys, rotate
					if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && keyIndex < activeKeys.length - 1) {
						console.warn(`Key index ${keyIndex} for provider ${this.name} hit error ${response.status}. Rotating key...`);
						continue;
					}
					throw new Error(`${this.name} API error ${response.status}: ${errText}`);
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
					}[]
				};
				const msg = data.choices[0].message;
				return {
					content: msg.content ?? '',
					toolCalls: msg.tool_calls,
				};
			} catch (err: any) {
				let reason = err instanceof Error ? err.message : String(err);
				if (err && typeof err === 'object' && 'cause' in err && err.cause) {
					const causeMsg = err.cause.message || String(err.cause);
					reason += ` (${causeMsg})`;
				}

				if (options.abortSignal?.aborted || reason.includes('Aborted') || reason.includes('AbortError')) {
					throw new Error(reason);
				}

				if (keyIndex < activeKeys.length - 1) {
					console.warn(`Key index ${keyIndex} for provider ${this.name} failed (${reason}). Rotating key...`);
					lastError = new Error(reason);
					continue;
				}
				throw new Error(reason);
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

		try {
			while (true) {
				if (abortSignal?.aborted) {
					throw new Error('Aborted');
				}
				const { done, value } = await reader.read();
				if (done) { break; }

			const lines = decoder.decode(value).split('\n');
			for (const line of lines) {
				if (!line.startsWith('data: ')) { continue; }
				const payload = line.slice(6).trim();
				if (payload === '[DONE]') { break; }

				try {
					const parsed = JSON.parse(payload);
					if (parsed.error) {
						throw new Error(parsed.error.message || JSON.stringify(parsed.error));
					}
					const chunk = parsed as {
						choices: {
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
						}[]
					};
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
				} catch {
					// malformed chunk — skip
				}
			}
		}

		} finally {
			if (abortSignal) {
				abortSignal.removeEventListener('abort', abortListener);
			}
		}

		const toolCalls = accumulatedToolCalls.filter(Boolean);
		return {
			content: fullText,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		};
	}
}
