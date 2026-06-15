import { Model } from '../providers/IProvider';
import { IProvider } from '../providers/IProvider';
import { getModelProfile } from '../data/modelProfiles';

export class ModelRegistry {
	private models = new Map<string, Model>();

	async refresh(providers: IProvider[]): Promise<void> {
		this.models.clear();

		const results = await Promise.allSettled(
			providers.filter(p => p.isConfigured()).map(async (p) => {
				const liveModels = await p.listModels();
				return { providerName: p.name, liveModels };
			})
		);

		for (const result of results) {
			if (result.status === 'fulfilled') {
				const { providerName, liveModels } = result.value;
				for (const live of liveModels) {
					const profile = getModelProfile(providerName, live.id);
					if (profile) {
						this.models.set(`${providerName}::${live.id}`, {
							...profile,
							available: live.available,
						});
					} else {
						// Dynamically create a profile for unexpected live models
						this.models.set(`${providerName}::${live.id}`, {
							id: live.id,
							provider: providerName as any,
							displayName: live.id.split('/').pop()?.replace(/-/g, ' ') ?? live.id,
							contextLength: 32000,
							capabilities: { coding: 5, reasoning: 5, writing: 5, learning: 5, security: 5, speed: 5 },
							description: `Dynamically discovered model from ${providerName}.`,
							lastVerified: new Date().toISOString().split('T')[0],
							available: live.available,
						});
					}
				}
			}
		}
	}

	getAll(): Model[] {
		return [...this.models.values()];
	}

	getAvailable(): Model[] {
		return this.getAll().filter(m => m.available);
	}

	getById(provider: string, id: string): Model | undefined {
		return this.models.get(`${provider}::${id}`);
	}
}
