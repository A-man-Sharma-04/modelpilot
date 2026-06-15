import { Message } from '../providers/IProvider';

export type TaskCategory = 
	| 'general'
	| 'reverse-engineering'
	| 'binary-exploitation'
	| 'web-security'
	| 'malware-analysis'
	| 'cryptography'
	| 'coding'
	| 'linux'
	| 'writing'
	| 'documentation'
	| 'learning';

export interface SubTask {
	id: string;
	instruction: string;
	category: TaskCategory;
	dependsOn?: string[];   // IDs of subtasks that must complete first
	context?: string;       // output from a dependency injected here at runtime
}

export interface DecomposedTask {
	original: string;
	subtasks: SubTask[];
	parallel: boolean;      // can subtasks run in parallel?
}

// Patterns that signal a complex multi-part request
const DECOMPOSE_PATTERNS: { pattern: RegExp; tasks: Partial<SubTask>[] }[] = [
	{
		// "refactor X and add tests"
		pattern: /refactor.+and.+(add|write|generate)\s+tests?/i,
		tasks: [
			{ instruction: 'Refactor the code as requested', category: 'coding' },
			{ instruction: 'Write comprehensive tests for the refactored code', category: 'coding', dependsOn: ['0'] },
		],
	},
	{
		// "fix the bug and explain why"
		pattern: /fix.+and\s+explain/i,
		tasks: [
			{ instruction: 'Fix the bug — provide complete corrected code', category: 'coding' },
			{ instruction: 'Explain the root cause of the bug clearly', category: 'learning', dependsOn: ['0'] },
		],
	},
	{
		// "review for security and performance"
		pattern: /review.+(security|vulnerabilit).+(performance|efficiency|speed)/i,
		tasks: [
			{ instruction: 'Audit for security vulnerabilities with severity ratings and fixes', category: 'web-security' },
			{ instruction: 'Review for performance issues and suggest optimizations', category: 'coding' },
		],
	},
	{
		// "add feature and document it"
		pattern: /(add|implement|build).+and\s+(document|write\s+docs|add\s+docs)/i,
		tasks: [
			{ instruction: 'Implement the requested feature completely', category: 'coding' },
			{ instruction: 'Write documentation for the implemented feature', category: 'documentation', dependsOn: ['0'] },
		],
	},
	{
		// "explain and then fix"
		pattern: /explain.+then\s+(fix|refactor|improve)/i,
		tasks: [
			{ instruction: 'Explain what the code does and identify issues', category: 'learning' },
			{ instruction: 'Fix the identified issues with complete corrected code', category: 'coding', dependsOn: ['0'] },
		],
	},
	{
		// "optimize and add tests"
		pattern: /optimiz.+and.+(add|write|generate)\s+tests?/i,
		tasks: [
			{ instruction: 'Optimize the code for performance', category: 'coding' },
			{ instruction: 'Write tests verifying the optimized behavior', category: 'coding', dependsOn: ['0'] },
		],
	},
];

export function decompose(userMessage: string): DecomposedTask | null {
	for (const { pattern, tasks } of DECOMPOSE_PATTERNS) {
		if (pattern.test(userMessage)) {
			const subtasks: SubTask[] = tasks.map((t, i) => ({
				id: String(i),
				instruction: t.instruction!,
				category: t.category!,
				dependsOn: t.dependsOn,
			}));

			const hasSequential = subtasks.some(t => t.dependsOn && t.dependsOn.length > 0);

			return {
				original: userMessage,
				subtasks,
				parallel: !hasSequential,
			};
		}
	}
	return null; // single task, no decomposition needed
}

// Infer best category for a single undivided request
export function inferCategory(message: string, command?: string): TaskCategory {
	if (command && command in COMMAND_MAP) {
		return COMMAND_MAP[command];
	}

	const m = message.toLowerCase();

	if (/vuln|exploit|pentest|cve|cwe|injection|xss|csrf|auth bypass|security audit/i.test(m)) {
		return 'web-security';
	}
	if (/why|explain|what is|how does|teach|understand|concept|difference between/i.test(m)) {
		return 'learning';
	}
	if (/document|readme|docstring|jsdoc|comment|write up/i.test(m)) {
		return 'documentation';
	}
	if (/architect|design|tradeoff|should i use|compare|pros and cons|approach/i.test(m)) {
		return 'coding';
	}
	// Default: most requests in a code editor are coding tasks
	return 'coding';
}

const COMMAND_MAP: Record<string, TaskCategory> = {
	explain:  'learning',
	fix:      'coding',
	review:   'coding',
	test:     'coding',
	refactor: 'coding',
	security: 'web-security',
	docs:     'documentation',
};

// Rough token estimator — accurate enough without a full tokenizer
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
	return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

// Split large text at semantic boundaries (functions/classes) rather than arbitrary chars
export function semanticChunk(text: string, maxTokensPerChunk: number): string[] {
	const maxChars = maxTokensPerChunk * 4;
	if (text.length <= maxChars) { return [text]; }

	// Try to split at function/class boundaries
	const boundaries = [
		/^(export\s+)?(async\s+)?function\s+/m,
		/^(export\s+)?(abstract\s+)?class\s+/m,
		/^(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/m,
		/^def\s+/m,          // Python
		/^func\s+/m,         // Go
		/^pub\s+fn\s+/m,     // Rust
	];

	const lines = text.split('\n');
	const chunks: string[] = [];
	let current: string[] = [];
	let currentLen = 0;

	for (const line of lines) {
		const lineLen = line.length + 1;
		const isBoundary = boundaries.some(b => b.test(line));

		if (isBoundary && currentLen + lineLen > maxChars && current.length > 0) {
			chunks.push(current.join('\n'));
			current = [line];
			currentLen = lineLen;
		} else {
			current.push(line);
			currentLen += lineLen;

			if (currentLen > maxChars) {
				chunks.push(current.join('\n'));
				current = [];
				currentLen = 0;
			}
		}
	}

	if (current.length > 0) { chunks.push(current.join('\n')); }
	return chunks;
}

// Per-provider safe context window limits (leave 20% headroom for output)
export const PROVIDER_CONTEXT_LIMITS: Record<string, number> = {
	nvidia:      6000,   // safe for most NIM models
	openrouter:  6000,   // free tier models vary wildly
	groq:        6000,   // 8192 total but fast — leave room
};

// Trim messages to fit within a provider's context window
export function fitMessagesToContext(
	messages: Message[],
	providerName: string,
	systemPromptTokens: number,
	maxInputTokens?: number,
): Message[] {
	const limit = maxInputTokens ?? PROVIDER_CONTEXT_LIMITS[providerName] ?? 6000;
	const available = limit - systemPromptTokens - 200; // 200 token buffer

	// Always keep system message and last user message
	const system = messages.filter(m => m.role === 'system');
	const nonSystem = messages.filter(m => m.role !== 'system');

	if (nonSystem.length === 0) { return messages; }

	const lastUser = nonSystem[nonSystem.length - 1];
	const lastUserTokens = estimateTokens(lastUser.content);

	// If last user message itself exceeds limit — it needs chunking upstream
	if (lastUserTokens > available) { return [...system, lastUser]; }

	// Fit as much history as possible, newest first
	const fitted: typeof nonSystem = [lastUser];
	let used = lastUserTokens;

	for (let i = nonSystem.length - 2; i >= 0; i--) {
		const t = estimateTokens(nonSystem[i].content);
		if (used + t > available) { break; }
		fitted.unshift(nonSystem[i]);
		used += t;
	}

	return [...system, ...fitted];
}
