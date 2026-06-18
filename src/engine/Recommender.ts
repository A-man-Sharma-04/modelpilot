import { Model } from '../providers/IProvider';
import { ModelRegistry } from '../registry/ModelRegistry';
import { getExpertProfile } from '../data/expertProfiles';
import { ModelCapabilities } from '../data/modelProfiles';

export interface Recommendation {
	model: Model;
	rank: number;
	reason: string;
}

export class Recommender {
	constructor(private readonly registry: ModelRegistry) { }

	recommend(expertId: string, limit = 5, inputTokens = 0): Recommendation[] {
		const expert = getExpertProfile(expertId);
		if (!expert) {
			return [];
		}

		const available = this.registry.getAvailable();

		const eligible = inputTokens > 0
			? available.filter(m => {
				const safe = (m as any).safeInputTokens
					?? Math.floor((m.contextLength / 4) * 0.75);
				return safe >= inputTokens;
			})
			: available;

		const scored: { model: Model; score: number }[] = [];

		for (const model of eligible) {
			let score = 0;
			// Compute weighted score based on expert's weights
			for (const [dim, weight] of Object.entries(expert.scoringWeights)) {
				const capValue = model.capabilities[dim as keyof ModelCapabilities] ?? 5;
				score += capValue * (weight ?? 0);
			}
			// Add provider tie-breaker: groq > openrouter > nvidia
			let providerBonus = model.provider === 'groq' ? 4.0 : (model.provider === 'openrouter' ? 1.5 : 0);
			if ((expertId === 'learning' || expertId === 'general') && model.provider === 'groq') {
				providerBonus += 20.0;
			}
			score += providerBonus;
			scored.push({ model, score });
		}

		// Sort descending by score
		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((s, i) => ({
				model: s.model,
				rank: i + 1,
				reason: this.buildReason(s.model, expertId),
			}));
	}

	recommendForSpeed(limit = 6): Recommendation[] {
		const available = this.registry.getAvailable();
		const scored = available.map(model => {
			const providerBonus = model.provider === 'groq' ? 15 : (model.provider === 'openrouter' ? 5 : 0);
			return {
				model,
				score: (model.capabilities.speed ?? 5) * 10 + providerBonus
			};
		});

		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((s, i) => ({
				model: s.model,
				rank: i + 1,
				reason: `Optimized for low-latency responses (Speed ${s.model.capabilities.speed}/10)`
			}));
	}

	private buildReason(model: Model, expertId: string): string {
		const expert = getExpertProfile(expertId);
		if (!expert) { return model.description; }

		const reasons: string[] = [];

		// If there is a curated human label, highlight it first
		if (model.humanLabel) {
			reasons.push(model.humanLabel);
		}

		// List positive capability attributes
		const topDims = Object.keys(expert.scoringWeights) as (keyof ModelCapabilities)[];
		const details = topDims
			.map(dim => {
				const val = model.capabilities[dim];
				const name = dim === 'security' ? 'Security analysis' : dim.charAt(0).toUpperCase() + dim.slice(1);
				if (val >= 9) { return `exceptional ${name.toLowerCase()} (${val}/10)`; }
				if (val >= 7) { return `strong ${name.toLowerCase()} (${val}/10)`; }
				return undefined;
			})
			.filter(Boolean);

		if (details.length > 0) {
			reasons.push(details.join(', '));
		}

		if (model.contextLength >= 128000) {
			reasons.push('large 128k context');
		}

		if (reasons.length > 0) {
			// Capitalize the first letter
			const combined = reasons.join(' · ');
			return combined.charAt(0).toUpperCase() + combined.slice(1);
		}

		return model.description;
	}
}
