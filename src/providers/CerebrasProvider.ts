import { LiveModel, Message, Tool, ChatOptions, ChatResult } from './IProvider';
import { OpenAICompatibleProvider, isFuzzyModelMatch } from './OpenAICompatibleProvider';
import { MODEL_PROFILES } from '../data/modelProfiles';
import { debugLog } from '../debug';

const BASE_URL = 'https://api.cerebras.ai/v1';

export class CerebrasProvider extends OpenAICompatibleProvider {
	readonly name = 'cerebras';
	readonly baseUrl = BASE_URL;

	constructor(readonly apiKeys: string[]) {
		super();
	}

	override async chat(
		modelId: string,
		messages: Message[],
		tools?: Tool[],
		context?: any,
		options: ChatOptions = {},
	): Promise<ChatResult> {
		const log = (msg: string) => debugLog('cerebras', msg);
		log(`chat() called for model: ${modelId}`);
		try {
			const res = await super.chat(modelId, messages, tools, context, options);
			log(`chat() succeeded for model: ${modelId}`);
			return res;
		} catch (err: any) {
			log(`chat() failed for model: ${modelId}. Error: ${err instanceof Error ? err.message : String(err)}`);
			throw err;
		}
	}

	async listModels(): Promise<LiveModel[]> {
		const log = (msg: string) => debugLog('cerebras', msg);
		log('listModels() called');

		if (!this.isConfigured()) {
			log('Provider not configured (no keys)');
			return [];
		}

		const activeKeys = this.apiKeys.filter(k => k.trim().length > 0);
		log(`Active keys count: ${activeKeys.length}`);
		let response: Response | undefined;
		let authFailed = false;

		for (let i = 0; i < activeKeys.length; i++) {
			const key = activeKeys[i];
			try {
				log(`Attempting fetch for key index ${i}...`);
				const res = await fetch(`${this.baseUrl}/models`, {
					headers: this.getHeaders(key),
				});
				log(`Fetch status for key index ${i}: ${res.status} ${res.statusText}`);
				if (res.ok) {
					response = res;
					break;
				} else {
					const body = await res.text();
					log(`Error body for key index ${i}: ${body}`);
					if (res.status === 401 || res.status === 403) {
						authFailed = true;
					}
				}
			} catch (err: any) {
				log(`Fetch exception for key index ${i}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (!response || !response.ok) {
			log(`No successful response. authFailed=${authFailed}`);
			return MODEL_PROFILES
				.filter(m => m.provider === 'cerebras')
				.map(m => ({ id: m.id, available: true }));
		}

		try {
			const data = await response.json() as { data: { id: string }[] };
			const liveIds = data.data.map((m: { id: string }) => m.id);
			log(`Successfully retrieved model IDs from Cerebras: ${JSON.stringify(liveIds)}`);

			const mapped = MODEL_PROFILES
				.filter(m => m.provider === 'cerebras')
				.map(m => ({
					id: m.id,
					available: isFuzzyModelMatch(m.id, liveIds),
				}));

			for (const id of liveIds) {
				if (!mapped.some(m => m.id === id)) {
					mapped.push({ id, available: true });
				}
			}

			log(`Mapped models: ${JSON.stringify(mapped)}`);
			return mapped;
		} catch (err: any) {
			log(`JSON parse exception: ${err instanceof Error ? err.message : String(err)}`);
			return MODEL_PROFILES
				.filter(m => m.provider === 'cerebras')
				.map(m => ({ id: m.id, available: true }));
		}
	}
}

