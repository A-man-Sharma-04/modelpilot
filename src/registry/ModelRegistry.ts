import * as vscode from 'vscode';
import { Model } from '../providers/IProvider';
import { IProvider } from '../providers/IProvider';
import { getModelProfile } from '../data/modelProfiles';

function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(errorMsg)), ms);
		promise.then(
			(res) => {
				clearTimeout(timer);
				resolve(res);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

export class ModelRegistry {
	private models = new Map<string, Model>();
	private lastErrors = new Map<string, string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	async refresh(providers: IProvider[]): Promise<void> {
		const newModels = new Map<string, Model>();
		const newErrors = new Map<string, string>();

		const results = await Promise.allSettled(
			providers.filter(p => p.isConfigured()).map(async (p) => {
				try {
					const liveModels = await withTimeout(
						p.listModels(),
						5000,
						`Listing models for ${p.name} timed out after 5.0s`
					);
					return { providerName: p.name, liveModels };
				} catch (err: any) {
					const msg = err instanceof Error ? err.message : String(err);
					newErrors.set(p.name, msg);
					throw err;
				}
			})
		);

		for (const result of results) {
			if (result.status === 'fulfilled') {
				const { providerName, liveModels } = result.value;
				if (liveModels.length === 0) {
					newErrors.set(providerName, 'No models returned by provider (check auth/key validity).');
				}
				for (const live of liveModels) {
					const profile = getModelProfile(providerName, live.id);
					if (profile) {
						newModels.set(`${providerName}::${live.id}`, {
							...profile,
							available: live.available,
						});
					} else {
						newModels.set(`${providerName}::${live.id}`, {
							id: live.id,
							provider: providerName as any,
							displayName: `${providerName === 'cerebras' ? 'Cerebras' : providerName} ${live.id}`,
							contextLength: 8192,
							capabilities: {
								coding: 7,
								reasoning: 7,
								writing: 7,
								learning: 7,
								security: 7,
								speed: 7,
							},
							description: 'Dynamically discovered model.',
							lastVerified: new Date().toISOString().split('T')[0],
							available: live.available,
						});
					}
				}
			}
		}

		this.models = newModels;
		this.lastErrors = newErrors;
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
