import * as vscode from 'vscode';
import { IProvider } from '../providers/IProvider';
import { NvidiaProvider } from '../providers/NvidiaProvider';
import { OpenRouterProvider } from '../providers/OpenRouterProvider';
import { GroqProvider } from '../providers/GroqProvider';
import { CerebrasProvider } from '../providers/CerebrasProvider';
import { GoogleProvider } from '../providers/GoogleProvider';
import { OllamaProvider } from '../providers/OllamaProvider';
import { Router } from '../engine/Router';
import { Recommender } from '../engine/Recommender';
import { ModelRegistry } from '../registry/ModelRegistry';
import { SecretsManager } from '../secrets';
import { debugLog } from '../debug';

export const COMPLETION_CURSOR_MARKER = '<CURSOR>';

const BLOCKED_LANGUAGES = new Set([
	'plaintext', 'markdown', 'log', 'text', 'csv', 'xml',
	'json', 'jsonc', 'yaml', 'yml', 'ini', 'properties', 'diff',
]);

export function isCompletionLanguage(languageId: string): boolean {
	return !BLOCKED_LANGUAGES.has(languageId.toLowerCase().trim());
}

export interface CompletionContextOptions {
	contextPrefixLines: number;
	contextSuffixChars: number;
}

export function buildCompletionContext(
	text: string,
	line: number,
	character: number,
	opts: CompletionContextOptions,
): { prefix: string; suffix: string } {
	const lines = text.split(/\r?\n/);
	const clampedLine = Math.max(0, Math.min(line, lines.length - 1));
	const clampedChar = Math.max(0, Math.min(character, lines[clampedLine].length));
	const startLine = Math.max(0, clampedLine - opts.contextPrefixLines);

	const prefixParts = lines.slice(startLine, clampedLine);
	prefixParts.push(lines[clampedLine].slice(0, clampedChar));
	const prefix = prefixParts.join('\n');

	let suffix = lines[clampedLine].slice(clampedChar);
	let lineIdx = clampedLine + 1;
	while (suffix.length < opts.contextSuffixChars && lineIdx < lines.length) {
		suffix += '\n' + lines[lineIdx];
		lineIdx++;
	}
	suffix = suffix.slice(0, opts.contextSuffixChars);

	return { prefix, suffix };
}

export function postProcessCompletion(raw: string, suffix: string): string | undefined {
	if (!raw) {
		return undefined;
	}
	let text = raw
		.replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
		.replace(/\n?\s*```\s*$/, '')
		.replace(/^\n+/, '')
		.replace(/\n+$/, '');
	if (!text || !text.trim()) {
		return undefined;
	}
	// The model sometimes echoes the code that already follows the cursor,
	// which would render a redundant duplicate ghost text.
	if (suffix.startsWith(text)) {
		return undefined;
	}
	return text;
}

export interface InlineCompletionSettings {
	enabled: boolean;
	debounceMs: number;
	maxTokens: number;
	contextPrefixLines: number;
	contextSuffixChars: number;
}

export function getInlineCompletionSettings(): InlineCompletionSettings {
	const cfg = vscode.workspace.getConfiguration('modelpilot');
	return {
		enabled: cfg.get<boolean>('inlineCompletions.enabled', true),
		debounceMs: cfg.get<number>('inlineCompletions.debounceMs', 350),
		maxTokens: cfg.get<number>('inlineCompletions.maxTokens', 96),
		contextPrefixLines: cfg.get<number>('inlineCompletions.contextPrefixLines', 60),
		contextSuffixChars: cfg.get<number>('inlineCompletions.contextSuffixChars', 400),
	};
}

export class InlineCompletions {
	constructor(
		private readonly sm: SecretsManager,
		private readonly registry: ModelRegistry,
		private readonly getSettings: () => InlineCompletionSettings = getInlineCompletionSettings,
	) {}

	register(): vscode.Disposable {
		const provider: vscode.InlineCompletionItemProvider = {
			provideInlineCompletionItems: (document, position, context, token) =>
				this.provide(document, position, token),
		};
		return vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider);
	}

	async provide(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const settings = this.getSettings();
		if (!settings.enabled) {
			return undefined;
		}
		if (!isCompletionLanguage(document.languageId)) {
			return undefined;
		}
		if (token.isCancellationRequested) {
			return undefined;
		}
		if (position.line === 0 && position.character === 0) {
			return undefined;
		}

		const beforeCursor = document.lineAt(position.line).text.slice(0, position.character);
		if (beforeCursor.trim().length < 2) {
			return undefined;
		}
		const trimmed = beforeCursor.trimStart();
		if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
			return undefined;
		}

		return new Promise((resolve) => {
			const controller = new AbortController();
			let settled = false;
			const finish = (items: vscode.InlineCompletionItem[] | undefined) => {
				if (!settled) {
					settled = true;
					resolve(items);
				}
			};
			token.onCancellationRequested(() => {
				controller.abort();
				clearTimeout(timer);
				finish(undefined);
			});
			const timer = setTimeout(async () => {
				try {
					const items = await this.completeAt(document, position, controller.signal, settings);
					finish(items);
				} catch (err) {
					debugLog('inline_completions', `Completion failed: ${err instanceof Error ? err.message : String(err)}`);
					finish(undefined);
				}
			}, Math.max(0, settings.debounceMs));
		});
	}

	private async completeAt(
		document: vscode.TextDocument,
		position: vscode.Position,
		signal: AbortSignal,
		settings: InlineCompletionSettings,
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const { prefix, suffix } = buildCompletionContext(
			document.getText(),
			position.line,
			position.character,
			settings,
		);

		const keys = await this.sm.getAll();
		const providers: IProvider[] = [
			new NvidiaProvider(keys.nvidia),
			new OpenRouterProvider(keys.openrouter),
			new GroqProvider(keys.groq),
			new CerebrasProvider(keys.cerebras),
			new GoogleProvider(keys.google),
			new OllamaProvider(),
		];
		const router = new Router(providers);
		const recommender = new Recommender(this.registry);
		const recs = recommender.recommendForSpeed(6);
		if (recs.length === 0) {
			return undefined;
		}

		const fileName = document.uri.scheme === 'untitled' ? 'untitled' : (document.uri.path.split('/').pop() || 'file');
		const systemPrompt = `You are a code completion engine. Complete the code at the marker ${COMPLETION_CURSOR_MARKER} inside the file below.
RULES:
- Output ONLY the code that should replace the marker.
- Do NOT repeat any code that already exists in the file.
- Do NOT include explanations, markdown fences, or the marker itself.
- Match the file's language, indentation, and coding style.
- Stop as soon as the completion is logically complete.`;

		const userPrompt = `File: ${fileName} (${document.languageId})\n\n${prefix}${COMPLETION_CURSOR_MARKER}${suffix}`;

		const result = await router.route(recs, [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		], undefined, {
			stream: false,
			maxTokens: settings.maxTokens,
			timeout: 15000,
			abortSignal: signal,
		});

		const cleaned = postProcessCompletion(result?.content || '', suffix);
		if (!cleaned) {
			return undefined;
		}
		return [new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position))];
	}
}
