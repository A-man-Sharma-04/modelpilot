import * as assert from 'assert';
import * as vscode from 'vscode';
import { AnalyticsManager } from '../engine/AnalyticsManager';

class MockMemento implements vscode.Memento {
	private storage = new Map<string, any>();

	keys(): readonly string[] {
		return Array.from(this.storage.keys());
	}

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get(key: string, defaultValue?: any): any {
		if (this.storage.has(key)) {
			return this.storage.get(key);
		}
		return defaultValue;
	}

	update(key: string, value: any): Thenable<void> {
		this.storage.set(key, value);
		return Promise.resolve();
	}
}

suite('ModelPilot Analytics & Savings Panel Tests', () => {
	let mockMemento: MockMemento;
	let manager: AnalyticsManager;

	setup(() => {
		mockMemento = new MockMemento();
		manager = new AnalyticsManager(mockMemento);
	});

	test('AnalyticsManager initial state', () => {
		const data = manager.getData();
		assert.strictEqual(data.providers.nvidia.requests, 0);
		assert.strictEqual(data.providers.groq.requests, 0);
		assert.strictEqual(data.providers.openrouter.requests, 0);
		assert.strictEqual(manager.calculateSavings(data), 0.0);
		assert.strictEqual(manager.getSavingsString(data), '$0.00');
	});

	test('AnalyticsManager records requests with model-level pricing', async () => {
		// 1. Record Groq request with 'llama-3.3-70b-versatile' (free provider, so savings = commercial cost)
		// Input rate: $0.70/M, Output rate: $0.90/M
		// 1M input tokens + 2M output tokens -> Commercial cost: $0.70 + 2 * $0.90 = $2.50. Actual cost: $0.00.
		let data = await manager.recordRequest('groq', 'llama-3.3-70b-versatile', 1000000, 2000000);
		assert.strictEqual(data.providers.groq.requests, 1);
		assert.strictEqual(data.providers.groq.promptTokens, 1000000);
		assert.strictEqual(data.providers.groq.completionTokens, 2000000);
		assert.strictEqual(data.providers.groq.totalTokens, 3000000);
		
		const mStats1 = data.models['llama-3.3-70b-versatile'];
		assert.ok(mStats1, 'Should create model stats entry');
		assert.strictEqual(mStats1.requests, 1);
		assert.strictEqual(mStats1.commercialCost, 2.50);
		assert.strictEqual(mStats1.actualCost, 0.00);

		// 2. Record Nvidia request with 'deepseek-ai/deepseek-v4-pro' (free provider, so savings = commercial cost)
		// Input rate: $0.55/M, Output rate: $2.19/M
		// 2M input tokens + 1M output tokens -> Commercial cost: 2 * $0.55 + $2.19 = $3.29. Actual cost: $0.00.
		data = await manager.recordRequest('nvidia', 'deepseek-ai/deepseek-v4-pro', 2000000, 1000000);
		assert.strictEqual(data.providers.nvidia.requests, 1);
		
		const mStats2 = data.models['deepseek-ai/deepseek-v4-pro'];
		assert.ok(mStats2);
		assert.strictEqual(mStats2.requests, 1);
		assert.strictEqual(mStats2.commercialCost, 3.29);
		assert.strictEqual(mStats2.actualCost, 0.00);

		// 3. Record OpenRouter request with 'meta-llama/llama-3.3-70b-instruct:free' (OpenRouter free model)
		// Input rate: $0.70/M, Output rate: $0.90/M
		// 1M input + 1M output -> Commercial cost: $0.70 + $0.90 = $1.60. Actual cost: $0.00 (ends with :free).
		data = await manager.recordRequest('openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 1000000, 1000000);
		
		const mStats3 = data.models['meta-llama/llama-3.3-70b-instruct:free'];
		assert.ok(mStats3);
		assert.strictEqual(mStats3.commercialCost, 1.60);
		assert.strictEqual(mStats3.actualCost, 0.00);

		const savings = manager.calculateSavings(data);
		assert.ok(Math.abs(savings - 7.39) < 0.0001, `Expected savings to be close to 7.39, got ${savings}`);
		assert.strictEqual(manager.getSavingsString(data), '$7.39');
	});

	test('AnalyticsManager triggers event on changes', async () => {
		let fired = false;
		const sub = manager.onDidChange(() => {
			fired = true;
		});

		await manager.recordRequest('groq', 'gemma2-9b-it', 100, 200);
		assert.ok(fired, 'onDidChange event must fire when recording request');
		sub.dispose();
	});

	test('AnalyticsManager resets statistics correctly', async () => {
		await manager.recordRequest('groq', 'gemma2-9b-it', 100, 200);
		await manager.recordRequest('nvidia', 'deepseek-ai/deepseek-v4-pro', 50, 50);
		let data = manager.getData();
		assert.ok(data.providers.groq.requests > 0);
		assert.ok(Object.keys(data.models).length > 0);

		data = await manager.reset();
		assert.strictEqual(data.providers.groq.requests, 0);
		assert.strictEqual(data.providers.nvidia.requests, 0);
		assert.strictEqual(Object.keys(data.models).length, 0);
		assert.strictEqual(manager.calculateSavings(data), 0.0);
	});

	test('ModelPilot: showAnalytics command should be registered', async () => {
		const ext = vscode.extensions.getExtension('A-man-Sharma-04.modelpilot');
		if (ext) {
			await ext.activate();
		}
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('modelpilot.showAnalytics'), 'showAnalytics command must be registered');
	});
});
