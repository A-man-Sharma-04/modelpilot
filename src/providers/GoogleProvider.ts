import { LiveModel } from './IProvider';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { MODEL_PROFILES } from '../data/modelProfiles';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export class GoogleProvider extends OpenAICompatibleProvider {
	readonly name = 'google';
	readonly baseUrl = BASE_URL;

	constructor(readonly apiKeys: string[]) {
		super();
	}

	async listModels(): Promise<LiveModel[]> {
		if (!this.isConfigured()) {
			return [];
		}

		const activeKeys = this.apiKeys.filter(k => k.trim().length > 0);
		let response: Response | undefined;
		let authFailed = false;

		for (const key of activeKeys) {
			try {
				const res = await fetch(`${this.baseUrl}/models`, {
					headers: this.getHeaders(key),
				});
				if (res.ok) {
					response = res;
					break;
				} else if (res.status === 401 || res.status === 403) {
					authFailed = true;
				}
			} catch {
				// Try next key
			}
		}

		if (!response || !response.ok) {
			if (authFailed) {
				throw new Error('Authentication failed (401/403). Please verify your API key.');
			}
			return MODEL_PROFILES
				.filter(m => m.provider === 'google')
				.map(m => ({ id: m.id, available: true }));
		}

		try {
			const data = await response.json() as { data: { id: string }[] };
			const liveIds = new Set(data.data.map((m: { id: string }) => m.id));

			return MODEL_PROFILES
				.filter(m => m.provider === 'google')
				.map(m => ({
					id: m.id,
					available: liveIds.has(m.id),
				}));
		} catch {
			return MODEL_PROFILES
				.filter(m => m.provider === 'google')
				.map(m => ({ id: m.id, available: true }));
		}
	}
}
