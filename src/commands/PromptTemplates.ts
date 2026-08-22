import * as vscode from 'vscode';

export const PROMPT_TEMPLATES: { label: string; detail: string; prompt: string }[] = [
	{
		label: '$(beaker) Generate Unit Tests',
		detail: 'Write comprehensive unit tests with edge cases',
		prompt: 'Write comprehensive unit tests for the code in the active file. Cover positive cases, negative cases, boundary conditions, and edge cases. Use the appropriate testing framework for the language.',
	},
	{
		label: '$(shield) Security Audit',
		detail: 'Scan for vulnerabilities and hardening opportunities',
		prompt: 'Perform a thorough security audit of the code in the active file. Identify potential vulnerabilities (injection, XSS, CSRF, path traversal, insecure deserialization, etc.), suggest fixes, and recommend hardening measures.',
	},
	{
		label: '$(globe) Generate API Client',
		detail: 'Create a typed API client from endpoint descriptions',
		prompt: 'Based on the code or comments in the active file describing an API, generate a fully typed API client with error handling, request/response types, and retry logic.',
	},
	{
		label: '$(regex) Explain Regex',
		detail: 'Break down a regular expression step by step',
		prompt: 'Find and explain every regular expression in the active file. Break each one down step by step, explaining what each part matches, with examples of matching and non-matching strings.',
	},
	{
		label: '$(dashboard) Performance Optimization',
		detail: 'Identify bottlenecks and suggest optimizations',
		prompt: 'Analyze the code in the active file for performance bottlenecks. Identify O(n²) patterns, unnecessary allocations, blocking operations, and suggest concrete optimizations with before/after code examples.',
	},
	{
		label: '$(book) Generate Documentation',
		detail: 'Create JSDoc/docstrings for all functions',
		prompt: 'Generate comprehensive documentation (JSDoc, docstrings, or appropriate format for the language) for all functions, classes, and exported members in the active file. Include parameter descriptions, return types, and usage examples.',
	},
	{
		label: '$(git-pull-request) Code Review',
		detail: 'Comprehensive code review with actionable feedback',
		prompt: 'Perform a comprehensive code review of the active file. Check for: code style consistency, potential bugs, error handling gaps, naming conventions, SOLID principles, DRY violations, and suggest improvements with specific code examples.',
	},
	{
		label: '$(symbol-interface) Generate Types/Interfaces',
		detail: 'Extract and define TypeScript types from code',
		prompt: 'Analyze the code in the active file and generate comprehensive TypeScript interfaces/types for all data structures, function parameters, and return values. Include proper generics where applicable.',
	},
	{
		label: '$(error) Error Handling',
		detail: 'Add robust error handling and recovery',
		prompt: 'Review the code in the active file and add comprehensive error handling. Wrap risky operations in try-catch blocks, add input validation, create custom error types where needed, and implement graceful recovery strategies.',
	},
	{
		label: '$(rocket) Refactor to Modern Syntax',
		detail: 'Upgrade to latest language features and patterns',
		prompt: 'Refactor the code in the active file to use modern language features and best practices. Replace legacy patterns with contemporary alternatives (async/await, optional chaining, nullish coalescing, destructuring, etc.).',
	},
];

export async function showPromptTemplates(): Promise<void> {
	const picked = await vscode.window.showQuickPick(PROMPT_TEMPLATES, {
		title: 'ModelPilot: Insert Prompt Template',
		placeHolder: 'Select a prompt template to send to ModelPilot',
		matchOnDetail: true,
	});

	if (!picked) {
		return;
	}

	await vscode.commands.executeCommand('workbench.action.chat.open', {
		query: `@modelpilot ${picked.prompt}`,
	});
}
