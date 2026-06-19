import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NvidiaProvider } from './providers/NvidiaProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { GroqProvider } from './providers/GroqProvider';
import { CerebrasProvider } from './providers/CerebrasProvider';
import { GoogleProvider } from './providers/GoogleProvider';
import { ModelRegistry } from './registry/ModelRegistry';
import { Recommender } from './engine/Recommender';
import { Router } from './engine/Router';
import { SecretsManager, ProviderName } from './secrets';
import { EXPERT_PROFILES, DEFAULT_EXPERT_ID, getExpertProfile } from './data/expertProfiles';
import { Message } from './providers/IProvider';
import { AgentExecutor, AGENT_TOOLS_METADATA } from './engine/AgentExecutor';
import {
	TOOLS_INSTRUCTION,
	MODEL_RELIABILITY_INSTRUCTIONS,
	isGreetingOrChitchat,
	checkIfCommandIsOutOfWorkspace,
	cleanJsonString,
	cleanToolCallTags,
	parseTextToolCalls,
	getSafeStreamLength,
	extractCodeBlocksWithPaths
} from './engine/chatHelpers';
import { decompose, inferCategory, estimateTokens, estimateMessagesTokens } from './engine/TaskDecomposer';
import { SYSTEM_PROMPT, MODE_PROMPTS, buildWorkspaceContext } from './participant/systemPrompt';
import { AnalyticsManager } from './engine/AnalyticsManager';
import { AnalyticsPanel } from './webview/AnalyticsPanel';
import { ModelPilotChatProvider } from './chatProvider';
import { ChatResult } from './providers/IProvider';

async function recordUsage(
	chatResult: ChatResult,
	inputMessages: Message[],
	globalState?: vscode.Memento
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
	await am.recordRequest(provider, modelId, promptTokens, completionTokens);
}

let globalExpertProfile = DEFAULT_EXPERT_ID;

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('modelpilot');
	return {
		stream: cfg.get<boolean>('streamResponses', true),
		defaultExpert: cfg.get<string>('defaultExpert', DEFAULT_EXPERT_ID),
		defaultMode: cfg.get<string>('defaultMode', 'default'),
		maxAutoFixRetries: cfg.get<number>('maxAutoFixRetries', 3),
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
	
	// Fallback/respect VS Code global settings if user mode is set to 'default'
	if (userMode === 'default') {
		const vscodeDefault = vscode.workspace.getConfiguration('chat.permissions').get<string>('default');
		const globalAutoApprove = vscode.workspace.getConfiguration('chat.tools.global').get<boolean>('autoApprove');
		
		if (globalAutoApprove === true || vscodeDefault === 'bypassApprovals' || vscodeDefault === 'autoApprove') {
			return 'bypass';
		}
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

	// Try decomposition first (only if no explicit slash command is entered, or if command is not a specific expert command)
	const isSlashCommand = request.command && request.command !== 'general' && request.command !== 'ask' && request.command !== 'plan' && request.command !== 'agent';
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
							const fileContent = await fs.promises.readFile(filePath, 'utf8');
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

	let finalPrompt = request.prompt;
	if (referencedFilesContext) {
		finalPrompt = `[Referenced Context]:\n${referencedFilesContext}\n\n[User Prompt]:\n${finalPrompt}`;
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
	let recs = recommender.recommend(expertId, 10, initialTokensEstimate);

	if (recs.length === 0) {
		response.progress('No models loaded. Discovered keys, attempting to refresh models...');
		await refreshModels();
		recs = recommender.recommend(expertId, 10, initialTokensEstimate);
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

	let isChitchat = false;
	if (operationMode === 'ask') {
		isChitchat = true;
	} else if (operationMode === 'plan') {
		isChitchat = false;
	} else if (operationMode === 'agent') {
		isChitchat = false;
	} else if (request.command && request.command !== 'general') {
		isChitchat = false;
	} else {
		isChitchat = isGreetingOrChitchat(request.prompt);
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
					}
				);

				if (classificationResult) {
					const classificationMessages: Message[] = [
						{ role: 'system', content: 'You are an intent classifier. Respond ONLY with the requested JSON.' },
						{ role: 'user', content: classificationPrompt }
					];
					await recordUsage(classificationResult, classificationMessages, globalState);
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
		useTools = false;
	}
	recs = isChitchat ? recommender.recommendForSpeed(10) : recommender.recommend(expertId, 10, initialTokensEstimate);

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
		systemPromptParts.push(TOOLS_INSTRUCTION);

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

	// Translate history turns
	for (const turn of chatContext.history) {
		if (turn && typeof turn === 'object' && 'prompt' in turn) {
			apiMessages.push({ role: 'user', content: (turn as any).prompt });
		} else if (turn && typeof turn === 'object' && 'response' in turn) {
			const metadata = (turn as any).result?.metadata;
			if (metadata && Array.isArray(metadata.messages)) {
				if (apiMessages.length > 0) {
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
				systemPromptParts.push(TOOLS_INSTRUCTION);

				const workspaceContext = getWorkspaceContextText();
				if (workspaceContext) {
					systemPromptParts.push(`[Current Workspace Context]\n${workspaceContext}`);
				}

				if (operationMode === 'agent') {
					systemPromptParts.push(`[Mode Context: Agent Mode]\nYou are operating in Agent Mode. You are an autonomous coding agent. Perform the task by using the provided tools to read, write, create, and delete files, or run terminal commands.`);
				}

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
					if (toolMessageCount > 4) {
						const maxPruneChars = 500;
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

			const chatResult = await router.route(
				recs,
				apiMessages,
				useTools ? AGENT_TOOLS_METADATA : undefined,
				{
					stream: config.stream,
					onChunk: (text) => {
						accumulatedText += text;
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
							// Non-agent mode: stream everything normally
							if (safeLength > streamedTextLength) {
								const cleanTextToStream = accumulatedText.slice(streamedTextLength, safeLength);
								response.markdown(cleanTextToStream);
								streamedTextLength = safeLength;
							}
						}
					},
					maxTokens: 4096,
					abortSignal: abortController.signal,
					timeout: useTools ? 60000 : 10000,
				},
				(from, to, reason) => {
					response.progress(`Switching: ${from} → ${to} (${reason})`);
				}
			);

			if (chatResult) {
				await recordUsage(chatResult, apiMessages, globalState);
			}

			const assistantText = chatResult.content;
			const toolCalls = chatResult.toolCalls && chatResult.toolCalls.length > 0
				? chatResult.toolCalls
				: parseTextToolCalls(assistantText);

			const cleanedContent = cleanToolCallTags(assistantText);

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

						response.progress(`Awaiting approval for executing tool: ${toolName}...`);
						const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Approve', 'Reject');
						approved = (choice === 'Approve');
					}
				}

				let result = '';
				if (approved) {
					response.progress(`Running tool: ${toolName}...`);
					try {
						const execResult = await AgentExecutor.execute(toolName, toolArgs, agentCwd, abortController.signal);
						result = execResult.result;
						if (execResult.newCwd !== undefined) {
							agentCwd = execResult.newCwd;
						}

						if (['write_file', 'create_file', 'delete_file'].includes(toolName)) {
							autoFixRetryCounts.clear();
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

		return {
			metadata: {
				messages: apiMessages.slice(currentTurnStartIndex),
				agentCwd
			}
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

export function activate(context: vscode.ExtensionContext) {
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
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: '@modelpilot ',
				isPartialQuery: true
			});
		}),

		vscode.commands.registerCommand('modelpilot.showAnalytics', () => {
			AnalyticsPanel.createOrShow(context.extensionUri, analyticsManager, sm);
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
					detail: 'Ultra-fast wafer-scale inference — Llama, GPT-OSS, GLM',
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
	);

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
}

export function deactivate() { }

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
