import * as vscode from 'vscode';
import { getModelProfile } from '../data/modelProfiles';

export interface ProviderStats {
	requests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	totalLatencyMs: number;
	totalFallbacks: number;
}

export interface ModelStats {
	modelId: string;
	displayName: string;
	provider: string;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	commercialCost: number; // USD cost if run on paid APIs
	actualCost: number;     // USD actual cost charged (0 if free)
	totalLatencyMs: number;
}

export interface FineTuningRecord {
	timestamp: string;
	modelId: string;
	provider: string;
	messages: { role: string; content: string }[];
	response: string;
	latencyMs: number;
}

export interface AnalyticsData {
	providers: {
		nvidia: ProviderStats;
		groq: ProviderStats;
		openrouter: ProviderStats;
		cerebras: ProviderStats;
		google: ProviderStats;
		[key: string]: ProviderStats;
	};
	models: {
		[modelId: string]: ModelStats;
	};
	fineTuningData?: FineTuningRecord[];
}

const GLOBAL_STATE_KEY = 'modelpilot.analytics';

const INITIAL_STATS = (): ProviderStats => ({
	requests: 0,
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	totalLatencyMs: 0,
	totalFallbacks: 0,
});

export class AnalyticsManager {
	private onDidChangeEmitter = new vscode.EventEmitter<AnalyticsData>();
	public readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly globalState: vscode.Memento) {}

	public getData(): AnalyticsData {
		const saved = this.globalState.get<AnalyticsData>(GLOBAL_STATE_KEY);
		const defaultData: AnalyticsData = {
			providers: {
				nvidia: INITIAL_STATS(),
				groq: INITIAL_STATS(),
				openrouter: INITIAL_STATS(),
				cerebras: INITIAL_STATS(),
				google: INITIAL_STATS(),
			},
			models: {},
			fineTuningData: [],
		};

		if (saved) {
			const providers = { ...saved.providers };
			
			// Fill in missing properties for backward compatibility
			for (const p of Object.keys(providers)) {
				if (providers[p].totalLatencyMs === undefined) {
					providers[p].totalLatencyMs = 0;
				}
				if (providers[p].totalFallbacks === undefined) {
					providers[p].totalFallbacks = 0;
				}
			}

			if (!providers.nvidia) { providers.nvidia = INITIAL_STATS(); }
			if (!providers.groq) { providers.groq = INITIAL_STATS(); }
			if (!providers.openrouter) { providers.openrouter = INITIAL_STATS(); }
			if (!providers.cerebras) { providers.cerebras = INITIAL_STATS(); }
			if (!providers.google) { providers.google = INITIAL_STATS(); }

			return {
				providers,
				models: saved.models || {},
				fineTuningData: saved.fineTuningData || [],
			};
		}

		return defaultData;
	}

	public async recordRequest(
		providerName: string,
		modelId: string,
		promptTokens: number,
		completionTokens: number,
		latencyMs = 0,
		fallbackCount = 0,
		chatMessages?: { role: string; content: string }[],
		responseContent?: string
	): Promise<AnalyticsData> {
		const data = this.getData();
		const name = providerName.toLowerCase();

		// Record provider-level stats
		if (!data.providers[name]) {
			data.providers[name] = INITIAL_STATS();
		}
		data.providers[name].requests += 1;
		data.providers[name].promptTokens += promptTokens;
		data.providers[name].completionTokens += completionTokens;
		data.providers[name].totalTokens += promptTokens + completionTokens;
		data.providers[name].totalLatencyMs = (data.providers[name].totalLatencyMs || 0) + latencyMs;
		data.providers[name].totalFallbacks = (data.providers[name].totalFallbacks || 0) + fallbackCount;

		// Calculate cost savings based on specific model pricing
		const profile = getModelProfile(providerName, modelId);
		let inputRate = profile?.inputPricePerM;
		let outputRate = profile?.outputPricePerM;

		// Fallback rates if model is not defined in static profiles
		if (inputRate === undefined || outputRate === undefined) {
			if (name === 'nvidia' || name === 'groq') {
				// Standard large model default
				inputRate = 0.70;
				outputRate = 0.90;
			} else {
				// Paid models default
				inputRate = 1.00;
				outputRate = 2.00;
			}
		}

		const commercialCost = (promptTokens * inputRate) / 1000000.0 + (completionTokens * outputRate) / 1000000.0;
		
		// Determine actual charge (0 if free)
		const isFree = name === 'nvidia' || name === 'groq' || name === 'cerebras' || name === 'google' || modelId.endsWith(':free');
		const actualCost = isFree ? 0.0 : commercialCost;

		// Record model-level stats
		if (!data.models) {
			data.models = {};
		}
		if (!data.models[modelId]) {
			data.models[modelId] = {
				modelId,
				displayName: profile?.displayName || modelId,
				provider: providerName,
				requests: 0,
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				commercialCost: 0,
				actualCost: 0,
				totalLatencyMs: 0,
			};
		}

		const mStats = data.models[modelId];
		mStats.requests += 1;
		mStats.promptTokens += promptTokens;
		mStats.completionTokens += completionTokens;
		mStats.totalTokens += promptTokens + completionTokens;
		mStats.commercialCost += commercialCost;
		mStats.actualCost += actualCost;
		mStats.totalLatencyMs = (mStats.totalLatencyMs || 0) + latencyMs;

		// Record fine-tuning prompt-response pair
		if (chatMessages && chatMessages.length > 0 && responseContent) {
			if (!data.fineTuningData) {
				data.fineTuningData = [];
			}

			// Clean messages to simple format for fine-tuning
			const simplifiedMessages = chatMessages.map(m => ({
				role: String(m.role),
				content: String(m.content)
			}));

			data.fineTuningData.push({
				timestamp: new Date().toISOString(),
				modelId,
				provider: providerName,
				messages: simplifiedMessages,
				response: responseContent,
				latencyMs
			});

			// Cap fine-tuning records to avoid blowing up VS Code global storage limits
			if (data.fineTuningData.length > 1000) {
				data.fineTuningData = data.fineTuningData.slice(-1000);
			}
		}

		await this.globalState.update(GLOBAL_STATE_KEY, data);
		this.onDidChangeEmitter.fire(data);
		return data;
	}

	public async reset(): Promise<AnalyticsData> {
		const freshData: AnalyticsData = {
			providers: {
				nvidia: INITIAL_STATS(),
				groq: INITIAL_STATS(),
				openrouter: INITIAL_STATS(),
				cerebras: INITIAL_STATS(),
				google: INITIAL_STATS(),
			},
			models: {},
			fineTuningData: [],
		};
		await this.globalState.update(GLOBAL_STATE_KEY, freshData);
		this.onDidChangeEmitter.fire(freshData);
		return freshData;
	}

	public calculateSavings(data?: AnalyticsData): number {
		const stats = data || this.getData();
		let savings = 0.0;
		if (stats.models) {
			for (const modelId of Object.keys(stats.models)) {
				const m = stats.models[modelId];
				savings += (m.commercialCost - m.actualCost);
			}
		}
		return savings;
	}

	public getSavingsString(data?: AnalyticsData): string {
		const savings = this.calculateSavings(data);
		return `$${savings.toFixed(2)}`;
	}
}
