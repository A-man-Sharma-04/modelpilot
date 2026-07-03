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
	provider: 'nvidia' | 'openrouter' | 'groq' | 'cerebras' | 'google';
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

	// ─── NVIDIA NIM ───────────────────────────────────────────────────────────

	{
		id: 'deepseek-ai/deepseek-r1',
		provider: 'nvidia',
		displayName: 'DeepSeek R1 (NVIDIA)',
		contextLength: 128000,
		capabilities: { coding: 9, reasoning: 10, writing: 8, learning: 8, security: 9, speed: 2 },
		description: 'DeepSeek R1 frontier reasoning model on NVIDIA NIM.',
		humanLabel: 'Best for Reasoning',
		lastVerified: '2026-06-28',
		maxOutputTokens: 4096,
		safeInputTokens: 8000,
		inputPricePerM: 0.55,
		outputPricePerM: 2.19,
	},
	{
		id: 'meta/llama-3.1-405b-instruct',
		provider: 'nvidia',
		displayName: 'Llama 3.1 405B (NVIDIA)',
		contextLength: 128000,
		capabilities: { coding: 9, reasoning: 9, writing: 8, learning: 8, security: 8, speed: 2 },
		description: 'Meta flagship Llama 3.1 405B model on NVIDIA NIM.',
		lastVerified: '2026-06-28',
		inputPricePerM: 2.66,
		outputPricePerM: 2.66,
	},
	{
		id: 'qwen/qwen-2.5-coder-32b-instruct',
		provider: 'nvidia',
		displayName: 'Qwen 2.5 Coder 32B (NVIDIA)',
		contextLength: 32000,
		capabilities: { coding: 9, reasoning: 8, writing: 7, learning: 7, security: 7, speed: 6 },
		description: 'Qwen 2.5 Coder 32B on NVIDIA NIM — highly optimized for coding.',
		humanLabel: 'Best for Coding',
		lastVerified: '2026-06-28',
		inputPricePerM: 0.30,
		outputPricePerM: 0.40,
	},
	{
		id: 'nvidia/llama-3.1-nemotron-51b-instruct',
		provider: 'nvidia',
		displayName: 'Llama 3.1 Nemotron 51B (NVIDIA)',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 9, writing: 8, learning: 8, security: 7, speed: 7 },
		description: 'NVIDIA customized Llama 3.1 51B model for advanced reasoning and writing.',
		lastVerified: '2026-06-28',
		inputPricePerM: 0.51,
		outputPricePerM: 0.51,
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
		id: 'microsoft/phi-4',
		provider: 'nvidia',
		displayName: 'Phi 4 (NVIDIA)',
		contextLength: 16000,
		capabilities: { coding: 7, reasoning: 8, writing: 6, learning: 8, security: 5, speed: 8 },
		description: 'Microsoft Phi 4 on NVIDIA NIM — advanced reasoning and coding.',
		lastVerified: '2026-06-28',
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

	// ─── OPENROUTER ───────────────────────────────────────────────────────────

	{
		id: 'deepseek/deepseek-r1:free',
		provider: 'openrouter',
		displayName: 'DeepSeek R1 (free)',
		contextLength: 160000,
		capabilities: { coding: 9, reasoning: 10, writing: 8, learning: 8, security: 9, speed: 2 },
		description: 'DeepSeek R1 reasoning model via OpenRouter free tier.',
		humanLabel: 'Best for Reasoning',
		lastVerified: '2026-06-28',
		inputPricePerM: 0.55,
		outputPricePerM: 2.19,
	},
	{
		id: 'qwen/qwen-2.5-coder-32b-instruct:free',
		provider: 'openrouter',
		displayName: 'Qwen 2.5 Coder 32B (free)',
		contextLength: 128000,
		capabilities: { coding: 9, reasoning: 8, writing: 7, learning: 7, security: 7, speed: 6 },
		description: 'Qwen 2.5 Coder 32B via OpenRouter free tier — highly optimized for coding.',
		humanLabel: 'Best for Coding',
		lastVerified: '2026-06-28',
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
		description: 'Llama 3.3 70B on Groq — very fast inference. (Deprecated, decommission on August 16, 2026)',
		humanLabel: 'Best for Speed',
		lastVerified: '2026-06-29',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'openai/gpt-oss-120b',
		provider: 'groq',
		displayName: 'GPT-OSS 120B (Groq)',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 9, writing: 8, learning: 8, security: 8, speed: 9 },
		description: 'OpenAI GPT-OSS 120B MoE model — exceptional reasoning, speed, and capabilities.',
		humanLabel: 'Best for Speed & Reasoning',
		lastVerified: '2026-06-29',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'qwen/qwen3.6-27b',
		provider: 'groq',
		displayName: 'Qwen 3.6 27B (Groq)',
		contextLength: 128000,
		capabilities: { coding: 9, reasoning: 8, writing: 7, learning: 8, security: 8, speed: 9 },
		description: 'Qwen 3.6 27B — state-of-the-art agentic coding and reasoning performance.',
		humanLabel: 'Best for Coding & Speed',
		lastVerified: '2026-06-29',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.35,
		outputPricePerM: 0.35,
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
		id: 'llama3.1-70b',
		provider: 'cerebras',
		displayName: 'Llama 3.1 70B (Cerebras)',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 7, security: 6, speed: 9 },
		description: 'Llama 3.1 70B on Cerebras — ultra-fast inference.',
		lastVerified: '2026-06-29',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.60,
		outputPricePerM: 0.80,
	},
	{
		id: 'gpt-oss-120b',
		provider: 'cerebras',
		displayName: 'GPT-OSS 120B (Cerebras)',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 9, writing: 8, learning: 8, security: 8, speed: 9 },
		description: 'OpenAI GPT-OSS 120B MoE model on Cerebras — ultra-fast reasoning, speed, and capabilities.',
		humanLabel: 'Best for Speed & Reasoning',
		lastVerified: '2026-06-29',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.70,
		outputPricePerM: 0.90,
	},
	{
		id: 'zai-glm-4.7',
		provider: 'cerebras',
		displayName: 'Z.ai GLM 4.7 (Cerebras)',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 8, writing: 7, learning: 8, security: 8, speed: 9 },
		description: 'Zhipu AI GLM 4.7 MoE model on Cerebras — optimized for agentic coding and stable multi-turn reasoning.',
		humanLabel: 'Best for Coding & Speed',
		lastVerified: '2026-06-29',
		maxOutputTokens: 2048,
		safeInputTokens: 5000,
		inputPricePerM: 0.55,
		outputPricePerM: 0.55,
	},


	// ─── GOOGLE GEMINI ───────────────────────────────────────────────────────────

	{
		id: 'gemini-2.5-pro',
		provider: 'google',
		displayName: 'Gemini 2.5 Pro',
		contextLength: 1000000,
		capabilities: { coding: 9, reasoning: 10, writing: 9, learning: 8, security: 8, speed: 4 },
		description: 'Google Gemini 2.5 Pro — exceptional reasoning, coding, and writing with a massive 1M context length.',
		humanLabel: 'Best for Large Context',
		lastVerified: '2026-06-19',
		supportsNativeTools: true,
		maxOutputTokens: 8192,
		safeInputTokens: 1000000,
		inputPricePerM: 1.25,
		outputPricePerM: 5.00,
	},
	{
		id: 'gemini-2.5-flash',
		provider: 'google',
		displayName: 'Gemini 2.5 Flash',
		contextLength: 1000000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 8, security: 6, speed: 9 },
		description: 'Google Gemini 2.5 Flash — fast, efficient, and versatile with a massive 1M context length.',
		lastVerified: '2026-06-19',
		supportsNativeTools: true,
		maxOutputTokens: 8192,
		safeInputTokens: 1000000,
		inputPricePerM: 0.075,
		outputPricePerM: 0.30,
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
