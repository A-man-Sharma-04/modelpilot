import { LiveModel } from './IProvider';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

const BASE_URL = 'http://localhost:11434/v1';

export class OllamaProvider extends OpenAICompatibleProvider {
	readonly name = 'ollama';
	readonly baseUrl = BASE_URL;
	readonly apiKeys = ['dummy-key'];

	isConfigured(): boolean {
		return true;
	}

	protected getHeaders(key: string): Record<string, string> {
		return {
			'Content-Type': 'application/json',
		};
	}

	async listModels(): Promise<LiveModel[]> {
		try {
			const res = await fetch(`${this.baseUrl}/models`, {
				headers: this.getHeaders(''),
				signal: AbortSignal.timeout(3000),
			});
			if (!res.ok) {
				return [];
			}
			const data = await res.json() as { data: { id: string }[] };
			return data.data.map((m) => ({
				id: m.id,
				available: true,
			}));
		} catch {
			return [];
		}
	}
}
