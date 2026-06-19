import * as vscode from 'vscode';
import { Model } from '../providers/IProvider';
import { IProvider } from '../providers/IProvider';
import { getModelProfile } from '../data/modelProfiles';

export class ModelRegistry {
	private models = new Map<string, Model>();
	private lastErrors = new Map<string, string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	async refresh(providers: IProvider[]): Promise<void> {
		this.models.clear();
		this.lastErrors.clear();

		const results = await Promise.allSettled(
			providers.filter(p => p.isConfigured()).map(async (p) => {
				try {
					const liveModels = await p.listModels();
					return { providerName: p.name, liveModels };
				} catch (err: any) {
					const msg = err instanceof Error ? err.message : String(err);
					this.lastErrors.set(p.name, msg);
					throw err;
				}
			})
		);

		for (const result of results) {
			if (result.status === 'fulfilled') {
				const { providerName, liveModels } = result.value;
				if (liveModels.length === 0) {
					this.lastErrors.set(providerName, 'No models returned by provider (check auth/key validity).');
				}
				for (const live of liveModels) {
					const profile = getModelProfile(providerName, live.id);
					if (profile) {
						this.models.set(`${providerName}::${live.id}`, {
							...profile,
							available: live.available,
						});
					}
				}
			}
		}
		this.onDidChangeEmitter.fire();
	}

	getLastErrors(): Map<string, string> {
		return this.lastErrors;
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
