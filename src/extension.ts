import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

let availableSystemTools: string[] = [];
import { NvidiaProvider } from './providers/NvidiaProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { GroqProvider } from './providers/GroqProvider';
import { CerebrasProvider } from './providers/CerebrasProvider';
import { GoogleProvider } from './providers/GoogleProvider';
import { OllamaProvider } from './providers/OllamaProvider';
import { ModelRegistry } from './registry/ModelRegistry';
import { Recommender } from './engine/Recommender';
import { Router } from './engine/Router';
import { SecretsManager, ProviderName } from './secrets';
import { EXPERT_PROFILES, DEFAULT_EXPERT_ID, getExpertProfile } from './data/expertProfiles';
import { Message } from './providers/IProvider';
import { AgentExecutor, AGENT_TOOLS_METADATA, getWorkspacePath } from './engine/AgentExecutor';
import { mcpManager, McpServerConnection } from './engine/McpManager';
import {
	TOOLS_INSTRUCTION,
	MODEL_RELIABILITY_INSTRUCTIONS,
	isGreetingOrChitchat,
	checkIfCommandIsOutOfWorkspace,
	cleanJsonString,
	cleanToolCallTags,
	parseTextToolCalls,
	getSafeStreamLength,
	extractCodeBlocksWithPaths,
	injectRunInTerminalButtons,
	StreamButtonInjector,
	compressCode
} from './engine/chatHelpers';
import { decompose, inferCategory, estimateTokens, estimateMessagesTokens } from './engine/TaskDecomposer';
import { SYSTEM_PROMPT, MODE_PROMPTS, buildWorkspaceContext } from './participant/systemPrompt';
import { AnalyticsManager } from './engine/AnalyticsManager';
import { AnalyticsPanel } from './webview/AnalyticsPanel';
import { ModelArenaPanel } from './webview/ModelArenaPanel';
import { SearchPanel } from './webview/SearchPanel';
import { ModelPilotChatProvider } from './chatProvider';
import { ChatResult } from './providers/IProvider';
import { initDebugLogger, debugLog, safeSerialize } from './debug';

async function recordUsage(
	chatResult: ChatResult,
	inputMessages: Message[],
	globalState?: vscode.Memento,
	latencyMs = 0,
	fallbackCount = 0,
	responseContent?: string
) {
	if (!globalState) {
		return;
	}
	const provider = chatResult.provider || 'unknown';
	const modelId = chatResult.modelId || 'unknown';
	if (provider === 'unknown') {
		return;
	}

	let promptTokens = 0;
	let completionTokens = 0;

	if (chatResult.usage) {
		promptTokens = chatResult.usage.promptTokens;
		completionTokens = chatResult.usage.completionTokens;
	} else {
		// Fallback estimation
		promptTokens = estimateMessagesTokens(inputMessages);
		completionTokens = estimateTokens(chatResult.content);
	}

	const am = new AnalyticsManager(globalState);
	await am.recordRequest(
		provider,
		modelId,
		promptTokens,
		completionTokens,
		latencyMs,
		fallbackCount,
		inputMessages,
		responseContent || chatResult.content
	);
}

let globalExpertProfile = DEFAULT_EXPERT_ID;

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('modelpilot');
	return {
		stream: cfg.get<boolean>('streamResponses', true),
		defaultExpert: cfg.get<string>('defaultExpert', DEFAULT_EXPERT_ID),
		defaultMode: cfg.get<string>('defaultMode', 'default'),
		maxAutoFixRetries: cfg.get<number>('maxAutoFixRetries', 3),
		autoGenerateCommitMessageOnSave: cfg.get<boolean>('autoGenerateCommitMessageOnSave', false),
	};
}

function getDiagnosticsContextText(): string {
	let contextStr = '';
	try {
		const diagnostics = vscode.languages.getDiagnostics();
		let errorCount = 0;
		let warningCount = 0;
		let listStr = '';

		for (const [uri, diagList] of diagnostics) {
			const folders = vscode.workspace.workspaceFolders;
			const root = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
			if (!root) {
				continue;
			}
			const relPath = path.relative(root, uri.fsPath);

			// Skip files outside workspace (e.g. node_modules, internal files)
			if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
				continue;
			}

			const fileErrors = diagList.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
			const fileWarnings = diagList.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

			if (fileErrors.length > 0 || fileWarnings.length > 0) {
				listStr += `- File: ${relPath}\n`;
				fileErrors.forEach(e => {
					errorCount++;
					listStr += `  - [Error] (Line ${e.range.start.line + 1}, Col ${e.range.start.character + 1}): ${e.message}\n`;
				});
				fileWarnings.forEach(w => {
					warningCount++;
					listStr += `  - [Warning] (Line ${w.range.start.line + 1}, Col ${w.range.start.character + 1}): ${w.message}\n`;
				});
			}
		}

		if (errorCount > 0 || warningCount > 0) {
			contextStr += `[Workspace Diagnostics / Problems]\n`;
			contextStr += `Total active errors: ${errorCount}, Warnings: ${warningCount}\n`;
			contextStr += listStr + '\n';
		}
	} catch (e) {
		// Ignore diagnostics gather errors
	}
	return contextStr;
}

function getWorkspaceContextText(): string {
	let contextStr = '';
	try {
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			const root = folders[0].uri.fsPath;
			contextStr += `Workspace root: ${root}\n`;

			const visibleEditors = vscode.window.visibleTextEditors;
			if (visibleEditors.length > 0) {
				const files = Array.from(new Set(visibleEditors.map(e => e.document.uri.fsPath)));
				contextStr += `Open files in editor tabs:\n`;
				files.forEach(f => {
					contextStr += `- ${path.relative(root, f)}\n`;
				});
			}

			const activeEditor = vscode.window.activeTextEditor;
			if (activeEditor) {
				const activeRelPath = path.relative(root, activeEditor.document.uri.fsPath);
				contextStr += `Active file: ${activeRelPath}\n`;
				contextStr += `Language: ${activeEditor.document.languageId}\n`;

				const selection = activeEditor.document.getText(activeEditor.selection);
				if (selection && selection.trim().length > 0) {
					contextStr += `Selected text in active file:\n\`\`\`\n${selection}\n\`\`\`\n`;
				}
			}

			const diagnosticsContext = getDiagnosticsContextText();
			if (diagnosticsContext) {
				contextStr += `\n${diagnosticsContext}`;
			}
		} else {
			contextStr += `No open workspace folder.\n`;
		}
	} catch (e) {
		// Ignore context gather errors
	}
	return contextStr;
}



function buildCopilotMessages(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext
): vscode.LanguageModelChatMessage[] {
	const messages: vscode.LanguageModelChatMessage[] = [];
	
	for (const turn of chatContext.history) {
		if (turn && typeof turn === 'object' && 'prompt' in turn) {
			messages.push(vscode.LanguageModelChatMessage.User((turn as any).prompt));
		} else if (turn && typeof turn === 'object' && 'response' in turn) {
			let responseText = '';
			const responseParts = (turn as any).response;
			if (Array.isArray(responseParts)) {
				for (const part of responseParts) {
					if (part && typeof part === 'object') {
						if ('value' in part) {
							const val = (part as any).value;
							if (typeof val === 'string') {
								responseText += val;
							} else if (val && typeof val === 'object' && 'value' in val) {
								responseText += (val as any).value;
							}
						}
					}
				}
			}
			if (responseText) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
			}
		}
	}
	
	messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
	return messages;
}

export function getApprovalMode(): 'default' | 'bypass' | 'autopilot' {
	const userMode = vscode.workspace.getConfiguration('modelpilot').get<string>('approvalMode', 'default');
	
	if (userMode === 'default') {
		const vscodeDefault = vscode.workspace.getConfiguration('chat.permissions').get<string>('default');
		if (vscodeDefault === 'autopilot') {
			return 'autopilot';
		}
	}
	return userMode as 'default' | 'bypass' | 'autopilot';
}

async function listDirFiles(dirPath: string, maxDepth: number, currentDepth = 0): Promise<string> {
	if (currentDepth > maxDepth) {
		return '';
	}
	let result = '';
	try {
		const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'out') {
					continue;
				}
				result += '  '.repeat(currentDepth) + `[Dir] ${entry.name}\n`;
				result += await listDirFiles(entryPath, maxDepth, currentDepth + 1);
			} else {
				result += '  '.repeat(currentDepth) + `[File] ${entry.name}\n`;
			}
		}
	} catch {
		// Ignore errors
	}
	return result;
}

async function generateFollowups(
	userPrompt: string,
	assistantResponse: string,
	router: Router,
	recs: any[]
): Promise<vscode.ChatFollowup[]> {
	const isTestMode = typeof (global as any).it === 'function' || !!process.env.VSCODE_TEST_OPTIONS;
	if (isTestMode && process.env.MODELPILOT_GENERATE_FOLLOWUPS !== 'true') {
		return [];
	}

	try {
		const speedRecs = recs.filter(r => r.model && r.model.capabilities && r.model.capabilities.speed >= 5);
		const modelToUse = speedRecs.length > 0 ? [speedRecs[0]] : recs.slice(0, 1);
		if (modelToUse.length === 0) {
			return [];
		}

		const prompt = `You are a helpful assistant. Based on the user's prompt and your response, generate exactly 3 short, context-aware follow-up questions or next steps that the user might want to ask next.
Each suggestion must be extremely concise (under 8 words) and directly related to the topic.
Format your response ONLY as a JSON array of strings, with no markdown formatting, no explanation, and no other text.

Example:
[
  "Explain how this works",
  "Add error handling",
  "Write a unit test"
]

User Prompt: "${userPrompt.replace(/"/g, '\\"')}"
Assistant Response: "${assistantResponse.slice(0, 1000).replace(/"/g, '\\"')}"`;

		const result = await router.route(
			modelToUse,
			[
				{ role: 'system', content: 'You are a helpful assistant. Respond ONLY with a JSON array of strings.' },
				{ role: 'user', content: prompt }
			],
			undefined,
			{
				stream: false,
				maxTokens: 100,
				timeout: 5000
			}
		);

		if (result && result.content) {
			let content = result.content;
			content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
			
			// Find the first '[' and last ']' to isolate the JSON array
			const startIdx = content.indexOf('[');
			const endIdx = content.lastIndexOf(']');
			if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
				content = content.slice(startIdx, endIdx + 1);
			}

			const cleaned = cleanJsonString(content);
			const parsed = JSON.parse(cleaned);
			if (Array.isArray(parsed)) {
				return parsed.slice(0, 3).map(p => ({ prompt: String(p) }));
			}
		}
	} catch (e) {
		// Silently fail and return empty if followups generation fails
	}
	return [];
}

async function loadCustomInstructions(): Promise<string> {
	let instructions = '';

	// 1. Read from settings configuration
	try {
		const config = vscode.workspace.getConfiguration('modelpilot');
		const configVal = config.get<string>('customInstructions');
		if (configVal && configVal.trim()) {
			instructions += configVal.trim() + '\n\n';
		}
	} catch {}

	// 2. Read from workspace instructions files
	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const candidateFiles = [
			path.join(root, '.github', 'copilot-instructions.md'),
			path.join(root, '.github', 'modelpilot-instructions.md'),
			path.join(root, '.modelpilot-instructions.md')
		];

		for (const filePath of candidateFiles) {
			try {
				if (fs.existsSync(filePath)) {
					const content = await fs.promises.readFile(filePath, 'utf8');
					if (content && content.trim()) {
						instructions += `[From file: ${path.basename(filePath)}]\n` + content.trim() + '\n\n';
					}
				}
			} catch {}
		}
	}

	return instructions.trim();
}

export async function handleChatRequest(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	sm: SecretsManager,
	registry: ModelRegistry,
	config: { stream: boolean; defaultExpert: string; defaultMode?: string },
	refreshModels: () => Promise<number>,
	globalState?: vscode.Memento
) {
	const isTestMode = typeof (global as any).it === 'function' || !!process.env.VSCODE_TEST_OPTIONS;
	// Determine if the chat was started with modelpilot
	let startedWithModelPilot = false;
	const userTurns = chatContext.history.filter(turn => turn && typeof turn === 'object' && 'prompt' in turn);
	if (userTurns.length > 0) {
		const firstUserTurn = userTurns[0];
		const lastTurn = chatContext.history[chatContext.history.length - 1];

		const firstPart = (firstUserTurn as any).participant || '';
		const lastPart = (lastTurn as any).participant || '';

		const isFirstModelPilot = firstPart === 'modelpilot.chatParticipant' || (typeof firstPart === 'string' && firstPart.endsWith('.modelpilot.chatParticipant'));
		const isLastModelPilot = lastPart === 'modelpilot.chatParticipant' || (typeof lastPart === 'string' && lastPart.endsWith('.modelpilot.chatParticipant'));

		if (!isTestMode || isFirstModelPilot || isLastModelPilot || request.command) {
			startedWithModelPilot = true;
		}
	} else {
		// If there are no user turns in the history (e.g. Copilot welcome greeting), we route natively
		startedWithModelPilot = true;
	}

	if (!startedWithModelPilot) {
		response.progress('Forwarding request to Copilot...');
		try {
			const copilotMessages = buildCopilotMessages(request, chatContext);
			const copilotResponse = await request.model.sendRequest(copilotMessages, {}, token);
			for await (const chunk of copilotResponse.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					response.markdown(chunk.value);
				}
			}
		} catch (err: any) {
			response.markdown(`\n\n**Error forwarding request to Copilot:** ${err.message || String(err)}`);
		}
		return;
	}

	if (request.command === 'export') {
		let rootUri: vscode.Uri;
		const workspaceFolders = vscode.workspace.workspaceFolders;
		let pathLabel = '';
		if (workspaceFolders && workspaceFolders.length > 0) {
			rootUri = workspaceFolders[0].uri;
			pathLabel = 'workspace root';
		} else {
			rootUri = vscode.Uri.file(os.tmpdir());
			pathLabel = 'system temp directory';
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const fileName = `modelpilot-chat-export-${timestamp}.md`;
		const fileUri = vscode.Uri.joinPath(rootUri, fileName);

		const markdownContent = exportChatToMarkdown(chatContext);

		try {
			await vscode.workspace.fs.writeFile(fileUri, Buffer.from(markdownContent, 'utf8'));
			response.markdown(`✅ **Chat successfully exported!**\n\nThe conversation history has been written to the ${pathLabel}: [${fileName}](${fileUri.toString()})`);
		} catch (err: any) {
			response.markdown(`❌ **Error writing export file:** ${err.message || String(err)}`);
		}
		return;
	}

	// /terminal command — generate terminal commands and provide "Run in Terminal" buttons
	if (request.command === 'terminal') {
		if (!request.prompt.trim()) {
			response.markdown('Please describe what you want to do in the terminal. For example:\n\n`/terminal list all files in the current directory`');
			return;
		}

		response.progress('Generating terminal command...');

		try {
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
			const recommender = new Recommender(registry);
			let recs = recommender.recommend('coding');
			if (recs.length === 0) {
				response.progress('Refreshing models...');
				await refreshModels();
				recs = recommender.recommend('coding');
			}
			if (recs.length === 0) {
				response.markdown('❌ No available models configured. Please add an API key first using **ModelPilot: Add API Key**.');
				return;
			}

			const osPlatform = os.platform();
			const shellPath = vscode.env.shell;
			const terminalSystemPrompt = `You are a terminal command assistant. The user is on ${osPlatform} using shell: ${shellPath}.

Your task is to suggest the right terminal command(s) for the user's request.

RULES:
- Output each command inside a fenced code block with the appropriate shell language tag (e.g. \`\`\`bash or \`\`\`powershell).
- If multiple commands are needed, output each in its own code block with a brief explanation between them.
- Keep explanations short and helpful.
- Use commands appropriate for the user's OS and shell.
- Never suggest destructive commands (rm -rf /, format, etc.) without explicit user confirmation.
- If the request is ambiguous, provide the most common interpretation and mention alternatives.`;

			const terminalResult = await router.route(recs, [
				{ role: 'system', content: terminalSystemPrompt },
				{ role: 'user', content: request.prompt }
			]);

			let content = terminalResult.content || '';

			// Strip thinking tags from reasoning models
			content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
			content = content.trim();

			if (content) {
				// Inject "Run in Terminal" buttons after shell code blocks
				const withButtons = injectRunInTerminalButtons(content);
				const md = new vscode.MarkdownString(withButtons);
				md.isTrusted = { enabledCommands: ['modelpilot.runInTerminal'] };
				response.markdown(md);

				// Generate smart follow-up suggestions
				const followups = await generateFollowups(request.prompt, content, router, recs);
				return {
					followups
				};
			} else {
				response.markdown('⚠️ ModelPilot returned an empty response. Please try rephrasing your request.');
			}
		} catch (err: any) {
			response.markdown(`❌ **Terminal command generation failed:** ${err.message || String(err)}`);
		}
		return;
	}

	if (request.command === 'commit') {
		response.progress('Analyzing git changes...');
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders || workspaceFolders.length === 0) {
				response.markdown('❌ **Error:** No workspace folder is open.');
				return;
			}
			const rootPath = workspaceFolders[0].uri.fsPath;
			const cp = require('child_process');

			// Check for changes (tracked and untracked)
			const diffStatus = await new Promise<string>((resolve) => {
				cp.exec('git status --porcelain', { cwd: rootPath }, (err: any, stdout: string) => {
					resolve(stdout.trim());
				});
			});

			if (!diffStatus) {
				response.markdown('ℹ️ **No changes detected.** Your repository is clean.');
				return;
			}

			// Get the diff of staged & unstaged changes
			const gitDiff = await new Promise<string>((resolve) => {
				cp.exec('git diff HEAD', { cwd: rootPath }, (err: any, stdout: string) => {
					resolve(stdout.trim());
				});
			});

			if (!gitDiff) {
				response.markdown('ℹ️ **No modifications detected in tracked files.**');
				return;
			}

			// Truncate the diff if it's extremely long to avoid exceeding context window
			const maxDiffLength = 8000;
			const truncatedDiff = gitDiff.length > maxDiffLength
				? gitDiff.slice(0, maxDiffLength) + '\n\n... [diff truncated for length]'
				: gitDiff;

			response.progress('Generating commit message...');

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
			const recommender = new Recommender(registry);
			let recs = recommender.recommend('coding', 100, 200);
			if (recs.length === 0) {
				response.progress('Refreshing models...');
				await refreshModels();
				recs = recommender.recommend('coding', 100, 200);
			}

			if (recs.length === 0) {
				response.markdown('❌ No available models configured. Please add an API key first.');
				return;
			}

			const commitSystemPrompt = `You are a git commit message generator. Based on the git diff provided, write a single-line commit message following the Conventional Commits specification (e.g. 'feat(terminal): add run button'). Do NOT include any explanations, markdown formatting, or extra text. Output ONLY the commit message line itself.`;

			const commitResult = await router.route(recs, [
				{ role: 'system', content: commitSystemPrompt },
				{ role: 'user', content: `Here is the git diff:\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\`` }
			]);

			let commitMessage = commitResult.content || '';
			commitMessage = commitMessage.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
			commitMessage = commitMessage.trim();
			// Remove surrounding quotes or backticks if model added them
			if (commitMessage.startsWith('"') && commitMessage.endsWith('"')) {
				commitMessage = commitMessage.slice(1, -1).trim();
			}
			if (commitMessage.startsWith('`') && commitMessage.endsWith('`')) {
				commitMessage = commitMessage.slice(1, -1).trim();
			}

			if (!commitMessage) {
				response.markdown('⚠️ **Failed to generate a commit message.**');
				return;
			}

			response.progress('Committing changes...');
			
			// Commit the changes
			const commitOutput = await new Promise<{ success: boolean; output: string }>((resolve) => {
				cp.exec(`git commit -a -m "${commitMessage.replace(/"/g, '\\"')}"`, { cwd: rootPath }, (err: any, stdout: string, stderr: string) => {
					if (err) {
						resolve({ success: false, output: stderr || stdout || err.message });
					} else {
						resolve({ success: true, output: stdout });
					}
				});
			});

			if (commitOutput.success) {
				response.markdown(`🚀 **Successfully committed changes!**\n\n**Commit Message:**\n\`${commitMessage}\`\n\n\`\`\`\n${commitOutput.output.trim()}\n\`\`\``);
			} else {
				response.markdown(`❌ **Failed to commit changes:**\n\n\`\`\`\n${commitOutput.output.trim()}\n\`\`\``);
			}
		} catch (err: any) {
			response.markdown(`❌ **Commit generation failed:** ${err.message || String(err)}`);
		}
		return;
	}

	// Try decomposition first (only if no explicit slash command is entered, or if command is not a specific expert command)
	const isSlashCommand = request.command && request.command !== 'general' && request.command !== 'ask' && request.command !== 'plan' && request.command !== 'agent' && request.command !== 'terminal' && request.command !== 'commit';
	const decomposed = isSlashCommand ? null : decompose(request.prompt);

	if (decomposed && !token.isCancellationRequested) {
		const outputs: Record<string, string> = {};
		let currentCwd = '.';
		for (let i = chatContext.history.length - 1; i >= 0; i--) {
			const turn = chatContext.history[i];
			const metadata = (turn as any).result?.metadata;
			if (metadata && typeof metadata.agentCwd === 'string') {
				currentCwd = metadata.agentCwd;
				break;
			}
		}

		let finalResult: any = undefined;
		for (const subtask of decomposed.subtasks) {
			if (token.isCancellationRequested) {
				break;
			}

			let instruction = subtask.instruction;
			if (subtask.dependsOn) {
				for (const depId of subtask.dependsOn) {
					if (outputs[depId]) {
						instruction += `\n\nContext from previous step:\n${outputs[depId]}`;
					}
				}
			}

			response.markdown(`\n\n**[${subtask.category.toUpperCase()}]** — *Running subtask: ${subtask.instruction}*\n\n`);

			const subtaskRequest: vscode.ChatRequest = {
				...request,
				prompt: `${request.prompt}\n\nYour specific task: ${instruction}`,
			};

			finalResult = await executeSingleTask(
				subtaskRequest,
				chatContext,
				response,
				token,
				sm,
				registry,
				config,
				refreshModels,
				globalState,
				subtask.category,
				currentCwd
			);

			if (finalResult && finalResult.metadata) {
				if (finalResult.metadata.agentCwd) {
					currentCwd = finalResult.metadata.agentCwd;
				}
				const assistantMsgs = finalResult.metadata.messages.filter((m: any) => m.role === 'assistant');
				outputs[subtask.id] = assistantMsgs.map((m: any) => m.content).join('\n\n');
			}

			if (decomposed.subtasks.indexOf(subtask) < decomposed.subtasks.length - 1) {
				response.markdown('\n\n---\n\n');
			}
		}
		return finalResult;
	} else {
		return executeSingleTask(request, chatContext, response, token, sm, registry, config, refreshModels, globalState);
	}
}

function getFileDiagnostics(filePath: string): string {
	try {
		const fileUri = vscode.Uri.file(filePath);
		const diagnostics = vscode.languages.getDiagnostics(fileUri);
		const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
		if (errors.length === 0) {
			return '';
		}
		return errors.map(d => {
			const line = d.range.start.line + 1;
			const col = d.range.start.character + 1;
			const sourceStr = d.source ? ` [${d.source}]` : '';
			return `- Line ${line}, Col ${col}:${sourceStr} ${d.message}`;
		}).join('\n');
	} catch {
		return '';
	}
}

export async function executeSingleTask(
	request: vscode.ChatRequest,
	chatContext: vscode.ChatContext,
	response: vscode.ChatResponseStream,
	token: vscode.CancellationToken,
	sm: SecretsManager,
	registry: ModelRegistry,
	config: { stream: boolean; defaultExpert: string; defaultMode?: string },
	refreshModels: () => Promise<number>,
	globalState?: vscode.Memento,
	forcedExpertId?: string,
	forcedCwd?: string
) {
	const isTestMode = typeof (global as any).it === 'function' || !!process.env.VSCODE_TEST_OPTIONS;
	// Determine if the chat was started with modelpilot
	let startedWithModelPilot = false;
	const userTurns = chatContext.history.filter(turn => turn && typeof turn === 'object' && 'prompt' in turn);
	if (userTurns.length > 0) {
		const firstUserTurn = userTurns[0];
		const lastTurn = chatContext.history[chatContext.history.length - 1];

		const firstPart = (firstUserTurn as any).participant || '';
		const lastPart = (lastTurn as any).participant || '';

		const isFirstModelPilot = firstPart === 'modelpilot.chatParticipant' || (typeof firstPart === 'string' && firstPart.endsWith('.modelpilot.chatParticipant'));
		const isLastModelPilot = lastPart === 'modelpilot.chatParticipant' || (typeof lastPart === 'string' && lastPart.endsWith('.modelpilot.chatParticipant'));

		if (!isTestMode || isFirstModelPilot || isLastModelPilot || request.command) {
			startedWithModelPilot = true;
		}
	} else {
		// If there are no user turns in the history (e.g. Copilot welcome greeting), we route natively
		startedWithModelPilot = true;
	}

	if (!startedWithModelPilot) {
		response.progress('Forwarding request to Copilot...');
		try {
			const copilotMessages = buildCopilotMessages(request, chatContext);
			const copilotResponse = await request.model.sendRequest(copilotMessages, {}, token);
			for await (const chunk of copilotResponse.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					response.markdown(chunk.value);
				}
			}
		} catch (err: any) {
			response.markdown(`\n\n**Error forwarding request to Copilot:** ${err.message || String(err)}`);
		}
		return;
	}

	const fileDiagnosticsRetryCounts = new Map<string, number>();
	let agentCwd = forcedCwd !== undefined ? forcedCwd : '.';
	if (forcedCwd === undefined) {
		for (let i = chatContext.history.length - 1; i >= 0; i--) {
			const turn = chatContext.history[i];
			const metadata = (turn as any).result?.metadata;
			if (metadata && typeof metadata.agentCwd === 'string') {
				agentCwd = metadata.agentCwd;
				break;
			}
		}
	}

	// Resolve referenced files/folders in the user prompt early
	let referencedFilesContext = '';
	let classificationContext = '';
	if (request.references && request.references.length > 0) {
		classificationContext = `\nReferenced Context:\n`;
		for (const ref of request.references) {
			if (ref.value && typeof ref.value === 'object') {
				let filePath: string | undefined;
				if ('fsPath' in (ref.value as any)) {
					filePath = (ref.value as any).fsPath;
				} else if ('uri' in (ref.value as any) && (ref.value as any).uri && typeof (ref.value as any).uri === 'object' && 'fsPath' in (ref.value as any).uri) {
					filePath = (ref.value as any).uri.fsPath;
				}

				if (filePath) {
					try {
						const relPath = vscode.workspace.workspaceFolders 
							? path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, filePath) 
							: path.basename(filePath);
						
						classificationContext += `- Path: ${relPath}\n`;

						const stat = await fs.promises.stat(filePath);
						if (stat.isDirectory()) {
							const filesList = await listDirFiles(filePath, 3);
							referencedFilesContext += `\n\n--- Folder: ${relPath} ---\nFolder structure:\n${filesList}\n`;
						} else {
							let fileContent = await fs.promises.readFile(filePath, 'utf8');
							if (vscode.workspace.getConfiguration('modelpilot').get<boolean>('compressContext', false)) {
								const ext = path.extname(filePath);
								const lang = ext === '.py' ? 'python' : '';
								fileContent = compressCode(fileContent, lang);
							}
							const truncated = fileContent.length > 5000 
								? fileContent.slice(0, 2500) + '\n\n[Content truncated]\n\n' + fileContent.slice(-2500)
								: fileContent;
							referencedFilesContext += `\n\n--- File: ${relPath} ---\n${truncated}\n`;
						}
					} catch {
						// Ignore unreadable files/folders
					}
				}
			}
		}
	}

	// In-text file reference parsing (mimicking Copilot's #file and auto-path detection)
	const parsedPaths = new Set<string>();
	const patterns = [
		/#file:([^\s]+)/g,
		/#([a-zA-Z0-9_\-\.\/]+)/g,
		/`([a-zA-Z0-9_\-\.\/]+)`/g
	];

	for (const pattern of patterns) {
		let match;
		pattern.lastIndex = 0;
		while ((match = pattern.exec(request.prompt)) !== null) {
			const candidate = match[1];
			// Basic validation to avoid false positives for simple hashtags
			if (candidate && (candidate.includes('.') || candidate.includes('/') || candidate.includes('\\'))) {
				parsedPaths.add(candidate);
			}
		}
	}

	if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
		for (const rawPath of parsedPaths) {
			const candidates = [
				path.resolve(root, agentCwd || '.', rawPath),
				path.resolve(root, rawPath)
			];
			if (path.isAbsolute(rawPath)) {
				candidates.unshift(rawPath);
			}

			for (const absPath of candidates) {
				try {
					const stat = await fs.promises.stat(absPath);
					if (stat.isFile()) {
						const relPath = path.relative(root, absPath);
						// Avoid duplicate files if already attached via UI references
						if (referencedFilesContext.includes(`--- File: ${relPath} ---`)) {
							break;
						}

						let fileContent = await fs.promises.readFile(absPath, 'utf8');
						if (vscode.workspace.getConfiguration('modelpilot').get<boolean>('compressContext', false)) {
							const ext = path.extname(absPath);
							const lang = ext === '.py' ? 'python' : '';
							fileContent = compressCode(fileContent, lang);
						}
						const truncated = fileContent.length > 5000 
							? fileContent.slice(0, 2500) + '\n\n[Content truncated]\n\n' + fileContent.slice(-2500)
							: fileContent;
						referencedFilesContext += `\n\n--- File: ${relPath} (referenced in-text) ---\n${truncated}\n`;
						break;
					}
				} catch {
					// Continue to next candidate
				}
			}
		}
	}

	// Automatic Codebase Context Retrieval (mimicking @workspace)
	let codebaseContext = '';
	if (!isGreetingOrChitchat(request.prompt) && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
		const promptWords = request.prompt.toLowerCase()
			.replace(/[^a-z0-9\s-_]/g, ' ')
			.split(/\s+/)
			.filter(w => w.length >= 4 && !['this', 'that', 'with', 'from', 'have', 'your', 'please', 'help', 'code', 'file', 'folder', 'show', 'find', 'search', 'explain', 'what', 'here', 'want'].includes(w));

		if (promptWords.length > 0) {
			const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
			const matchedFiles = new Set<string>();

			try {
				const allFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
				for (const file of allFiles) {
					const baseName = path.basename(file.fsPath).toLowerCase();
					for (const word of promptWords) {
						if (baseName.includes(word)) {
							matchedFiles.add(file.fsPath);
						}
					}
				}

				const filesToAttach = Array.from(matchedFiles).slice(0, 3);
				if (filesToAttach.length > 0) {
					const attachedList: string[] = [];
					for (const filePath of filesToAttach) {
						try {
							const relPath = path.relative(root, filePath);
							// Avoid duplicate files if already attached
							if (referencedFilesContext.includes(relPath)) {
								continue;
							}
							let content = await fs.promises.readFile(filePath, 'utf8');
							if (vscode.workspace.getConfiguration('modelpilot').get<boolean>('compressContext', false)) {
								const ext = path.extname(filePath);
								const lang = ext === '.py' ? 'python' : '';
								content = compressCode(content, lang);
							}
							const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n... [truncated]' : content;
							codebaseContext += `\n\n--- File: ${relPath} (found via automatic codebase search) ---\n${truncated}\n`;
							attachedList.push(relPath);
						} catch {
							// Ignore unreadable files
						}
					}
					if (attachedList.length > 0) {
						response.progress(`Used codebase references: ${attachedList.map(f => path.basename(f)).join(', ')}`);
					}
				}
			} catch {
				// Ignore errors in finding files
			}
		}
	}

	let finalPrompt = request.prompt;
	if (referencedFilesContext || codebaseContext) {
		finalPrompt = `[Referenced Context]:\n${referencedFilesContext}${codebaseContext}\n\n[User Prompt]:\n${finalPrompt}`;
	}

	let expertId = forcedExpertId !== undefined ? forcedExpertId : globalExpertProfile;
	let operationMode: 'default' | 'ask' | 'plan' | 'agent' = 'default';
	
	if (forcedExpertId === undefined) {
		if (request.command) {
			if (request.command === 'ask' || request.command === 'plan' || request.command === 'agent') {
				operationMode = request.command;
			} else {
				const matched = EXPERT_PROFILES.find(e => e.id === request.command);
				if (matched) {
					expertId = matched.id;
				}
			}
		} else {
			// Use modelpilot.defaultMode configuration setting if set
			if (config.defaultMode && config.defaultMode !== 'default') {
				operationMode = config.defaultMode as 'ask' | 'plan' | 'agent';
			} else {
				// Fallback: Check if vscode has any copilot mode setting
				const copilotConfig = vscode.workspace.getConfiguration('github.copilot.chat');
				const copilotModeSetting = copilotConfig.get<string>('defaultMode') || copilotConfig.get<string>('mode');
				if (copilotModeSetting === 'ask' || copilotModeSetting === 'plan' || copilotModeSetting === 'agent') {
					operationMode = copilotModeSetting;
				}
			}
		}
	} else {
		// If forcedExpertId is provided, we can still inherit the mode if explicitly specified by command or defaults
		if (request.command === 'ask' || request.command === 'plan' || request.command === 'agent') {
			operationMode = request.command;
		} else if (config.defaultMode && config.defaultMode !== 'default') {
			operationMode = config.defaultMode as 'ask' | 'plan' | 'agent';
		}
	}

	const initialTokensEstimate = estimateTokens(request.prompt) + chatContext.history.reduce((acc, h) => acc + (h && typeof h === 'object' && 'prompt' in h ? estimateTokens((h as any).prompt) : 0), 0);
	const recommender = new Recommender(registry);
	let recs = recommender.recommend(expertId, 100, initialTokensEstimate);

	debugLog('openai_compatible', `[ROUTER] Expert: ${expertId}. Recommendations: ${safeSerialize(recs.map(r => ({ model: `${r.model.provider}::${r.model.id}`, capabilities: r.model.capabilities })))}`);

	if (recs.length === 0) {
		response.progress('No models loaded. Discovered keys, attempting to refresh models...');
		await refreshModels();
		recs = recommender.recommend(expertId, 100, initialTokensEstimate);
		debugLog('openai_compatible', `[ROUTER] Post-refresh Recommendations: ${safeSerialize(recs.map(r => ({ model: `${r.model.provider}::${r.model.id}`, capabilities: r.model.capabilities })))}`);
	}

	if (recs.length === 0) {
		const keys = await sm.getAll();
		const configured = Object.keys(keys).filter(k => (keys as any)[k].length > 0);
		if (configured.length === 0) {
			response.markdown('No models available. Run **ModelPilot: Add API Key** from the Command Palette to configure keys.');
		} else {
			const errors = registry.getLastErrors();
			let msg = 'No models available. Even though keys are configured, model discovery failed:\n';
			for (const pName of configured) {
				const err = errors.get(pName) || 'Unknown error / connection failed';
				msg += `- **${pName}**: ${err}\n`;
			}
			msg += '\nPlease verify your network connection, or run **ModelPilot: Add API Key** to clear and re-enter your keys.';
			response.markdown(msg);
		}
		return;
	}

	let isChitchat = isGreetingOrChitchat(request.prompt);
	if (isChitchat) {
		operationMode = 'ask';
	} else {
		if (operationMode === 'plan') {
			isChitchat = false;
		} else if (operationMode === 'agent') {
			isChitchat = false;
		} else if (request.command && request.command !== 'general' && request.command !== 'ask') {
			isChitchat = false;
		}
	}

	// Smart intent classification using fast LLM if keys/models are available, no command was explicitly specified, not already classified as chitchat, and forcedExpertId is not provided
	if (!isChitchat && !request.command && forcedExpertId === undefined && recs.length > 0) {
		try {
			// Find the fastest model for classification to minimize latency
			const speedRecs = recommender.recommendForSpeed();
			if (speedRecs.length > 0) {
				const classificationModel = speedRecs[0];
				
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

				const classificationPrompt = `Analyze the user's prompt and the referenced context paths to categorize the request.
Available expert profiles:
- general: General conversation, greetings, simple chitchat, or generic questions.
- coding: Coding tasks, software engineering, code generation, refactoring, debugging, code reviews.
- reverse-engineering: Static/dynamic binary analysis, disassembly, decompilers (Ghidra, IDA), ELF/PE binaries.
- binary-exploitation: Stack/heap exploits, ROP chains, format strings, buffer overflows.
- web-security: Web vulnerabilities (XSS, SQLi, SSRF, CSRF, IDOR).
- malware-analysis: Malware dynamic/static triage, YARA rules, threat intelligence.
- cryptography: Cipher analysis, encoding, RSA/AES attacks, CTF crypto.
- linux: Linux system administration, shell scripting, command line, internals.
- writing: Document drafts, essays, emails, creative writing, reports.
- documentation: API reference docs, README files, inline code comments.
- learning: Explanations of complex topics, tutorials, concept breakdowns.

Available operation modes:
- ask: Simple questions, explanations, asking how something works, or research.
- plan: Requesting an architectural design, step-by-step implementation plan, or roadmap.
- agent: Requesting file creation, modification, terminal commands execution, or performing a concrete task.

Respond ONLY with a JSON object in this format (no markdown blocks, no extra text):
{
  "isChitchat": true or false,
  "expertId": "one of the profile IDs above",
  "operationMode": "one of the operation modes above"
}

User Prompt: "${request.prompt.replace(/"/g, '\\"')}"
${classificationContext}`;

				const classificationStart = Date.now();
				let classificationFallbacks = 0;
				const classificationResult = await router.route(
					[classificationModel],
					[
						{ role: 'system', content: 'You are an intent classifier. Respond ONLY with the requested JSON.' },
						{ role: 'user', content: classificationPrompt }
					],
					undefined,
					{
						stream: false,
						maxTokens: 100,
						timeout: 10000
					},
					() => {
						classificationFallbacks++;
					}
				);

				if (classificationResult) {
					const classificationMessages: Message[] = [
						{ role: 'system', content: 'You are an intent classifier. Respond ONLY with the requested JSON.' },
						{ role: 'user', content: classificationPrompt }
					];
					const classificationLatency = Date.now() - classificationStart;
					await recordUsage(classificationResult, classificationMessages, globalState, classificationLatency, classificationFallbacks);
				}

				const parsed = JSON.parse(classificationResult.content.trim());
				if (parsed && typeof parsed === 'object') {
					if (typeof parsed.isChitchat === 'boolean') {
						isChitchat = parsed.isChitchat;
					}
					if (parsed.expertId && EXPERT_PROFILES.some(e => e.id === parsed.expertId)) {
						expertId = parsed.expertId;
					}
					if (operationMode === 'default' && parsed.operationMode && ['ask', 'plan', 'agent'].includes(parsed.operationMode)) {
						operationMode = parsed.operationMode;
						if (operationMode === 'ask') {
							isChitchat = true;
						}
					}
				}
			}
		} catch (err) {
			// Fall back to local rules if classification fails
		}
	}

	// Override: prevent 'ask' mode from disabling tools when the prompt contains code-action signals
	if (operationMode === 'ask') {
		const codeActionSignals = /\b(create|write|build|implement|fix|refactor|edit|generate|make|add|set\s*up|setup|scaffold|initialize|init|modify|update|delete|remove|rename|move|install|configure|deploy|migrate|convert|transform|port|rewrite)\b/i;
		if (codeActionSignals.test(request.prompt)) {
			operationMode = 'agent';
			isChitchat = false;
		}
	}

	let useTools = !isChitchat;
	if (operationMode === 'plan') {
		useTools = false;
	} else if (operationMode === 'agent') {
		useTools = true;
	} else if (operationMode === 'ask') {
		useTools = !isChitchat;
	}
	recs = isChitchat ? recommender.recommendForSpeed(100) : recommender.recommend(expertId, 100, initialTokensEstimate);

	// Build workspace context
	const projectStack: string[] = [];
	const rootFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (rootFolder) {
		try {
			if (fs.existsSync(path.join(rootFolder, 'package.json'))) { projectStack.push('Node.js / npm'); }
			if (fs.existsSync(path.join(rootFolder, 'tsconfig.json'))) { projectStack.push('TypeScript'); }
			if (fs.existsSync(path.join(rootFolder, 'requirements.txt')) || fs.existsSync(path.join(rootFolder, 'Pipfile')) || fs.existsSync(path.join(rootFolder, 'pyproject.toml'))) { projectStack.push('Python'); }
			if (fs.existsSync(path.join(rootFolder, 'Cargo.toml'))) { projectStack.push('Rust'); }
			if (fs.existsSync(path.join(rootFolder, 'go.mod'))) { projectStack.push('Go'); }
			if (fs.existsSync(path.join(rootFolder, 'Gemfile'))) { projectStack.push('Ruby'); }
			if (fs.existsSync(path.join(rootFolder, 'pom.xml')) || fs.existsSync(path.join(rootFolder, 'build.gradle'))) { projectStack.push('Java'); }
			if (fs.existsSync(path.join(rootFolder, 'CMakeLists.txt'))) { projectStack.push('C/C++ (CMake)'); }
		} catch {
			// ignore filesystem errors
		}
	}

	const activeEditor = vscode.window.activeTextEditor;
	const activeFile = activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri) : undefined;
	const activeLanguage = activeEditor ? activeEditor.document.languageId : undefined;
	const workspaceName = vscode.workspace.name;

	const shellPath = vscode.env.shell;
	const osPlatformForCtx = os.platform();
	const osRelease = os.release();
	const osType = os.type();
	const osName = `${osType} (${osRelease})`;

	const workspaceCtxText = buildWorkspaceContext({
		os: osName,
		shell: shellPath,
		platform: osPlatformForCtx,
		projectStack,
		availableTools: availableSystemTools,
		activeFile,
		activeLanguage,
		workspaceName,
	});

	const apiMessages: Message[] = [];
	const expert = getExpertProfile(expertId);
	let baseSystemPrompt = `${workspaceCtxText}\n\n[MODEL RELIABILITY INSTRUCTIONS]\n${SYSTEM_PROMPT}`;
	if (expert?.systemPrompt) {
		baseSystemPrompt = `${baseSystemPrompt}\n\n${expert.systemPrompt}`;
	}
	const modePrompt = MODE_PROMPTS[expertId];
	if (modePrompt) {
		baseSystemPrompt = `${baseSystemPrompt}\n\n${modePrompt}`;
	}

	const customInstructions = await loadCustomInstructions();
	if (customInstructions) {
		baseSystemPrompt = `${baseSystemPrompt}\n\n[CUSTOM INSTRUCTIONS]\n${customInstructions}`;
	}

	// Build unified system prompt if tools are used
	let finalSystemPrompt = baseSystemPrompt;
	if (useTools) {
		const systemPromptParts = [baseSystemPrompt];

		const osPlatform = os.platform();
		const osHome = os.homedir();
		const shellType = osPlatform === 'win32' ? 'Windows (CMD/PowerShell)' : 'Unix/Linux (bash/zsh)';
		const pathSeparator = osPlatform === 'win32' ? '\\' : '/';
		const envContext = `[Environment Context]
- Operating System: ${osPlatform}
- User Home Directory: ${osHome}
- Path Separator: '${pathSeparator}'
- Shell Syntax: Always use commands, tools, and path syntax compatible with ${shellType}.
- Current Working Directory (Cwd): '${agentCwd}' (relative to workspace root)
- File and Folder Context: Sincerely respect all attached file/folder references. Do not make mistakes with file names or paths. Perform only the exact tasks requested on those files.`;

		systemPromptParts.push(envContext);
		if (useTools) {
			systemPromptParts.push(TOOLS_INSTRUCTION);
		}

		const workspaceContext = getWorkspaceContextText();
		if (workspaceContext) {
			systemPromptParts.push(`[Current Workspace Context]\n${workspaceContext}`);
		}

		if (operationMode === 'agent') {
			systemPromptParts.push(`[Mode Context: Agent Mode]\nYou are operating in Agent Mode. You are an autonomous coding agent. Perform the task by using the provided tools to read, write, create, and delete files, or run terminal commands.`);
		}

		finalSystemPrompt = systemPromptParts.join('\n\n');
	} else if (operationMode === 'plan') {
		const systemPromptParts = [baseSystemPrompt];
		systemPromptParts.push(`[Mode Context: Plan Mode]\nYou are operating in Plan Mode. Your goal is to analyze the user's request and provide a comprehensive, structured, step-by-step implementation plan for the query. Do NOT output any XML tool tags or write/modify files. Focus entirely on plan formulation, architectural design, and analysis.`);
		
		const workspaceContext = getWorkspaceContextText();
		if (workspaceContext) {
			systemPromptParts.push(`[Current Workspace Context]\n${workspaceContext}`);
		}
		
		finalSystemPrompt = systemPromptParts.join('\n\n');
	} else if (operationMode === 'ask') {
		const systemPromptParts = [baseSystemPrompt];
		systemPromptParts.push(`[Mode Context: Ask Mode]\nYou are operating in Ask Mode. Provide conversational support and answer the asked query. Do NOT attempt to run tools or propose code modifications via XML blocks.`);
		
		finalSystemPrompt = systemPromptParts.join('\n\n');
	}

	finalSystemPrompt = finalSystemPrompt + '\n\n' + MODEL_RELIABILITY_INSTRUCTIONS;
	apiMessages.push({ role: 'system', content: finalSystemPrompt });

	// Identify the index of the last assistant response in the history
	let lastResponseIndex = -1;
	for (let i = 0; i < chatContext.history.length; i++) {
		if (chatContext.history[i] && typeof chatContext.history[i] === 'object' && 'response' in chatContext.history[i]) {
			lastResponseIndex = i;
		}
	}

	// Translate history turns
	for (let i = 0; i < chatContext.history.length; i++) {
		const turn = chatContext.history[i];
		if (turn && typeof turn === 'object' && 'prompt' in turn) {
			apiMessages.push({ role: 'user', content: (turn as any).prompt });
		} else if (turn && typeof turn === 'object' && 'response' in turn) {
			const metadata = (turn as any).result?.metadata;
			const isLastResponse = i === lastResponseIndex;

			if (metadata && Array.isArray(metadata.messages)) {
				if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'user') {
					apiMessages.pop();
				}
				apiMessages.push(...metadata.messages);
			} else {
				let responseText = '';
				const responseParts = (turn as any).response;
				if (Array.isArray(responseParts)) {
					for (const part of responseParts) {
						if (part && typeof part === 'object') {
							if ('value' in part) {
								const val = (part as any).value;
								if (typeof val === 'string') {
									responseText += val;
								} else if (val && typeof val === 'object' && 'value' in val) {
									responseText += (val as any).value;
								}
							}
						}
					}
				}
				if (responseText) {
					apiMessages.push({ role: 'assistant', content: responseText });
				}
			}
		}
	}

	const currentTurnStartIndex = apiMessages.length;
	apiMessages.push({ role: 'user', content: finalPrompt });

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

	const abortController = new AbortController();
	token.onCancellationRequested(() => {
		abortController.abort();
	});

	let loopIteration = 0;
	let maxIterations = 15;
	const autoFixRetryCounts = new Map<string, number>();
	const maxAutoFixRetries = getConfig().maxAutoFixRetries;
	let lastAssistantText = '';

	try {
		while (loopIteration < maxIterations) {
			if (token.isCancellationRequested || abortController.signal.aborted) {
				throw new Error('Agent execution interrupted by the user.');
			}
			loopIteration++;

			// Rebuild and update the system prompt to reflect the latest agentCwd and workspace context
			let currentSystemPrompt = baseSystemPrompt;
			if (useTools) {
				const systemPromptParts = [baseSystemPrompt];

				const osPlatform = os.platform();
				const osHome = os.homedir();
				const shellType = osPlatform === 'win32' ? 'Windows (CMD/PowerShell)' : 'Unix/Linux (bash/zsh)';
				const pathSeparator = osPlatform === 'win32' ? '\\' : '/';
				const envContext = `[Environment Context]
- Operating System: ${osPlatform}
- User Home Directory: ${osHome}
- Path Separator: '${pathSeparator}'
- Shell Syntax: Always use commands, tools, and path syntax compatible with ${shellType}.
- Current Working Directory (Cwd): '${agentCwd}' (relative to workspace root)
- File and Folder Context: Sincerely respect all attached file/folder references. Do not make mistakes with file names or paths. Perform only the exact tasks requested on those files.`;

				systemPromptParts.push(envContext);
				if (useTools) {
					systemPromptParts.push(TOOLS_INSTRUCTION);
				}

				const workspaceContext = getWorkspaceContextText();
				if (workspaceContext) {
					systemPromptParts.push(`[Current Workspace Context]\n${workspaceContext}`);
				}

				if (operationMode === 'agent') {
					systemPromptParts.push(`[Mode Context: Agent Mode]\nYou are operating in Agent Mode. You are an autonomous coding agent. Perform the task by using the provided tools to read, write, create, and delete files, or run terminal commands.`);
				} else if (operationMode === 'ask') {
					systemPromptParts.push(`[Mode Context: Ask Mode]\nYou are operating in Ask Mode. Your primary goal is to answer the user's question. You have access to tools to inspect the workspace or system (e.g. read files, list directories, search, or run non-destructive commands). Use them to gather information to answer the question. Avoid modifying files or writing new code to the workspace unless the user explicitly asks you to do so.`);
				}
				const goalReminder = `[ACTIVE TASK GOAL]\nYou are currently working on the user's request:\n"${finalPrompt}"\nAlways keep this main goal in mind. Do not get distracted by intermediate tool failures or empty search results. Your ultimate objective is to fulfill this request.`;
				systemPromptParts.push(goalReminder);

				currentSystemPrompt = systemPromptParts.join('\n\n');
			} else if (operationMode === 'plan') {
				const systemPromptParts = [baseSystemPrompt];
				systemPromptParts.push(`[Mode Context: Plan Mode]\nYou are operating in Plan Mode. Your goal is to analyze the user's request and provide a comprehensive, structured, step-by-step implementation plan for the query. Do NOT output any XML tool tags or write/modify files. Focus entirely on plan formulation, architectural design, and analysis.`);
				
				const workspaceContext = getWorkspaceContextText();
				if (workspaceContext) {
					systemPromptParts.push(`[Current Workspace Context]\n${workspaceContext}`);
				}
				
				currentSystemPrompt = systemPromptParts.join('\n\n');
			} else if (operationMode === 'ask') {
				const systemPromptParts = [baseSystemPrompt];
				systemPromptParts.push(`[Mode Context: Ask Mode]\nYou are operating in Ask Mode. Provide conversational support and answer the asked query. Do NOT attempt to run tools or propose code modifications via XML blocks.`);
				
				currentSystemPrompt = systemPromptParts.join('\n\n');
			}
			
			currentSystemPrompt = currentSystemPrompt + '\n\n' + MODEL_RELIABILITY_INSTRUCTIONS;
			if (apiMessages.length > 0 && apiMessages[0].role === 'system') {
				apiMessages[0].content = currentSystemPrompt;
			}
			if (loopIteration >= maxIterations) {
				const appMode = getApprovalMode();
				if (appMode === 'autopilot') {
					maxIterations += 15;
				} else {
					const choice = await vscode.window.showWarningMessage(
						`ModelPilot has reached the loop limit of ${maxIterations} turns. Do you want to allow it to continue running?`,
						'Allow 15 More Turns',
						'Stop Execution'
					);
					if (choice === 'Allow 15 More Turns') {
						maxIterations += 15;
					} else {
						throw new Error('Agent execution stopped by the user.');
					}
				}
			}

			// Prune older tool outputs to avoid token overhead
			let toolMessageCount = 0;
			for (let i = apiMessages.length - 1; i >= 0; i--) {
				if (apiMessages[i].role === 'tool') {
					toolMessageCount++;
					if (toolMessageCount > 2) {
						const maxPruneChars = 800;
						if (apiMessages[i].content && apiMessages[i].content.length > maxPruneChars) {
							apiMessages[i].content = apiMessages[i].content.slice(0, maxPruneChars) + '\n\n[Older tool output truncated to save context tokens]';
						}
					}
				}
			}

			const lastModel = recs[0].model;
			response.progress(`Thinking using ${lastModel.displayName} (${lastModel.provider})...`);

			let streamedTextLength = 0;
			let accumulatedText = '';
			let insideCodeBlock = false;
			let backtickCount = 0;
			const streamButtonInjector = new StreamButtonInjector(response);

			const startTime = Date.now();
			let fallbackCount = 0;
			const combinedTools = useTools ? [...AGENT_TOOLS_METADATA, ...mcpManager.getTools()] : undefined;
			const chatResult = await router.route(
				recs,
				apiMessages,
				combinedTools,
				{
					stream: config.stream,
					onChunk: (text) => {
						accumulatedText += text;
						// Strip completed think blocks so content after them can stream
						accumulatedText = accumulatedText.replace(/<think>[\s\S]*?<\/think>/gi, '');
						const safeLength = getSafeStreamLength(accumulatedText);

						if (useTools) {
							// In agent mode, suppress fenced code blocks from streaming to chat.
							// They will be intercepted and auto-written as files after the response completes.
							const textSoFar = accumulatedText.slice(0, safeLength);
							const tripleBacktickMatches = textSoFar.match(/```/g);
							const currentBacktickCount = tripleBacktickMatches ? tripleBacktickMatches.length : 0;
							insideCodeBlock = currentBacktickCount % 2 !== 0;

							if (!insideCodeBlock && currentBacktickCount === backtickCount) {
								// Not inside a code block, no new code blocks closed — stream normally
								if (safeLength > streamedTextLength) {
									const cleanTextToStream = accumulatedText.slice(streamedTextLength, safeLength);
									response.markdown(cleanTextToStream);
									streamedTextLength = safeLength;
								}
							} else if (!insideCodeBlock && currentBacktickCount > backtickCount) {
								// A code block just closed — do NOT stream it (it will be intercepted later)
								// Advance streamedTextLength to skip past the code block
								streamedTextLength = safeLength;
							}
							// If inside a code block, hold — don't stream anything
							backtickCount = currentBacktickCount;
						} else {
							// Non-agent mode: stream everything, injecting buttons statefully
							if (config.stream) {
								const safeText = accumulatedText.slice(0, safeLength);
								streamButtonInjector.write(safeText);
								streamedTextLength = safeLength;
							}
						}
					},
					maxTokens: 4096,
					abortSignal: abortController.signal,
					timeout: useTools ? 60000 : 30000,
				},
				(from, to, reason) => {
					fallbackCount++;
					response.progress(`Switching: ${from} → ${to} (${reason})`);
				}
			);

			if (chatResult) {
				const latencyMs = Date.now() - startTime;
				await recordUsage(chatResult, apiMessages, globalState, latencyMs, fallbackCount);
			}

			// Flush any remaining text in the stream
			if (!useTools && config.stream) {
				streamButtonInjector.flush(accumulatedText);
			}

			const assistantText = chatResult.content;
			lastAssistantText = assistantText;
			const toolCalls = chatResult.toolCalls && chatResult.toolCalls.length > 0
				? chatResult.toolCalls
				: parseTextToolCalls(assistantText);

			const cleanedContent = cleanToolCallTags(assistantText);

			if (!config.stream) {
				if (useTools) {
					response.markdown(cleanedContent);
				} else {
					const md = new vscode.MarkdownString(injectRunInTerminalButtons(cleanedContent));
					md.isTrusted = { enabledCommands: ['modelpilot.runInTerminal'] };
					response.markdown(md);
				}
			}

			const assistantMessage: Message = {
				role: 'assistant',
				content: cleanedContent
			};
			if (toolCalls.length > 0) {
				assistantMessage.tool_calls = toolCalls;
			}
			apiMessages.push(assistantMessage);

			if (toolCalls.length === 0) {
				// The model returned text with no tool calls.
				// If we're in agent mode, check for code blocks that should have been file operations.
				if (useTools) {
					const interceptedBlocks = extractCodeBlocksWithPaths(assistantText);

					if (interceptedBlocks.length > 0) {
						// Auto-create files from intercepted code blocks
						for (const block of interceptedBlocks) {
							try {
								response.progress(`Auto-creating file: ${block.path}`);
								await AgentExecutor.execute('create_file', { path: block.path, content: block.content }, agentCwd);
								response.markdown(`\n✅ Created **${block.path}**\n`);
							} catch (err) {
								response.markdown(`\n⚠️ Failed to create **${block.path}**: ${err instanceof Error ? err.message : String(err)}\n`);
							}
						}
						break;
					}

					// Check if the response contains ANY fenced code blocks (even without detectable paths)
					const hasCodeBlocks = /```\w*\s*\n[\s\S]*?```/.test(assistantText);
					if (hasCodeBlocks && loopIteration < maxIterations) {
						// Inject a correction and re-prompt (one attempt only)
						apiMessages.push({
							role: 'user',
							content: '[CORRECTION] You printed code in the chat response using fenced code blocks instead of using the create_file or write_file tools. This is not acceptable. You MUST use the file tools to write code into the workspace. Re-do your previous response — use create_file or write_file for every code file. Do NOT print any code in the chat.'
						});
						// Don't break — let the loop re-prompt the model
						continue;
					}
				}
				break;
			}

			// Execute the tool calls sequentially
			for (const tc of toolCalls) {
				if (token.isCancellationRequested || abortController.signal.aborted) {
					throw new Error('Agent execution interrupted by the user.');
				}

				const toolId = tc.id;
				const toolName = tc.function.name;
				let toolArgs: any = {};
				try {
					toolArgs = JSON.parse(cleanJsonString(tc.function.arguments));
				} catch (err) {
					const errMsg = `Error parsing tool arguments: ${err instanceof Error ? err.message : String(err)}`;
					apiMessages.push({
						role: 'tool',
						name: toolName,
						tool_call_id: toolId,
						content: errMsg
					});
					continue;
				}

				// Validate required arguments before prompting the user
				if (toolName === 'run_terminal_command' && (typeof toolArgs.command !== 'string' || !toolArgs.command)) {
					apiMessages.push({
						role: 'tool',
						name: toolName,
						tool_call_id: toolId,
						content: "Error: Missing required argument 'command' of type string."
					});
					continue;
				}

				if (toolName === 'run_terminal_command' && toolArgs.command && maxAutoFixRetries > 0) {
					const cmdKey = toolArgs.command;
					const currentRetries = autoFixRetryCounts.get(cmdKey) || 0;
					if (currentRetries >= maxAutoFixRetries) {
						apiMessages.push({
							role: 'tool',
							name: toolName,
							tool_call_id: toolId,
							content: `Error: Command "${cmdKey}" has already failed ${currentRetries} times. You are blocked from running it again until you modify the workspace files (using write_file, create_file, or delete_file) to fix the underlying issue. Inspect the files, fix the bugs, and then re-run.`
						});
						continue;
					}
				}
				if (['read_file', 'write_file', 'create_file', 'delete_file', 'list_directory'].includes(toolName) && (typeof toolArgs.path !== 'string' || !toolArgs.path)) {
					apiMessages.push({
						role: 'tool',
						name: toolName,
						tool_call_id: toolId,
						content: "Error: Missing required argument 'path' of type string."
					});
					continue;
				}
				if (toolName === 'search_workspace' && (typeof toolArgs.query !== 'string' || !toolArgs.query)) {
					apiMessages.push({
						role: 'tool',
						name: toolName,
						tool_call_id: toolId,
						content: "Error: Missing required argument 'query' of type string."
					});
					continue;
				}

				const needsApproval = AgentExecutor.requiresApproval(toolName);
				let approved = true;

				if (needsApproval) {
					const appMode = getApprovalMode();
					if (appMode === 'bypass') {
						approved = true;
					} else if (appMode === 'autopilot') {
						let consented = false;
						if (globalState) {
							consented = globalState.get<boolean>('autopilotConsent', false);
						}
						if (consented) {
							approved = true;
						} else {
							response.markdown('⚠️ **ModelPilot Autopilot Warning**: You are using a free agent which may make mistakes. In Autopilot mode, the agent operates without human-in-the-loop approvals. Please confirm consent in the warning dialog to proceed.');
							const choice = await vscode.window.showWarningMessage(
								'Autopilot Consent: You are enabling Autopilot mode using a free agent which may make mistakes. The agent will execute commands and modify files autonomously. Do you consent?',
								{ modal: true },
								'I Consent',
								'Cancel'
							);
							if (choice === 'I Consent') {
								if (globalState) {
									await globalState.update('autopilotConsent', true);
								}
								approved = true;
							} else {
								approved = false;
							}
						}
					} else {
						const isOutOfWorkspace = toolName === 'run_terminal_command' && checkIfCommandIsOutOfWorkspace(toolArgs.command, agentCwd);
						let message = '';
						if (toolName === 'run_terminal_command') {
							let cmdPreview = toolArgs.command;
							if (cmdPreview.length > 150 || cmdPreview.includes('\n')) {
								const lines = cmdPreview.split('\n');
								const firstLine = lines[0];
								cmdPreview = (firstLine.length > 120 ? firstLine.substring(0, 120) + '...' : firstLine) + '\n... [command truncated for length]';
							}
							if (isOutOfWorkspace) {
								message = `[WARNING: Out of Workspace Boundary]\nModelPilot wants to run a terminal command:\n\n$ ${cmdPreview}\n\n(Total length: ${toolArgs.command.length} chars)\n\nDo you approve?`;
							} else {
								message = `ModelPilot wants to run a terminal command:\n\n$ ${cmdPreview}\n\n(Total length: ${toolArgs.command.length} chars)\n\nDo you approve?`;
							}
						} else if (toolName === 'write_file') {
							message = `ModelPilot wants to modify file '${toolArgs.path}'. Do you approve?`;
						} else if (toolName === 'create_file') {
							message = `ModelPilot wants to create file '${toolArgs.path}'. Do you approve?`;
						} else if (toolName === 'delete_file') {
							message = `ModelPilot wants to delete file '${toolArgs.path}'. Do you approve?`;
						} else if (toolName === 'read_file') {
							message = `ModelPilot wants to read file '${toolArgs.path}'. Do you approve?`;
						} else {
							let argsStr = JSON.stringify(toolArgs);
							if (argsStr.length > 150) {
								argsStr = argsStr.substring(0, 150) + '... [arguments truncated]';
							}
							message = `ModelPilot wants to run tool '${toolName}' with arguments: ${argsStr}. Do you approve?`;
						}

						let choice: string | undefined;
						if (toolName === 'write_file' || toolName === 'create_file') {
							let leftUri: vscode.Uri;
							let rightUri: vscode.Uri;
							const filename = path.basename(toolArgs.path);
							const absPath = getWorkspacePath(toolArgs.path, agentCwd);
							const previewUri = vscode.Uri.parse(`modelpilot-preview:${absPath.replace(/\\/g, '/')}`);

							diffProvider.set(previewUri, toolArgs.content);

							if (toolName === 'write_file') {
								leftUri = vscode.Uri.file(absPath);
								rightUri = previewUri;
							} else {
								const emptyUri = vscode.Uri.parse(`modelpilot-preview:empty-file`);
								diffProvider.set(emptyUri, '');
								leftUri = emptyUri;
								rightUri = previewUri;
							}

							await vscode.commands.executeCommand(
								'vscode.diff',
								leftUri,
								rightUri,
								`Proposed Changes: ${filename}`
							);

							response.progress(`Awaiting approval for ${toolName === 'write_file' ? 'modifying' : 'creating'} file: ${toolArgs.path}...`);
							choice = await vscode.window.showWarningMessage(
								`ModelPilot wants to ${toolName === 'write_file' ? 'modify' : 'create'} file '${toolArgs.path}'. Review the proposed changes in the diff editor. Do you approve?`,
								{ modal: true },
								'Accept Changes',
								'Reject'
							);
							approved = (choice === 'Accept Changes');

							diffProvider.delete(previewUri);
							if (toolName === 'create_file') {
								diffProvider.delete(vscode.Uri.parse(`modelpilot-preview:empty-file`));
							}
						} else {
							response.progress(`Awaiting approval for executing tool: ${toolName}...`);
							choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Approve', 'Reject');
							approved = (choice === 'Approve');
						}
					}
				}

				let result = '';
				if (approved) {
					response.progress(`Running tool: ${toolName}...`);
					try {
						let resultStr = '';
						let newCwd: string | undefined;
						if (toolName.startsWith('mcp__')) {
							resultStr = await mcpManager.execute(toolName, toolArgs);
						} else {
							const execResult = await AgentExecutor.execute(toolName, toolArgs, agentCwd, abortController.signal);
							resultStr = execResult.result;
							newCwd = execResult.newCwd;
						}
						result = resultStr;
						if (newCwd !== undefined) {
							agentCwd = newCwd;
						}

						if (['write_file', 'create_file', 'delete_file'].includes(toolName)) {
							autoFixRetryCounts.clear();
						}

						if (['write_file', 'create_file'].includes(toolName)) {
							const sleepTime = isTestMode ? 50 : 1200;
							await new Promise(resolve => setTimeout(resolve, sleepTime));
							try {
								const absPath = getWorkspacePath(toolArgs.path, agentCwd);
								const diagnosticsText = getFileDiagnostics(absPath);
								if (diagnosticsText && maxAutoFixRetries > 0) {
									const fileKey = toolArgs.path;
									const currentRetries = fileDiagnosticsRetryCounts.get(fileKey) || 0;
									if (currentRetries < maxAutoFixRetries) {
										fileDiagnosticsRetryCounts.set(fileKey, currentRetries + 1);
										const attempt = currentRetries + 1;
										response.progress(`⚡ Self-correction: compiling & analyzing diagnostics (attempt ${attempt}/${maxAutoFixRetries})...`);
										result += `\n\n[LINT / COMPILATION ERRORS DETECTED]\nVS Code detected the following compilation/type/lint errors in the modified file:\n${diagnosticsText}\n\nYou MUST fix these compilation errors before proceeding. Use write_file to correct the file.\nSelf-correction attempt: ${attempt} of ${maxAutoFixRetries}`;
									}
								} else {
									fileDiagnosticsRetryCounts.delete(toolArgs.path);
								}
							} catch {
								// ignore path resolution issues
							}
						}

						// Self-correction: detect failed terminal commands and inject a correction hint
						if (toolName === 'run_terminal_command' && maxAutoFixRetries > 0) {
							const exitCodeMatch = result.match(/\[Exit code: (\d+)\]/);
							const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;
							const cmdKey = toolArgs.command;
							if (exitCode !== 0) {
								const currentRetries = autoFixRetryCounts.get(cmdKey) || 0;
								if (currentRetries < maxAutoFixRetries) {
									autoFixRetryCounts.set(cmdKey, currentRetries + 1);
									const attempt = currentRetries + 1;
									response.progress(`⚡ Self-correction: analyzing errors (attempt ${attempt}/${maxAutoFixRetries})...`);
									result += `\n\n[SELF-CORRECTION REQUIRED]\nThe command above failed with exit code ${exitCode}. You MUST:\n1. Analyze the error output above carefully\n2. Identify the root cause (file, line number, error type)\n3. Read the failing file(s) with read_file\n4. Fix the issue and write the corrected file(s) with write_file\n5. Re-run the exact same command to verify the fix\nDo NOT give up or apologize. Fix the code.\nSelf-correction attempt: ${attempt} of ${maxAutoFixRetries}`;
								}
							} else {
								// Command succeeded on a retry — clear the counter
								autoFixRetryCounts.delete(cmdKey);
							}
						}
					} catch (err) {
						result = err instanceof Error ? err.message : String(err);
						if (result.includes('ENOENT')) {
							if (toolName === 'read_file') {
								result += `\n\n[TIP] The file does not exist. Use the 'list_directory' or 'search_workspace' tools to locate the correct file path.`;
							} else if (toolName === 'delete_file') {
								result += `\n\n[TIP] The file does not exist, so it does not need to be deleted. You can proceed with other tasks.`;
							}
						} else if (result.includes('Access Denied')) {
							result += `\n\n[TIP] You are restricted to the workspace boundary. Ensure all path arguments are relative and resolve to files inside the active workspace.`;
						}
					}
				} else {
					result = 'Tool execution rejected by user.';
				}

				apiMessages.push({
					role: 'tool',
					name: toolName,
					tool_call_id: toolId,
					content: result
				});
			}
		}

		if (loopIteration >= maxIterations) {
			throw new Error('Maximum agent loop iterations reached.');
		}

		const followups = await generateFollowups(request.prompt, lastAssistantText, router, recs);

		return {
			metadata: {
				messages: apiMessages.slice(currentTurnStartIndex),
				agentCwd
			},
			followups
		};
	} catch (err: any) {
		console.error('executeSingleTask caught error:', err);
		if (abortController.signal.aborted || token.isCancellationRequested) {
			response.markdown('\n\n*Generation cancelled by user.*');
		} else {
			response.markdown(`\n\n**Error:** ${err.message || String(err)}`);
		}
	}
}

class ModelPilotDiffProvider implements vscode.TextDocumentContentProvider {
	private _contents = new Map<string, string>();
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this._contents.get(uri.toString()) || '';
	}

	set(uri: vscode.Uri, content: string) {
		this._contents.set(uri.toString(), content);
		this._onDidChange.fire(uri);
	}

	delete(uri: vscode.Uri) {
		if (this._contents.delete(uri.toString())) {
			this._onDidChange.fire(uri);
		}
	}
}

const diffProvider = new ModelPilotDiffProvider();

export function activate(context: vscode.ExtensionContext) {
	// Route debug logs to VS Code's per-extension log directory.
	initDebugLogger(context.logUri.fsPath);

	// Detect available system tools asynchronously in the background after activation
	setTimeout(() => {
		const commonTools = [
			'git', 'docker', 'docker-compose', 'npm', 'node', 'python', 'python3',
			'pip', 'pip3', 'gcc', 'g++', 'make', 'cmake', 'curl', 'wget',
			'cargo', 'go', 'rustc', 'java', 'javac'
		];
		const isWin = os.platform() === 'win32';
		const checkCmd = isWin
			? `where ${commonTools.join(' ')}`
			: `command -v ${commonTools.join(' ')}`;

		exec(checkCmd, (error, stdout) => {
			if (stdout) {
				const paths = stdout.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
				for (const p of paths) {
					const baseName = path.basename(p).toLowerCase().replace(/\.exe$/, '');
					if (commonTools.includes(baseName)) {
						if (!availableSystemTools.includes(baseName)) {
							availableSystemTools.push(baseName);
						}
					} else {
						for (const tool of commonTools) {
							if (baseName.includes(tool)) {
								if (!availableSystemTools.includes(tool)) {
									availableSystemTools.push(tool);
								}
								break;
							}
						}
					}
				}
				availableSystemTools.sort();
				console.log('ModelPilot: Detected available system tools:', availableSystemTools);
			}
		});
	}, 100);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider('modelpilot-preview', diffProvider)
	);

	const sm = new SecretsManager(context.secrets);

	const registry = new ModelRegistry();

	const analyticsManager = new AnalyticsManager(context.globalState);
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'modelpilot.showAnalytics';
	
	function updateStatusBar() {
		const savings = analyticsManager.getSavingsString();
		statusBarItem.text = `$(zap) ModelPilot: ${savings} Saved`;
		statusBarItem.tooltip = 'ModelPilot: Total Cost Savings (Groq/NIM vs Paid APIs)';
	}
	updateStatusBar();
	statusBarItem.show();

	const analyticsSub = analyticsManager.onDidChange(() => {
		updateStatusBar();
	});

	context.subscriptions.push(statusBarItem, analyticsSub);

	mcpManager.initializeFromConfig();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e.affectsConfiguration('modelpilot.mcpServers')) {
				await mcpManager.initializeFromConfig();
			}
		})
	);

	globalExpertProfile = getConfig().defaultExpert;

	let activeRefreshPromise: Promise<number> | undefined;

	function refreshModels(): Promise<number> {
		if (activeRefreshPromise) {
			return activeRefreshPromise;
		}
		activeRefreshPromise = (async () => {
			try {
				const keys = await sm.getAll();
				const providers = [
					new NvidiaProvider(keys.nvidia),
					new OpenRouterProvider(keys.openrouter),
					new GroqProvider(keys.groq),
					new CerebrasProvider(keys.cerebras),
					new GoogleProvider(keys.google),
					new OllamaProvider(),
				];
				await registry.refresh(providers);
				return registry.getAvailable().length;
			} finally {
				activeRefreshPromise = undefined;
			}
		})();
		return activeRefreshPromise;
	}

	refreshModels();

	// Register Native Language Model Provider
	const chatProvider = new ModelPilotChatProvider(registry, sm, analyticsManager, () => globalExpertProfile);
	const lmProviderRegistration = vscode.lm.registerLanguageModelChatProvider('modelpilot', chatProvider);
	context.subscriptions.push(lmProviderRegistration);

	// Register Status Bar Item for Quick Chat Access
	const chatStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
	chatStatusBarItem.command = 'modelpilot.newChat';
	chatStatusBarItem.text = '$(comment-discussion) ModelPilot';
	chatStatusBarItem.tooltip = 'Start a new ModelPilot chat session';
	chatStatusBarItem.show();
	context.subscriptions.push(chatStatusBarItem);

	// Register Chat Participant
	const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
		const config = getConfig();
		return handleChatRequest(request, chatContext, response, token, sm, registry, config, refreshModels, context.globalState);
	};

	const participant = vscode.chat.createChatParticipant('modelpilot.chatParticipant', handler);
	participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png');

	context.subscriptions.push(
		participant,

		vscode.commands.registerCommand('modelpilot.newChat', async () => {
			const oldClipboard = await vscode.env.clipboard.readText();
			try {
				// Open and focus the chat input
				await vscode.commands.executeCommand('workbench.action.chat.open');
				// Wait a brief moment for the chat input to gain focus
				await new Promise(resolve => setTimeout(resolve, 150));

				// Select all text in the chat input and copy it
				await vscode.commands.executeCommand('editor.action.selectAll');
				await vscode.commands.executeCommand('editor.action.clipboardCopyAction');

				// Wait a tiny bit for the clipboard write to complete
				await new Promise(resolve => setTimeout(resolve, 50));
				const copiedText = await vscode.env.clipboard.readText();

				// If it already has @modelpilot, do nothing
				if (copiedText.trim().startsWith('@modelpilot')) {
					// Restore clipboard immediately
					await vscode.env.clipboard.writeText(oldClipboard);
					return;
				}

				// Prepend @modelpilot to the existing text (or start with it if empty)
				const newText = copiedText.trim() ? `@modelpilot ${copiedText}` : '@modelpilot ';
				await vscode.env.clipboard.writeText(newText);

				// Paste the new text, overwriting the selected text
				await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
			} catch (err) {
				// Fallback to default behavior if anything fails
				await vscode.commands.executeCommand('workbench.action.chat.open', {
					query: '@modelpilot ',
					isPartialQuery: true
				});
			} finally {
				// Restore the user's original clipboard content after a brief delay
				setTimeout(async () => {
					try {
						await vscode.env.clipboard.writeText(oldClipboard);
					} catch {}
				}, 600);
			}
		}),

		vscode.commands.registerCommand('modelpilot.showAnalytics', () => {
			AnalyticsPanel.createOrShow(context.extensionUri, analyticsManager, sm);
		}),

		vscode.commands.registerCommand('modelpilot.showArena', async () => {
			const keys = await sm.getAll();
			const providers = [
				new NvidiaProvider(keys.nvidia),
				new OpenRouterProvider(keys.openrouter),
				new GroqProvider(keys.groq),
				new CerebrasProvider(keys.cerebras),
				new GoogleProvider(keys.google),
				new OllamaProvider(),
			];
			ModelArenaPanel.createOrShow(context.extensionUri, registry, providers);
		}),

		vscode.commands.registerCommand('modelpilot.compressActiveFile', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active text editor found.');
				return;
			}
			const document = editor.document;
			const text = document.getText();
			const lang = document.languageId;
			const compressed = compressCode(text, lang);

			const origTokens = Math.ceil(text.length / 4);
			const compTokens = Math.ceil(compressed.length / 4);
			const savings = origTokens > 0 ? Math.round(((origTokens - compTokens) / origTokens) * 100) : 0;

			await vscode.env.clipboard.writeText(compressed);
			vscode.window.showInformationMessage(
				`Active file compressed! Saved ${savings}% tokens (from ${origTokens} to ${compTokens} tokens). Copied to clipboard.`
			);
		}),

		vscode.commands.registerCommand('modelpilot.showSearch', () => {
			SearchPanel.createOrShow(context.extensionUri);
		}),

		vscode.commands.registerCommand('modelpilot.addApiKey', async () => {
			const providers: { label: string; detail: string; id: ProviderName }[] = [
				{
					label: 'NVIDIA NIM',
					detail: 'Free models: DeepSeek V4, Nemotron, Qwen3 Coder, Llama 4 and more',
					id: 'nvidia',
				},
				{
					label: 'OpenRouter',
					detail: 'Free tier: DeepSeek R1, Llama, Gemma and more',
					id: 'openrouter',
				},
				{
					label: 'Groq',
					detail: 'Very fast inference — Llama, Mixtral, Gemma',
					id: 'groq',
				},
				{
					label: 'Cerebras',
					detail: 'Ultra-fast wafer-scale inference — Llama 3.1, Llama 3.3',
					id: 'cerebras',
				},
				{
					label: 'Google AI Studio',
					detail: 'Free models: Gemini 2.5 Pro (1M context), Gemini 2.5 Flash',
					id: 'google',
				},
			];

			const picked = await vscode.window.showQuickPick(providers, {
				title: 'ModelPilot: Add API Key',
				placeHolder: 'Select a provider',
			});
			if (!picked) { return; }

			const existingKeys = await sm.get(picked.id);

			let action: 'add' | 'delete' | 'clear' = 'add';
			let keyIndex: number | undefined;

			if (existingKeys.length > 0) {
				const items: { label: string; detail?: string; action: 'add' | 'delete' | 'clear'; keyIndex?: number }[] = [
					{
						label: '$(add) Add new API key',
						action: 'add',
					},
				];

				existingKeys.forEach((key, index) => {
					const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '***';
					items.push({
						label: `$(key) Delete key: ${masked}`,
						detail: 'Click to remove this key',
						action: 'delete',
						keyIndex: index,
					});
				});

				items.push({
					label: '$(trash) Clear all keys',
					detail: `Remove all ${picked.label} API keys`,
					action: 'clear',
				});

				const selectedAction = await vscode.window.showQuickPick(items, {
					title: `Manage ${picked.label} API Keys`,
					placeHolder: 'Select an action',
				});
				if (!selectedAction) { return; }
				action = selectedAction.action;
				keyIndex = selectedAction.keyIndex;
			}

			if (action === 'add') {
				const key = await vscode.window.showInputBox({
					title: `${picked.label} API Key`,
					prompt: `Paste your ${picked.label} API key`,
					password: true,
					ignoreFocusOut: true,
					validateInput: v => {
						const trimmed = v.trim();
						if (trimmed.length < 10) {
							return 'Key looks too short';
						}
						if (existingKeys.includes(trimmed)) {
							return 'This API key is already registered';
						}
						return undefined;
					},
				});
				if (key && key.trim().length >= 10) {
					const trimmedKey = key.trim();
					if (!existingKeys.includes(trimmedKey)) {
						existingKeys.push(trimmedKey);
						await sm.set(picked.id, existingKeys);
						vscode.window.showInformationMessage(`ModelPilot: ${picked.label} key added.`);
					}
				}
			} else if (action === 'delete' && keyIndex !== undefined) {
				existingKeys.splice(keyIndex, 1);
				if (existingKeys.length === 0) {
					await sm.delete(picked.id);
				} else {
					await sm.set(picked.id, existingKeys);
				}
				vscode.window.showInformationMessage(`ModelPilot: Key removed.`);
			} else if (action === 'clear') {
				await sm.delete(picked.id);
				vscode.window.showInformationMessage(`ModelPilot: All keys cleared for ${picked.label}.`);
			}

			await refreshModels();
		}),

		vscode.commands.registerCommand('modelpilot.refreshModels', async () => {
			const count = await refreshModels();
			vscode.window.showInformationMessage(`ModelPilot: Found ${count} available models.`);
		}),

		vscode.commands.registerCommand('modelpilot.listModels', async () => {
			await refreshModels();
			const models = registry.getAvailable();
			if (models.length === 0) {
				vscode.window.showWarningMessage('No models found. Run "ModelPilot: Add API Key" first.');
				return;
			}
			const items = models.map(m => ({
				label: m.displayName,
				description: m.provider,
				detail: `Context: ${(m.contextLength / 1000).toFixed(0)}k · Desc: ${m.description}`,
			}));
			vscode.window.showQuickPick(items, {
				title: 'Available Models',
				placeHolder: 'All discovered models',
			});
		}),

		vscode.commands.registerCommand('modelpilot.selectExpert', async () => {
			const items = EXPERT_PROFILES.map(e => ({
				label: e.label,
				description: e.description,
				id: e.id,
			}));

			const picked = await vscode.window.showQuickPick(items, {
				title: 'ModelPilot: Select Expert Profile',
				placeHolder: 'Select an expert profile',
			});
			if (!picked) { return; }

			globalExpertProfile = picked.id;
		}),

		vscode.commands.registerCommand('modelpilot.explainCode', () => {
			return runInlineAction('Explain the following code, detailing its behavior, logic, and potential edge cases');
		}),
		vscode.commands.registerCommand('modelpilot.fixCode', () => {
			return runInlineAction('Fix any bugs, errors, or inefficiencies in the following code and write the corrected implementation');
		}),
		vscode.commands.registerCommand('modelpilot.reviewCode', () => {
			return runInlineAction('Perform a comprehensive code review of the following block, identifying style issues, potential bugs, or improvements');
		}),
		vscode.commands.registerCommand('modelpilot.generateTests', () => {
			return runInlineAction('Generate robust unit tests for the following code, covering positive, negative, and edge cases');
		}),

		vscode.commands.registerCommand('modelpilot.inlineChat', () => {
			return handleInlineChat(vscode.window.activeTextEditor, sm, registry);
		}),

		vscode.commands.registerCommand('modelpilot.runInTerminal', (command: string) => {
			if (!command) { return; }
			let terminal = vscode.window.terminals.find(t => t.name === 'ModelPilot');
			if (!terminal) {
				terminal = vscode.window.createTerminal('ModelPilot');
			}
			terminal.show(false);
			terminal.sendText(command);
		}),

		vscode.commands.registerCommand('modelpilot.configureMcpServer', async () => {
			const mcpConfig = vscode.workspace.getConfiguration('modelpilot');
			const mcpServers = { ...mcpConfig.get<Record<string, any>>('mcpServers', {}) };

			const action = await vscode.window.showQuickPick(
				[
					{ label: 'Add/Edit MCP Server', value: 'add' },
					{ label: 'Remove MCP Server', value: 'remove' },
					{ label: 'List Configured MCP Servers', value: 'list' }
				],
				{
					title: 'ModelPilot: Configure MCP Server',
					placeHolder: 'Select an action'
				}
			);
			if (!action) { return; }

			if (action.value === 'list') {
				const names = Object.keys(mcpServers);
				if (names.length === 0) {
					vscode.window.showInformationMessage('No MCP servers currently configured.');
					return;
				}
				const items = names.map(name => {
					const s = mcpServers[name];
					const argsStr = s.args && s.args.length > 0 ? ' ' + s.args.join(' ') : '';
					return {
						label: name,
						detail: `${s.command}${argsStr}`
					};
				});
				await vscode.window.showQuickPick(items, {
					title: 'ModelPilot: Configured MCP Servers',
					placeHolder: 'Select a server to view details (press Esc to close)'
				});
				return;
			}

			if (action.value === 'remove') {
				const names = Object.keys(mcpServers);
				if (names.length === 0) {
					vscode.window.showWarningMessage('No MCP servers to remove.');
					return;
				}
				const picked = await vscode.window.showQuickPick(names, {
					title: 'ModelPilot: Remove MCP Server',
					placeHolder: 'Select a server to remove'
				});
				if (!picked) { return; }

				delete mcpServers[picked];
				await mcpConfig.update('mcpServers', mcpServers, vscode.ConfigurationTarget.Global);
				vscode.window.showInformationMessage(`Successfully removed MCP server "${picked}".`);
				return;
			}

			// Add/Edit flow
			// 1. Get name
			const name = await vscode.window.showInputBox({
				title: 'ModelPilot: Configure MCP Server (1/4)',
				prompt: 'Enter a unique identifier name for the MCP server',
				placeHolder: 'e.g. weather, filesystem',
				validateInput: (value) => {
					if (!value || !value.trim()) { return 'Name is required'; }
					if (!/^[a-zA-Z0-9_-]+$/.test(value)) { return 'Name must be alphanumeric with dashes or underscores only'; }
					return null;
				}
			});
			if (!name) { return; }

			const existing = mcpServers[name] || {};

			// 2. Get command
			const command = await vscode.window.showInputBox({
				title: 'ModelPilot: Configure MCP Server (2/4)',
				prompt: 'Enter the command executable to spawn the server',
				placeHolder: 'e.g. node, npx, python',
				value: existing.command || '',
				validateInput: (value) => {
					if (!value || !value.trim()) { return 'Command is required'; }
					return null;
				}
			});
			if (!command) { return; }

			// 3. Get args
			const argsRaw = await vscode.window.showInputBox({
				title: 'ModelPilot: Configure MCP Server (3/4)',
				prompt: 'Enter space-separated arguments (optional)',
				placeHolder: 'e.g. /path/to/server.js --option value',
				value: existing.args ? existing.args.join(' ') : ''
			});
			if (argsRaw === undefined) { return; }

			const args: string[] = [];
			const matches = argsRaw.match(/(?:[^\s"]+|"[^"]*")+/g);
			if (matches) {
				for (let arg of matches) {
					if (arg.startsWith('"') && arg.endsWith('"')) {
						arg = arg.slice(1, -1);
					}
					args.push(arg);
				}
			}

			// 4. Get env (optional)
			let envValue = '';
			if (existing.env) {
				envValue = Object.entries(existing.env).map(([k, v]) => `${k}=${v}`).join(', ');
			}
			const envRaw = await vscode.window.showInputBox({
				title: 'ModelPilot: Configure MCP Server (4/4)',
				prompt: 'Enter comma-separated environment variables (optional, e.g. KEY1=VAL1, KEY2=VAL2)',
				placeHolder: 'e.g. API_KEY=secret_value, BASE_URL=https://api.com',
				value: envValue
			});
			if (envRaw === undefined) { return; }

			const env: Record<string, string> = {};
			if (envRaw && envRaw.trim()) {
				const parts = envRaw.split(',');
				for (const part of parts) {
					const [k, v] = part.split('=').map(p => p.trim());
					if (k && v) {
						env[k] = v;
					}
				}
			}

			const configObj: any = { command, args };
			if (Object.keys(env).length > 0) {
				configObj.env = env;
			}

			// Validate server connection
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Validating MCP server "${name}" connection and handshake...`,
				cancellable: false
			}, async () => {
				const connection = new McpServerConnection(name, configObj);
				try {
					const tools = await connection.initialize();
					// Success! Save to config
					mcpServers[name] = configObj;
					await mcpConfig.update('mcpServers', mcpServers, vscode.ConfigurationTarget.Global);
					vscode.window.showInformationMessage(`MCP server "${name}" validated and saved successfully! Loaded ${tools.length} tools.`);
				} catch (err: any) {
					const choice = await vscode.window.showErrorMessage(
						`Failed to validate MCP connection: ${err.message || err}. Save config anyway?`,
						'Save',
						'Cancel'
					);
					if (choice === 'Save') {
						mcpServers[name] = configObj;
						await mcpConfig.update('mcpServers', mcpServers, vscode.ConfigurationTarget.Global);
						vscode.window.showInformationMessage(`MCP server "${name}" saved anyway.`);
					}
				} finally {
					connection.dispose();
				}
			});
		}),
	);

	if ('onDidStartTerminalShellExecution' in (vscode.window as any)) {
		const terminalOutputs = new Map<any, string>();

		const cleanTerminalOutput = (raw: string): string => {
			// Strip OSC (Operating System Command) sequences (like OSC 0, OSC 633, etc.)
			let cleaned = raw.replace(/[\u001b\u009b]\][^\u0007\u001b]*(?:\u0007|[\u001b]\\)/g, '');
			// Strip ANSI escape codes
			cleaned = cleaned.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
			// Normalize carriage returns and other terminal artifacts
			cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
			// Remove duplicate consecutive empty lines
			cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
			return cleaned.trim();
		};

		context.subscriptions.push(
			(vscode.window as any).onDidStartTerminalShellExecution(async (e: any) => {
				const execution = e.execution;
				if (!execution) {
					return;
				}
				const stream = execution.read();
				let accumulated = '';
				terminalOutputs.set(execution, accumulated);
				try {
					for await (const chunk of stream) {
						accumulated += chunk;
						if (accumulated.length > 10000) {
							accumulated = accumulated.slice(-10000);
						}
						terminalOutputs.set(execution, accumulated);
					}
				} catch {
					// Stream closed or failed
				}
			})
		);

		context.subscriptions.push(
			(vscode.window as any).onDidEndTerminalShellExecution(async (e: any) => {
				const execution = e.execution;
				if (!execution) {
					return;
				}
				const exitCode = e.exitCode;
				const output = terminalOutputs.get(execution) || '';
				terminalOutputs.delete(execution);

				if (exitCode !== undefined && exitCode !== 0) {
					let commandLine = '';
					if (execution.commandLine && typeof execution.commandLine === 'object') {
						commandLine = execution.commandLine.value || '';
					} else if (typeof execution.commandLine === 'string') {
						commandLine = execution.commandLine;
					}

					const cleanOutput = cleanTerminalOutput(output);

					const choice = await vscode.window.showErrorMessage(
						`Terminal command failed: "${commandLine}" (Exit code: ${exitCode})`,
						'Explain with ModelPilot',
						'Fix with ModelPilot'
					);

					if (choice === 'Explain with ModelPilot') {
						const query = `@modelpilot /ask Explain why this terminal command failed:\nCommand: ${commandLine}\nExit Code: ${exitCode}\nOutput:\n\`\`\`\n${cleanOutput}\n\`\`\``;
						await vscode.commands.executeCommand('workbench.action.chat.open', { query });
					} else if (choice === 'Fix with ModelPilot') {
						const query = `@modelpilot /agent Fix the issue causing this terminal command to fail:\nCommand: ${commandLine}\nExit Code: ${exitCode}\nOutput:\n\`\`\`\n${cleanOutput}\n\`\`\``;
						await vscode.commands.executeCommand('workbench.action.chat.open', { query });
					}
				}
			})
		);
	}

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ pattern: '**/*' },
			new ModelPilotCodeActionProvider(),
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.Refactor,
					vscode.CodeActionKind.QuickFix
				]
			}
		)
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async (document) => {
			if (document.uri.scheme !== 'file' || document.uri.fsPath.includes('/.git/') || document.uri.fsPath.includes('\\.git\\')) {
				return;
			}

			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (!workspaceFolder) {
				return;
			}
			const rootPath = workspaceFolder.uri.fsPath;
			const filePath = document.uri.fsPath;

			const config = vscode.workspace.getConfiguration('modelpilot');
			const autoGenerateState = config.get<any>('autoGenerateCommitMessageOnSave');

			if (autoGenerateState === false) {
				return;
			}

			const checkModified = await new Promise<boolean>((resolve) => {
				exec(`git status --porcelain "${filePath}"`, { cwd: rootPath }, (err, stdout) => {
					if (err) {
						resolve(false);
					} else {
						resolve(stdout.trim().length > 0);
					}
				});
			});

			if (!checkModified) {
				return;
			}

			const hasPrompted = context.globalState.get<boolean>('modelpilot.hasPromptedAutoCommitOnSave', false);
			if (autoGenerateState !== true) {
				if (hasPrompted) {
					return;
				}
				await context.globalState.update('modelpilot.hasPromptedAutoCommitOnSave', true);
				const choice = await vscode.window.showInformationMessage(
					'ModelPilot can automatically generate conventional commit messages and summaries when you save modified files in Git. Would you like to enable this?',
					'Yes (Always)',
					'No'
				);
				if (choice === 'Yes (Always)') {
					await config.update('autoGenerateCommitMessageOnSave', true, vscode.ConfigurationTarget.Global);
				} else {
					await config.update('autoGenerateCommitMessageOnSave', false, vscode.ConfigurationTarget.Global);
					return;
				}
			}

			const gitDiff = await new Promise<string>((resolve) => {
				exec(`git diff HEAD -- "${filePath}"`, { cwd: rootPath }, (err, stdout) => {
					if (err) {
						resolve('');
					} else {
						resolve(stdout.trim());
					}
				});
			});

			if (!gitDiff) {
				return;
			}

			const maxDiffLength = 8000;
			const truncatedDiff = gitDiff.length > maxDiffLength
				? gitDiff.slice(0, maxDiffLength) + '\n\n... [diff truncated for length]'
				: gitDiff;

			try {
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
				const recommender = new Recommender(registry);
				let recs = recommender.recommend('coding', 100, 200);
				if (recs.length === 0) {
					await refreshModels();
					recs = recommender.recommend('coding', 100, 200);
				}
				if (recs.length === 0) {
					return;
				}

				const commitSystemPrompt = `You are a git commit message and diff summary generator. Based on the git diff provided for the single file, do two things:\n1. Write a single-line commit message following the Conventional Commits specification (e.g. 'feat(parser): parse retry-after correctly').\n2. Write a brief (max 2 sentences) summary of the changes made.\n\nFormat your output EXACTLY as a JSON object:\n{\n  "commitMessage": "feat(parser): ...",\n  "summary": "Updated the regex to..."\n}\nDo NOT include any explanations, markdown formatting (no \`\`\`json block wrappers), or extra text outside the JSON object. Output ONLY the raw JSON object itself.`;

				const result = await router.route(recs, [
					{ role: 'system', content: commitSystemPrompt },
					{ role: 'user', content: `Here is the git diff:\n\n${truncatedDiff}` }
				], undefined, { stream: false });

				if (result && result.content) {
					let content = result.content;
					content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
					const startIdx = content.indexOf('{');
					const endIdx = content.lastIndexOf('}');
					if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
						content = content.slice(startIdx, endIdx + 1);
					}
					const cleaned = cleanJsonString(content);
					const parsed = JSON.parse(cleaned);

					const commitMessage = (parsed.commitMessage || '').trim();
					const summary = (parsed.summary || '').trim();

					if (commitMessage) {
						try {
							const gitExtension = vscode.extensions.getExtension<any>('vscode.git')?.exports;
							const gitAPI = gitExtension?.getAPI(1);
							if (gitAPI && gitAPI.repositories) {
								const repo = gitAPI.repositories.find((r: any) => {
									const repoPath = path.normalize(r.rootUri.fsPath).toLowerCase();
									const docPath = path.normalize(filePath).toLowerCase();
									return docPath.startsWith(repoPath);
								});
								if (repo) {
									repo.inputBox.value = commitMessage;
								}
							}
						} catch {}

						const cleanMsg = commitMessage.replace(/"/g, '\\"');
						vscode.window.showInformationMessage(
							`ModelPilot suggested commit message: "${commitMessage}"\n\nSummary:\n${summary}`,
							'Commit Now',
							'Copy to Clipboard'
						).then(async (selection) => {
							if (selection === 'Commit Now') {
								exec(`git add "${filePath}" && git commit -m "${cleanMsg}"`, { cwd: rootPath }, (err, stdout, stderr) => {
									if (err) {
										vscode.window.showErrorMessage(`Failed to commit: ${stderr || err.message}`);
									} else {
										vscode.window.showInformationMessage(`Successfully committed changes to ${path.basename(filePath)}!`);
									}
								});
							} else if (selection === 'Copy to Clipboard') {
								await vscode.env.clipboard.writeText(commitMessage);
								vscode.window.showInformationMessage('Commit message copied to clipboard.');
							}
						});
					}
				}
			} catch (e) {
				// Silently fail
			}
		})
	);
}

export function deactivate() {
	mcpManager.dispose();
}

async function runInlineAction(promptPrefix: string, expertId = 'coding') {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active editor found.');
		return;
	}
	const selection = editor.selection;
	const selectedText = editor.document.getText(selection);
	if (!selectedText.trim()) {
		vscode.window.showWarningMessage('Please select some code first.');
		return;
	}

	await vscode.commands.executeCommand('workbench.action.chat.open', {
		query: `@modelpilot /${expertId} ${promptPrefix}:\n\n\`\`\`\n${selectedText}\n\`\`\``
	});
}

class ModelPilotCodeActionProvider implements vscode.CodeActionProvider {
	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		token: vscode.CancellationToken
	): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
		if (range.isEmpty) {
			return [];
		}
		const nonCodeLanguages = ['plaintext', 'markdown', 'json', 'jsonc', 'log', 'csv', 'xml', 'svg', 'ini', 'properties', 'dotenv'];
		if (nonCodeLanguages.includes(document.languageId)) {
			return [];
		}

		const explainAction = new vscode.CodeAction('ModelPilot: Explain Code', vscode.CodeActionKind.Refactor);
		explainAction.command = {
			command: 'modelpilot.explainCode',
			title: 'Explain Code',
		};

		const fixAction = new vscode.CodeAction('ModelPilot: Fix Code', vscode.CodeActionKind.QuickFix);
		fixAction.command = {
			command: 'modelpilot.fixCode',
			title: 'Fix Code',
		};

		const reviewAction = new vscode.CodeAction('ModelPilot: Review Code', vscode.CodeActionKind.Refactor);
		reviewAction.command = {
			command: 'modelpilot.reviewCode',
			title: 'Review Code',
		};

		const testAction = new vscode.CodeAction('ModelPilot: Generate Tests', vscode.CodeActionKind.Refactor);
		testAction.command = {
			command: 'modelpilot.generateTests',
			title: 'Generate Tests',
		};

		return [explainAction, fixAction, reviewAction, testAction];
	}
}

function exportChatToMarkdown(chatContext: vscode.ChatContext): string {
	let md = `# ModelPilot Chat Export\n\n`;
	md += `*Exported on: ${new Date().toLocaleString()}*\n\n`;
	md += `---\n\n`;

	for (const turn of chatContext.history) {
		if (turn && typeof turn === 'object' && 'prompt' in turn) {
			md += `### 👤 User\n\n${(turn as any).prompt}\n\n`;
		} else if (turn && typeof turn === 'object' && 'response' in turn) {
			let responseText = '';
			const responseParts = (turn as any).response;
			if (Array.isArray(responseParts)) {
				for (const part of responseParts) {
					if (part && typeof part === 'object') {
						if ('value' in part) {
							const val = (part as any).value;
							if (typeof val === 'string') {
								responseText += val;
							} else if (val && typeof val === 'object' && 'value' in val) {
								responseText += (val as any).value;
							}
						} else if ('markdown' in part) {
							const mdVal = (part as any).markdown;
							if (typeof mdVal === 'string') {
								responseText += mdVal;
							} else if (mdVal && typeof mdVal === 'object' && 'value' in mdVal) {
								responseText += (mdVal as any).value;
							}
						}
					}
				}
			}
			md += `### 🤖 ModelPilot\n\n${responseText}\n\n`;
			md += `---\n\n`;
		}
	}
	return md;
}

export async function handleInlineChat(
	editor: vscode.TextEditor | undefined,
	sm: SecretsManager,
	registry: ModelRegistry
) {
	if (!editor) {
		vscode.window.showWarningMessage('No active editor found.');
		return;
	}

	const selection = editor.selection;
	const selectedText = editor.document.getText(selection);
	const languageId = editor.document.languageId;

	const prompt = await vscode.window.showInputBox({
		title: 'ModelPilot Inline Chat',
		prompt: selectedText.trim()
			? 'Describe the changes you want to make to the selected code'
			: 'Describe the code you want to generate at the cursor',
		placeHolder: 'e.g., add a try-catch block, or write a fetch function...',
		ignoreFocusOut: true
	});

	if (!prompt || !prompt.trim()) {
		return;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'ModelPilot: Generating code...',
		cancellable: false
	}, async () => {
		try {
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

			const recommender = new Recommender(registry);
			const recs = recommender.recommend('coding');
			if (recs.length === 0) {
				throw new Error('No available models configured. Please add an API key first.');
			}

			const customInstructions = await loadCustomInstructions();
			let systemPrompt = `You are ModelPilot, an inline code generator. Your task is to output ONLY the raw code requested by the user.
NEVER include markdown code block formatting (like \`\`\`typescript), explanations, or conversational text.
Your entire response will be inserted directly into the editor.
Language: ${languageId}

If the user provided existing code, apply the requested changes and return the entire updated block.
If the user did not provide existing code, generate the new code from scratch.`;

			if (customInstructions) {
				systemPrompt += `\n\n[CUSTOM INSTRUCTIONS]\n${customInstructions}`;
			}

			const userPrompt = selectedText.trim()
				? `Existing Code:\n\`\`\`\n${selectedText}\n\`\`\`\n\nRequest: ${prompt}`
				: `Request: ${prompt}`;

			const response = await router.route(recs, [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt }
			]);

			let code = response.content || '';

			// Strip thinking process tags if present (e.g. from reasoning models like DeepSeek R1 or Qwen)
			code = code.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');

			// Strip markdown code block wrappers if the model accidentally included them
			code = code.replace(/^```[a-zA-Z0-9]*\r?\n/, '');
			code = code.replace(/\r?\n```$/, '');
			code = code.trim();

			if (code) {
				await editor.edit(editBuilder => {
					if (selection.isEmpty) {
						editBuilder.insert(selection.active, code);
					} else {
						editBuilder.replace(selection, code);
					}
				});
			} else {
				vscode.window.showWarningMessage('ModelPilot returned an empty response.');
			}
		} catch (err: any) {
			vscode.window.showErrorMessage(`ModelPilot Inline Chat failed: ${err.message}`);
		}
	});
}

