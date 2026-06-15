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
	provider: 'nvidia' | 'openrouter' | 'groq';
	displayName: string;
	contextLength: number;
	capabilities: ModelCapabilities;
	description: string;
	humanLabel?: string;        // e.g. "Best for HTB"
	lastVerified: string;       // ISO date string
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
	},
	{
		id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
		provider: 'nvidia',
		displayName: 'Nemotron Ultra 253B',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 9, writing: 7, learning: 6, security: 9, speed: 2 },
		description: "NVIDIA's 253B flagship — highly capable across all tasks.",
		humanLabel: 'Best for Deep Analysis',
		lastVerified: '2026-06-09',
	},
	{
		id: 'nvidia/nemotron-3-ultra-550b-a55b',
		provider: 'nvidia',
		displayName: 'Nemotron 3 Ultra 550B',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 10, writing: 7, learning: 5, security: 9, speed: 1 },
		description: "NVIDIA's 550B MoE — maximum reasoning power.",
		humanLabel: 'Best for Hard Problems',
		lastVerified: '2026-06-09',
	},
	{
		id: 'nvidia/llama-3.3-nemotron-super-49b-v1',
		provider: 'nvidia',
		displayName: 'Nemotron Super 49B',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 8, writing: 7, learning: 6, security: 7, speed: 5 },
		description: 'NVIDIA Nemotron Super 49B — efficient and strong.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'qwen/qwen3-coder-480b-a35b-instruct',
		provider: 'nvidia',
		displayName: 'Qwen3 Coder 480B',
		contextLength: 128000,
		capabilities: { coding: 10, reasoning: 8, writing: 5, learning: 5, security: 6, speed: 2 },
		description: 'Purpose-built 480B coding model — best for generation and debugging.',
		humanLabel: 'Best for Coding',
		lastVerified: '2026-06-09',
	},
	{
		id: 'mistralai/codestral-22b-instruct-v0.1',
		provider: 'nvidia',
		displayName: 'Codestral 22B',
		contextLength: 32000,
		capabilities: { coding: 9, reasoning: 6, writing: 5, learning: 6, security: 5, speed: 7 },
		description: "Mistral's dedicated code model — fast and accurate.",
		lastVerified: '2026-06-09',
	},
	{
		id: 'ibm/granite-34b-code-instruct',
		provider: 'nvidia',
		displayName: 'Granite 34B Code',
		contextLength: 32000,
		capabilities: { coding: 8, reasoning: 6, writing: 4, learning: 5, security: 5, speed: 5 },
		description: 'IBM Granite — enterprise-grade code model.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'meta/codellama-70b',
		provider: 'nvidia',
		displayName: 'Code Llama 70B',
		contextLength: 32000,
		capabilities: { coding: 8, reasoning: 5, writing: 4, learning: 6, security: 4, speed: 5 },
		description: "Meta's proven code model — reliable across languages.",
		lastVerified: '2026-06-09',
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
	},
	{
		id: 'google/gemma-3n-e4b-it',
		provider: 'nvidia',
		displayName: 'Gemma 3n E4B',
		contextLength: 32000,
		capabilities: { coding: 5, reasoning: 4, writing: 5, learning: 9, security: 3, speed: 10 },
		description: 'Fast 4B model — ideal for learning and quick explanations.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'google/gemma-2-2b-it',
		provider: 'nvidia',
		displayName: 'Gemma 2 2B',
		contextLength: 8000,
		capabilities: { coding: 4, reasoning: 3, writing: 5, learning: 8, security: 2, speed: 10 },
		description: 'Compact Gemma 2 — fast responses for simple tasks.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'meta/llama-3.2-1b-instruct',
		provider: 'nvidia',
		displayName: 'Llama 3.2 1B',
		contextLength: 128000,
		capabilities: { coding: 3, reasoning: 3, writing: 4, learning: 8, security: 2, speed: 10 },
		description: 'Smallest Llama — ultra-low latency, large context.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'microsoft/phi-4-mini-instruct',
		provider: 'nvidia',
		displayName: 'Phi 4 Mini',
		contextLength: 16000,
		capabilities: { coding: 7, reasoning: 6, writing: 5, learning: 8, security: 4, speed: 9 },
		description: 'Microsoft Phi 4 Mini — efficient and surprisingly capable.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'google/gemma-3-4b-it',
		provider: 'nvidia',
		displayName: 'Gemma 3 4B',
		contextLength: 32000,
		capabilities: { coding: 5, reasoning: 4, writing: 5, learning: 9, security: 3, speed: 9 },
		description: 'Small Gemma 3 — good for learning at speed.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'google/gemma-3-12b-it',
		provider: 'nvidia',
		displayName: 'Gemma 3 12B',
		contextLength: 32000,
		capabilities: { coding: 6, reasoning: 5, writing: 7, learning: 8, security: 4, speed: 8 },
		description: 'Mid-size Gemma 3 — balanced speed and quality.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'meta/llama-3.2-3b-instruct',
		provider: 'nvidia',
		displayName: 'Llama 3.2 3B',
		contextLength: 128000,
		capabilities: { coding: 4, reasoning: 4, writing: 5, learning: 8, security: 3, speed: 9 },
		description: 'Compact Llama with large context — quick learning tasks.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'meta/llama-3.3-70b-instruct',
		provider: 'nvidia',
		displayName: 'Llama 3.3 70B',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 7, security: 6, speed: 6 },
		description: 'Meta Llama 3.3 70B — reliable all-rounder.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'meta/llama-4-maverick-17b-128e-instruct',
		provider: 'nvidia',
		displayName: 'Llama 4 Maverick 17B',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 7, learning: 7, security: 6, speed: 7 },
		description: 'Llama 4 Maverick — fast and capable MoE model.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'qwen/qwen3.5-397b-a17b',
		provider: 'nvidia',
		displayName: 'Qwen 3.5 397B',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 9, writing: 8, learning: 6, security: 7, speed: 3 },
		description: "Qwen's large MoE — strong writing and reasoning.",
		lastVerified: '2026-06-09',
	},
	{
		id: 'qwen/qwen3.5-122b-a10b',
		provider: 'nvidia',
		displayName: 'Qwen 3.5 122B',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 6, security: 6, speed: 5 },
		description: 'Mid-size Qwen 3.5 — good writing and reasoning balance.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'mistralai/mistral-large-3-675b-instruct-2512',
		provider: 'nvidia',
		displayName: 'Mistral Large 3 675B',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 8, writing: 9, learning: 6, security: 7, speed: 2 },
		description: "Mistral's 675B model — excellent for long-form writing.",
		humanLabel: 'Best for Writing',
		lastVerified: '2026-06-09',
	},
	{
		id: 'mistralai/mistral-nemotron',
		provider: 'nvidia',
		displayName: 'Mistral Nemotron',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 8, writing: 6, learning: 5, security: 7, speed: 5 },
		description: 'Mistral × NVIDIA collaboration — strong reasoning and code.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'google/gemma-4-31b-it',
		provider: 'nvidia',
		displayName: 'Gemma 4 31B',
		contextLength: 128000,
		capabilities: { coding: 6, reasoning: 6, writing: 8, learning: 8, security: 4, speed: 6 },
		description: 'Google Gemma 4 — great for learning and explanation.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'microsoft/phi-3.5-moe-instruct',
		provider: 'nvidia',
		displayName: 'Phi 3.5 MoE',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 6, writing: 5, learning: 7, security: 4, speed: 7 },
		description: 'Microsoft Phi 3.5 MoE — efficient mixture-of-experts.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'moonshotai/kimi-k2.6',
		provider: 'nvidia',
		displayName: 'Kimi K2.6',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 8, writing: 6, learning: 5, security: 7, speed: 4 },
		description: 'Moonshot Kimi K2.6 — strong reasoning and coding.',
		lastVerified: '2026-06-09',
	},

	// ─── OPENROUTER ───────────────────────────────────────────────────────────

	{
		id: 'deepseek/deepseek-r1:free',
		provider: 'openrouter',
		displayName: 'DeepSeek R1 (free)',
		contextLength: 128000,
		capabilities: { coding: 8, reasoning: 10, writing: 6, learning: 5, security: 9, speed: 4 },
		description: 'DeepSeek R1 via OpenRouter free tier — top-tier reasoning.',
		humanLabel: 'Best for CTF Reasoning',
		lastVerified: '2026-06-09',
	},
	{
		id: 'qwen/qwen3-235b-a22b:free',
		provider: 'openrouter',
		displayName: 'Qwen3 235B (free)',
		contextLength: 128000,
		capabilities: { coding: 9, reasoning: 8, writing: 7, learning: 6, security: 7, speed: 4 },
		description: 'Qwen3 235B via OpenRouter free tier — strong coding and reasoning.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'meta-llama/llama-3.3-70b-instruct:free',
		provider: 'openrouter',
		displayName: 'Llama 3.3 70B (free)',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 7, writing: 8, learning: 7, security: 6, speed: 6 },
		description: 'Llama 3.3 70B via OpenRouter free tier — general purpose.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'google/gemma-3-27b-it:free',
		provider: 'openrouter',
		displayName: 'Gemma 3 27B (free)',
		contextLength: 96000,
		capabilities: { coding: 6, reasoning: 6, writing: 8, learning: 8, security: 4, speed: 6 },
		description: 'Gemma 3 27B via OpenRouter free tier — good writing and learning.',
		lastVerified: '2026-06-09',
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
	},
	{
		id: 'deepseek-r1-distill-llama-70b',
		provider: 'groq',
		displayName: 'DeepSeek R1 Distill (Groq)',
		contextLength: 128000,
		capabilities: { coding: 7, reasoning: 8, writing: 5, learning: 5, security: 7, speed: 9 },
		description: 'DeepSeek R1 distilled on Groq — fast reasoning.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'mixtral-8x7b-32768',
		provider: 'groq',
		displayName: 'Mixtral 8x7B (Groq)',
		contextLength: 32768,
		capabilities: { coding: 6, reasoning: 6, writing: 7, learning: 7, security: 5, speed: 9 },
		description: 'Mixtral 8x7B on Groq — fast and reliable.',
		lastVerified: '2026-06-09',
	},
	{
		id: 'gemma2-9b-it',
		provider: 'groq',
		displayName: 'Gemma 2 9B (Groq)',
		contextLength: 8192,
		capabilities: { coding: 5, reasoning: 5, writing: 6, learning: 8, security: 3, speed: 10 },
		description: 'Gemma 2 9B on Groq — fastest available for simple tasks.',
		lastVerified: '2026-06-09',
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
