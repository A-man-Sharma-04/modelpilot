import * as vscode from 'vscode';
import { ModelRegistry } from '../registry/ModelRegistry';
import { Recommender } from '../engine/Recommender';
import { Router } from '../engine/Router';
import { SecretsManager } from '../secrets';
import { NvidiaProvider } from '../providers/NvidiaProvider';
import { OpenRouterProvider } from '../providers/OpenRouterProvider';
import { GroqProvider } from '../providers/GroqProvider';
import { CerebrasProvider } from '../providers/CerebrasProvider';
import { GoogleProvider } from '../providers/GoogleProvider';
import { OllamaProvider } from '../providers/OllamaProvider';

interface BenchmarkResult {
	provider: string;
	model: string;
	latencyMs: number;
	tokensPerSecond: number;
	outputTokens: number;
	success: boolean;
	error?: string;
}

const BENCHMARK_PROMPT = 'Write a function that checks if a string is a palindrome. Include input validation.';

export async function runBenchmark(sm: SecretsManager, registry: ModelRegistry): Promise<void> {
	const models = registry.getAvailable();
	if (models.length === 0) {
		vscode.window.showWarningMessage('No available models to benchmark. Run "ModelPilot: Add API Key" first.');
		return;
	}

	const results: BenchmarkResult[] = [];

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'ModelPilot: Benchmarking models...',
		cancellable: true,
	}, async (progress, token) => {
		const keys = await sm.getAll();
		const providers = [
			new NvidiaProvider(keys.nvidia),
			new OpenRouterProvider(keys.openrouter),
			new GroqProvider(keys.groq),
			new CerebrasProvider(keys.cerebras),
			new GoogleProvider(keys.google),
			new OllamaProvider(),
		];
		const router = new Router(providers);

		const total = models.length;
		for (let i = 0; i < total; i++) {
			if (token.isCancellationRequested) {
				break;
			}

			const model = models[i];
			progress.report({
				message: `Testing ${model.displayName} (${i + 1}/${total})...`,
				increment: (1 / total) * 100,
			});

			const startMs = Date.now();
			try {
				const rec = { model, score: model.capabilities.speed, rank: 1, reason: 'benchmark' };
				const result = await router.route(
					[rec],
					[
						{ role: 'system', content: 'You are a helpful coding assistant. Respond concisely.' },
						{ role: 'user', content: BENCHMARK_PROMPT },
					],
					undefined,
					{ stream: false, maxTokens: 256, timeout: 15000 }
				);

				const elapsedMs = Date.now() - startMs;
				const outputTokens = result.usage?.completionTokens || Math.ceil((result.content || '').length / 4);
				const tokPerSec = elapsedMs > 0 ? Math.round((outputTokens / elapsedMs) * 1000) : 0;

				results.push({
					provider: model.provider,
					model: model.displayName,
					latencyMs: elapsedMs,
					tokensPerSecond: tokPerSec,
					outputTokens,
					success: true,
				});
			} catch (err: any) {
				results.push({
					provider: model.provider,
					model: model.displayName,
					latencyMs: Date.now() - startMs,
					tokensPerSecond: 0,
					outputTokens: 0,
					success: false,
					error: err.message || String(err),
				});
			}
		}
	});

	if (results.length === 0) {
		vscode.window.showInformationMessage('Benchmark cancelled.');
		return;
	}

	// Sort by tokens per second (descending)
	results.sort((a, b) => b.tokensPerSecond - a.tokensPerSecond);

	// Display results
	const items = results.map((r, i) => {
		const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
		if (r.success) {
			return {
				label: `${medal} ${r.model}`,
				description: `${r.tokensPerSecond} tok/s`,
				detail: `Latency: ${r.latencyMs}ms · Output: ${r.outputTokens} tokens · Provider: ${r.provider}`,
			};
		} else {
			return {
				label: `❌ ${r.model}`,
				description: 'Failed',
				detail: `Error: ${r.error} · Provider: ${r.provider}`,
			};
		}
	});

	vscode.window.showQuickPick(items, {
		title: `ModelPilot: Benchmark Results (${results.filter(r => r.success).length}/${results.length} succeeded)`,
		placeHolder: 'Models ranked by tokens per second (fastest first)',
	});
}
