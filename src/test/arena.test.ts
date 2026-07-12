import * as assert from 'assert';
import * as vscode from 'vscode';
import { ModelArenaPanel } from '../webview/ModelArenaPanel';
import { ModelRegistry } from '../registry/ModelRegistry';

suite('ModelPilot Model Comparison Arena Tests', () => {
	let registry: ModelRegistry;
	let mockProviders: any[];

	setup(() => {
		registry = new ModelRegistry();
		mockProviders = [
			{
				name: 'groq',
				isConfigured: () => true,
				getCooldownRemainingMs: () => 0,
				chat: async (modelId: string, messages: any, tools: any, context: any, options: any) => {
					if (options?.onChunk) {
						options.onChunk('Llama response chunk');
					}
					return {
						content: 'Llama response complete',
						usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
					};
				}
			},
			{
				name: 'nvidia',
				isConfigured: () => true,
				getCooldownRemainingMs: () => 0,
				chat: async (modelId: string, messages: any, tools: any, context: any, options: any) => {
					if (options?.onChunk) {
						options.onChunk('Nvidia response chunk');
					}
					return {
						content: 'Nvidia response complete',
						usage: { promptTokens: 15, completionTokens: 25, totalTokens: 40 }
					};
				}
			}
		];
	});

	test('ModelArenaPanel registration and loadModels message posting', async () => {
		// Populate registry with mock models
		await registry.refresh(mockProviders);

		const mockWebview = {
			html: '',
			onDidReceiveMessage: new vscode.EventEmitter<any>().event,
			postMessage: async (msg: any) => {
				if (msg.command === 'loadModels') {
					assert.strictEqual(msg.models.length, 0); // No mock profiles exist in static MODEL_PROFILES for these provider names, but they are dynamically registered on refresh!
				}
			}
		};

		const mockPanel: any = {
			webview: mockWebview,
			onDidDispose: new vscode.EventEmitter<void>().event,
			reveal: () => {},
			dispose: () => {}
		};

		const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
		(vscode.window as any).createWebviewPanel = () => mockPanel;

		try {
			ModelArenaPanel.createOrShow(vscode.Uri.file('/mock'), registry, mockProviders);
			assert.ok(ModelArenaPanel.currentPanel);
		} finally {
			vscode.window.createWebviewPanel = originalCreateWebviewPanel;
			if (ModelArenaPanel.currentPanel) {
				ModelArenaPanel.currentPanel.dispose();
			}
		}
	});
});
