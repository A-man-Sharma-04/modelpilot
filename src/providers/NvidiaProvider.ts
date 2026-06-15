import { LiveModel } from './IProvider';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { MODEL_PROFILES } from '../data/modelProfiles';

const BASE_URL = 'https://integrate.api.nvidia.com/v1';

export class NvidiaProvider extends OpenAICompatibleProvider {
	readonly name = 'nvidia';
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
				return [];
			}
			return MODEL_PROFILES
				.filter(m => m.provider === 'nvidia' && !m.id.toLowerCase().includes('gemma'))
				.map(m => ({ id: m.id, available: true }));
		}

		try {
			const data = await response.json() as { data: { id: string }[] };
			const liveIds = new Set(data.data.map((m: { id: string }) => m.id));

			const result: LiveModel[] = MODEL_PROFILES
				.filter(m => m.provider === 'nvidia' && !m.id.toLowerCase().includes('gemma'))
				.map(m => ({
					id: m.id,
					available: liveIds.has(m.id),
				}));

			// Also return any other live models not in our static metadata as available
			const staticIds = new Set(result.map(r => r.id));
			for (const id of liveIds) {
				if (staticIds.has(id)) { continue; }
				if (id.toLowerCase().includes('gemma')) { continue; }
				if (/embed|safety|reward|guard|clip|vila|deplot|kosmos|parse|detector|retriev/i.test(id)) { continue; }
				result.push({ id, available: true });
			}

			return result;
		} catch {
			return MODEL_PROFILES
				.filter(m => m.provider === 'nvidia' && !m.id.toLowerCase().includes('gemma'))
				.map(m => ({ id: m.id, available: true }));
		}

	}
}
