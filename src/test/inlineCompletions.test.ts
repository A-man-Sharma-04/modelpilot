import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	InlineCompletions,
	buildCompletionContext,
	postProcessCompletion,
	isCompletionLanguage,
	getInlineCompletionSettings,
} from '../completion/InlineCompletions';
import { Router } from '../engine/Router';
import { ModelRegistry } from '../registry/ModelRegistry';

suite('ModelPilot Inline Code Completions Tests', () => {

	test('isCompletionLanguage blocks non-code languages', () => {
		assert.ok(isCompletionLanguage('typescript'));
		assert.ok(isCompletionLanguage('python'));
		assert.ok(!isCompletionLanguage('plaintext'));
		assert.ok(!isCompletionLanguage('markdown'));
		assert.ok(!isCompletionLanguage('json'));
		assert.ok(!isCompletionLanguage('Log'));
	});

	test('buildCompletionContext extracts bounded prefix and suffix', () => {
		const text = 'line0\nline1\nline2\nline3';
		const ctx = buildCompletionContext(text, 2, 4, { contextPrefixLines: 2, contextSuffixChars: 10 });
		assert.strictEqual(ctx.prefix, 'line0\nline1\nline');
		assert.strictEqual(ctx.suffix, '2\nline3');
	});

	test('buildCompletionContext clamps invalid positions', () => {
		const text = 'alpha';
		const ctx = buildCompletionContext(text, 50, 500, { contextPrefixLines: 5, contextSuffixChars: 100 });
		assert.strictEqual(ctx.prefix, 'alpha');
		assert.strictEqual(ctx.suffix, '');
	});

	test('postProcessCompletion strips markdown fences', () => {
		assert.strictEqual(postProcessCompletion('```ts\nconst x = 1;\n```', ''), 'const x = 1;');
		assert.strictEqual(postProcessCompletion('```python\nx = 2\n```', ''), 'x = 2');
	});

	test('postProcessCompletion trims surrounding blank lines but keeps indentation', () => {
		assert.strictEqual(postProcessCompletion('\n\n  const y = 2;\n\n', ''), '  const y = 2;');
	});

	test('postProcessCompletion drops empty or redundant completions', () => {
		assert.strictEqual(postProcessCompletion('', ''), undefined);
		assert.strictEqual(postProcessCompletion('   \n ', ''), undefined);
		// Model echoed the existing text after the cursor -> redundant
		assert.strictEqual(postProcessCompletion('echo()', 'echo() and more'), undefined);
	});

	test('provideInlineCompletionItems returns ghost text via Router', async () => {
		const mockSm: any = {
			getAll: async () => ({ nvidia: 'key1', openrouter: 'key2', groq: 'key3', cerebras: 'key4', google: 'key5' }),
			get: async () => ['key1'],
		};
		const registry = new ModelRegistry();
		registry.getAvailable = () => [{
			id: 'fast-model',
			provider: 'groq',
			displayName: 'Fast Model',
			contextLength: 32000,
			capabilities: { coding: 3, reasoning: 3, writing: 3, learning: 3, security: 3, speed: 9 },
			description: 'Mock fast model',
			lastVerified: '2026-06-11',
			available: true
		}];

		const originalRoute = Router.prototype.route;
		Router.prototype.route = async (recs: any, messages: any) => {
			const userMsg = messages.find((m: any) => m.role === 'user')?.content || '';
			assert.ok(userMsg.includes('<CURSOR>'), 'Prompt should include the cursor marker');
			assert.ok(userMsg.includes('typescript'), 'Prompt should include the language');
			return { content: 'foo()' };
		};

		const completions = new InlineCompletions(mockSm, registry, () => ({
			enabled: true,
			debounceMs: 0,
			maxTokens: 64,
			contextPrefixLines: 60,
			contextSuffixChars: 400,
		}));

		try {
			const doc = await vscode.workspace.openTextDocument({
				content: 'const a = 1;\nconst result = \nconsole.log(result);',
				language: 'typescript',
			});
			const pos = new vscode.Position(1, 14);
			const mockToken: any = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} })
			};
			const items = await completions.provide(doc, pos, mockToken);
			assert.ok(items && items.length === 1, 'Should return one completion item');
			assert.strictEqual(items[0].insertText, 'foo()');
		} finally {
			Router.prototype.route = originalRoute;
		}
	});

	test('provide returns undefined when disabled or in non-code language', async () => {
		const mockSm: any = {
			getAll: async () => ({}),
			get: async () => [],
		};
		const registry = new ModelRegistry();
		const completions = new InlineCompletions(mockSm, registry, () => ({
			enabled: false,
			debounceMs: 0,
			maxTokens: 64,
			contextPrefixLines: 60,
			contextSuffixChars: 400,
		}));
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};
		const doc = await vscode.workspace.openTextDocument({
			content: 'some text\n',
			language: 'plaintext',
		});
		const items = await completions.provide(doc, new vscode.Position(0, 4), mockToken);
		assert.strictEqual(items, undefined);
	});

	test('getInlineCompletionSettings returns defaults', () => {
		const s = getInlineCompletionSettings();
		assert.ok(typeof s.enabled === 'boolean');
		assert.ok(s.debounceMs >= 0);
		assert.ok(s.maxTokens > 0);
		assert.ok(s.contextPrefixLines > 0);
		assert.ok(s.contextSuffixChars >= 0);
	});
});
