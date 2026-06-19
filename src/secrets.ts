import * as vscode from 'vscode';

const KEYS = {
	nvidia:      'modelpilot.nvidia.apikey',
	openrouter:  'modelpilot.openrouter.apikey',
	groq:        'modelpilot.groq.apikey',
	cerebras:    'modelpilot.cerebras.apikey',
} as const;

export type ProviderName = keyof typeof KEYS;

export class SecretsManager {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	async get(provider: ProviderName): Promise<string[]> {
		const raw = await this.secrets.get(KEYS[provider]) ?? '';
		if (!raw) {
			return [];
		}
		if (raw.trim().startsWith('[')) {
			try {
				const parsed = JSON.parse(raw);
				const arr = Array.isArray(parsed) ? parsed : [parsed];
				return arr.map((x: any) => String(x).trim()).filter((x: string) => x.length > 0);
			} catch {
				return [raw.trim()];
			}
		}
		return [raw.trim()];
	}

	async set(provider: ProviderName, values: string[]): Promise<void> {
		const uniqueValues = Array.from(new Set(values.map(v => v.trim()).filter(v => v.length > 0)));
		await this.secrets.store(KEYS[provider], JSON.stringify(uniqueValues));
	}

	async delete(provider: ProviderName): Promise<void> {
		await this.secrets.delete(KEYS[provider]);
	}

	async getAll(): Promise<Record<ProviderName, string[]>> {
		const [nvidia, openrouter, groq, cerebras] = await Promise.all([
			this.get('nvidia'),
			this.get('openrouter'),
			this.get('groq'),
			this.get('cerebras'),
		]);
		return { nvidia, openrouter, groq, cerebras };
	}
}
