/**
 * modelProfiles.ts
 *
 * Single source of truth for all model metadata across providers.
 * Providers are responsible only for checking live availability.
 * Scores are 0–10 per dimension. lastVerified = date last confirmed available.
 */

export interface ModelCapabilities {
	coding:    number;
	reasoning: number;
	writing:   number;
	learning:  number;
	security:  number;
	speed:     number; // higher = faster / lower latency (smaller or optimised models)
}

export interface ModelProfile {
	id: string;
	provider: 'nvidia' | 'openrouter' | 'groq' | 'cerebras';
	displayName: string;
	contextLength: number;
	capabilities: ModelCapabilities;
	description: string;
	humanLabel?: string;        // e.g. "Best for HTB"
	lastVerified: string;       // ISO date string
	supportsNativeTools?: boolean;
	maxOutputTokens?: number;
	safeInputTokens?: number;
	inputPricePerM?: number;    // Price per million input tokens in USD (commercial paid rate)
	outputPricePerM?: number;   // Price per million output tokens in USD (commercial paid rate)
}

export const MODEL_PROFILES: ModelProfile[] = [

	// ─── NVIDIA NIM ───────────────────────────────────────────────────────────

	{
		id: 'deepseek-ai/deepseek-v4-pro',
		provider: 'nvidia',
		displayName: 'DeepSeek V4 Pro',
		contextLength: 128000,
		capabilities: { coding: 9, reasoning: 10, writing: 7, learning: 6, security: 10, speed: 3 },
		description: 'Frontier reasoning model with exceptional security and analysis capabilities.',
		humanLabel: 'Best for HTB & CTF',
		lastVerified: '2026-06-09',
		maxOutputTokens: 4096,
		safeInputTokens: 8000,
		inputPricePerM: 0.55,
		outputPricePerM: 2.19,
	},
	{
		id: 'deepseek-ai/deepseek-v4-flash',
		provider: 'nvidia',
		displayName: 'DeepSeek V4 Flash',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 9, writing: 6, learning: 6, security: 9, speed: 6 },
		description: 'Fast DeepSeek reasoning — great balance of speed and depth.',
		humanLabel: 'Best for Fast Reasoning',
		lastVerified: '2026-06-09',
		maxOutputTokens: 4096,
		safeInputTokens: 8000,
		inputPricePerM: 0.10,
		outputPricePerM: 0.20,
	},
	{
		id: 'meta/codellama-70b',
		provider: 'nvidia',
		displayName: 'Code Llama 70B',
		contextLength: 32000,
		capabilities: { coding: 8, reasoning: 5, writing: 4, learning: 6, security: 4, speed: 5 },
		description: "Meta's proven code model — reliable across languages.",
		lastVerified: '2026-06-09',
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'google/gemma-3n-e2b-it',
		provider: 'nvidia',
		displayName: 'Gemma 3n E2B',
		contextLength: 32000,
		capabilities: { coding: 4, reasoning: 4, writing: 5, learning: 9, security: 3, speed: 10 },
		description: 'Tiny 2B model — ultra-fast, great for quick questions.',
		humanLabel: 'Best for Quick Questions',
		lastVerified: '2026-06-09',
		inputPricePerM: 0.05,
		outputPricePerM: 0.05,
	},
	{
		id: 'google/gemma-3n-e4b-it',
		provider: 'nvidia',
		displayName: 'Gemma 3n E4B',
		contextLength: 32000,
		capabilities: { coding: 5, reasoning: 4, writing: 5, learning: 9, security: 3, speed: 10 },
		description: 'Fast 4B model — ideal for learning and quick explanations.',
		lastVerified: '2026-06-09',
		inputPricePerM: 0.07,
		outputPricePerM: 0.07,
	},
	{
		id: 'google/gemma-2-2b-it',
		provider: 'nvidia',
		displayName: 'Gemma 2 2B',
		contextLength: 8000,
		capabilities: { coding: 4, reasoning: 3, writing: 5, learning: 8, security: 2, speed: 10 },
		description: 'Compact Gemma 2 — fast responses for simple tasks.',
		lastVerified: '2026-06-09',
		maxOutputTokens: 512,
		safeInputTokens: 1500,
		inputPricePerM: 0.05,
		outputPricePerM: 0.05,
	},
	{
		id: 'meta/llama-3.2-1b-instruct',
		provider: 'nvidia',
		displayName: 'Llama 3.2 1B',
		contextLength: 128000,
		capabilities: { coding: 3, reasoning: 3, writing: 4, learning: 8, security: 2, speed: 10 },
		description: 'Smallest Llama — ultra-low latency, large context.',
		lastVerified: '2026-06-09',
		maxOutputTokens: 512,
		safeInputTokens: 2000,
		inputPricePerM: 0.05,
		outputPricePerM: 0.05,
	},
	{
		id: 'microsoft/phi-4-mini-instruct',
		provider: 'nvidia',
		displayName: 'Phi 4 Mini',
		contextLength: 16000,
		capabilities: { coding: 7, reasoning: 6, writing: 5, learning: 8, security: 4, speed: 9 },
		description: 'Microsoft Phi 4 Mini — efficient and surprisingly capable.',
		lastVerified: '2026-06-09',
		inputPricePerM: 0.07,
		outputPricePerM: 0.07,
	},
	{
		id: 'google/gemma-3-4b-it',
		provider: 'nvidia',
		displayName: 'Gemma 3 4B',
		contextLength: 32000,
		capabilities: { coding: 5, reasoning: 4, writing: 5, learning: 9, security: 3, speed: 9 },
		description: 'Small Gemma 3 — good for learning at speed.',
		lastVerified: '2026-06-09',
		inputPricePerM: 0.07,
		outputPricePerM: 0.07,
	},
	{
		id: 'google/gemma-3-12b-it',
		provider: 'nvidia',
		displayName: 'Gemma 3 12B',
		contextLength: 32000,
		capabilities: { coding: 6, reasoning: 5, writing: 7, learning: 8, security: 4, speed: 8 },
		description: 'Mid-size Gemma 3 — balanced speed and quality.',
		lastVerified: '2026-06-09',
		inputPricePerM: 0.15,
		outputPricePerM: 0.15,
	},
	{
		id: 'meta/llama-3.2-3b-instruct',
		provider: 'nvidia',
		displayName: 'Llama 3.2 3B',
		contextLength: 128000,
		capabilities: { coding: 4, reasoning: 4, writing: 5, learning: 8, security: 3, speed: 9 },
		description: 'Compact Llama with large context — quick learning tasks.',
		lastVerified: '2026-06-09',
		inputPricePerM: 0.15,
		outputPricePerM: 0.15,
	},
	{
		id: 'meta/llama-3.3-70b-instruct',
		provider: 'nvidia',
		displayName: 'Llama 3.3 70B',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 7, security: 6, speed: 6 },
		description: 'Meta Llama 3.3 70B — reliable all-rounder.',
		lastVerified: '2026-06-09',
		supportsNativeTools: true,
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'qwen/qwen3-coder-480b-a35b-instruct',
		provider: 'nvidia',
		displayName: 'Qwen 3 Coder 480B NIM',
		contextLength: 128000,
		capabilities: { coding: 10, reasoning: 8, writing: 7, learning: 6, security: 8, speed: 2 },
		description: 'Extremely powerful Qwen 3 Coder 480B NIM model optimized for coding.',
		lastVerified: '2026-06-19',
		inputPricePerM: 3.00,
		outputPricePerM: 9.00,
	},
	{
		id: 'nvidia/nemotron-3-ultra-550b-a55b',
		provider: 'nvidia',
		displayName: 'Nemotron 3 Ultra 550B NIM',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 10, writing: 7, learning: 7, security: 8, speed: 1 },
		description: 'NVIDIA Nemotron 3 Ultra 550B reasoning model.',
		lastVerified: '2026-06-19',
		inputPricePerM: 4.00,
		outputPricePerM: 12.00,
	},
	{
		id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
		provider: 'nvidia',
		displayName: 'Llama 3.1 Nemotron Ultra 253B NIM',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 9, writing: 7, learning: 7, security: 7, speed: 2 },
		description: 'NVIDIA Llama 3.1 Nemotron Ultra 253B NIM model.',
		lastVerified: '2026-06-19',
		inputPricePerM: 4.00,
		outputPricePerM: 12.00,
	},
	{
		id: 'mistralai/mistral-large-3-675b-instruct-2512',
		provider: 'nvidia',
		displayName: 'Mistral Large 3 675B NIM',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 8, writing: 10, learning: 7, security: 6, speed: 2 },
		description: 'Mistral Large 3 675B NIM model for writing and translation.',
		lastVerified: '2026-06-19',
		inputPricePerM: 4.00,
		outputPricePerM: 12.00,
	},
	{
		id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
		provider: 'nvidia',
		displayName: 'Llama 3.3 Nemotron Super 49B NIM',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 8, writing: 6, learning: 7, security: 6, speed: 6 },
		description: 'NVIDIA Llama 3.3 Nemotron Super 49B NIM model.',
		lastVerified: '2026-06-19',
		inputPricePerM: 0.50,
		outputPricePerM: 0.80,
	},

	// ─── OPENROUTER ───────────────────────────────────────────────────────────

	{
		id: 'qwen/qwen3-coder:free',
		provider: 'openrouter',
		displayName: 'Qwen 3 Coder (free)',
		contextLength: 128000,
		capabilities: { coding: 9, reasoning: 8, writing: 7, learning: 7, security: 7, speed: 6 },
		description: 'Qwen 3 Coder via OpenRouter free tier — highly optimized for coding and technical questions.',
		humanLabel: 'Best for Coding',
		lastVerified: '2026-06-11',
		inputPricePerM: 0.30,
		outputPricePerM: 0.40,
	},
	{
		id: 'meta-llama/llama-3.3-70b-instruct:free',
		provider: 'openrouter',
		displayName: 'Llama 3.3 70B (free)',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 7, security: 6, speed: 6 },
		description: 'Llama 3.3 70B via OpenRouter free tier — general purpose.',
		lastVerified: '2026-06-11',
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'google/gemma-4-31b-it:free',
		provider: 'openrouter',
		displayName: 'Gemma 4 31B (free)',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 8, writing: 8, learning: 8, security: 6, speed: 6 },
		description: 'Gemma 4 31B via OpenRouter free tier — balanced power and speed.',
		lastVerified: '2026-06-11',
		inputPricePerM: 0.35,
		outputPricePerM: 0.35,
	},
	{
		id: 'openai/gpt-oss-120b:free',
		provider: 'openrouter',
		displayName: 'GPT OSS 120B (free)',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 8, writing: 8, learning: 8, security: 7, speed: 5 },
		description: 'GPT-OSS-120B via OpenRouter free tier — large-scale open-source model.',
		lastVerified: '2026-06-11',
		inputPricePerM: 1.00,
		outputPricePerM: 2.00,
	},
	{
		id: 'meta-llama/llama-3.2-3b-instruct:free',
		provider: 'openrouter',
		displayName: 'Llama 3.2 3B (free)',
		contextLength: 128000,
		capabilities: { coding: 4, reasoning: 4, writing: 5, learning: 8, security: 3, speed: 9 },
		description: 'Llama 3.2 3B via OpenRouter free tier — fast response, great for learning.',
		lastVerified: '2026-06-11',
		inputPricePerM: 0.15,
		outputPricePerM: 0.15,
	},

	// ─── GROQ ─────────────────────────────────────────────────────────────────

	{
		id: 'llama-3.3-70b-versatile',
		provider: 'groq',
		displayName: 'Llama 3.3 70B (Groq)',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 7, security: 6, speed: 9 },
		description: 'Llama 3.3 70B on Groq — very fast inference.',
		humanLabel: 'Best for Speed',
		lastVerified: '2026-06-09',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'deepseek-r1-distill-llama-70b',
		provider: 'groq',
		displayName: 'DeepSeek R1 Distill (Groq)',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 8, writing: 5, learning: 5, security: 7, speed: 9 },
		description: 'DeepSeek R1 distilled on Groq — fast reasoning.',
		lastVerified: '2026-06-09',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'mixtral-8x7b-32768',
		provider: 'groq',
		displayName: 'Mixtral 8x7B (Groq)',
		contextLength: 32768,
		capabilities: { coding: 6, reasoning: 6, writing: 7, learning: 7, security: 5, speed: 9 },
		description: 'Mixtral 8x7B on Groq — fast and reliable.',
		lastVerified: '2026-06-09',
		maxOutputTokens: 2048,
		safeInputTokens: 4000,
		inputPricePerM: 0.24,
		outputPricePerM: 0.24,
	},
	{
		id: 'gemma2-9b-it',
		provider: 'groq',
		displayName: 'Gemma 2 9B (Groq)',
		contextLength: 8192,
		capabilities: { coding: 5, reasoning: 5, writing: 6, learning: 8, security: 3, speed: 10 },
		description: 'Gemma 2 9B on Groq — fastest available for simple tasks.',
		lastVerified: '2026-06-09',
		maxOutputTokens: 1024,
		safeInputTokens: 3000,
		inputPricePerM: 0.06,
		outputPricePerM: 0.06,
	},

	// ─── CEREBRAS ─────────────────────────────────────────────────────────────

	{
		id: 'llama3.1-8b',
		provider: 'cerebras',
		displayName: 'Llama 3.1 8B (Cerebras)',
		contextLength: 8192,
		capabilities: { coding: 5, reasoning: 4, writing: 5, learning: 8, security: 3, speed: 10 },
		description: 'Ultra-fast Llama 3.1 8B on Cerebras — ideal for intent classification and quick tasks.',
		humanLabel: 'Best for Classification',
		lastVerified: '2026-06-19',
		maxOutputTokens: 1024,
		safeInputTokens: 3000,
		inputPricePerM: 0.10,
		outputPricePerM: 0.10,
	},
	{
		id: 'llama-3.3-70b',
		provider: 'cerebras',
		displayName: 'Llama 3.3 70B (Cerebras)',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 7, security: 6, speed: 9 },
		description: 'Llama 3.3 70B on Cerebras — fast general-purpose inference.',
		lastVerified: '2026-06-19',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'llama-4-scout-17b-16e-instruct',
		provider: 'cerebras',
		displayName: 'Llama 4 Scout 17B (Cerebras)',
		contextLength: 128000,
		capabilities: { coding: 6, reasoning: 6, writing: 7, learning: 7, security: 5, speed: 9 },
		description: 'Llama 4 Scout 17B MoE on Cerebras — balanced speed and quality.',
		lastVerified: '2026-06-19',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.20,
		outputPricePerM: 0.60,
	},
	{
		id: 'gpt-oss-120b',
		provider: 'cerebras',
		displayName: 'GPT OSS 120B (Cerebras)',
		contextLength: 131072,
		capabilities: { coding: 8, reasoning: 8, writing: 8, learning: 8, security: 7, speed: 8 },
		description: 'GPT-OSS 120B MoE on Cerebras — high-quality reasoning at speed.',
		lastVerified: '2026-06-19',
		inputPricePerM: 1.00,
		outputPricePerM: 2.00,
	},
	{
		id: 'zai-glm-4.7',
		provider: 'cerebras',
		displayName: 'GLM 4.7 (Cerebras)',
		contextLength: 131072,
		capabilities: { coding: 9, reasoning: 9, writing: 8, learning: 8, security: 8, speed: 8 },
		description: 'Z.ai GLM 4.7 355B on Cerebras — programming-focused large model.',
		humanLabel: 'Best for Coding (Fast)',
		lastVerified: '2026-06-19',
		inputPricePerM: 2.00,
		outputPricePerM: 4.00,
	},
];

/** Look up a model profile by provider + id. */
export function getModelProfile(provider: string, id: string): ModelProfile | undefined {
	return MODEL_PROFILES.find(m => m.provider === provider && m.id === id);
}

/** Get all profiles for a specific provider. */
export function getProfilesForProvider(provider: string): ModelProfile[] {
	return MODEL_PROFILES.filter(m => m.provider === provider);
}
