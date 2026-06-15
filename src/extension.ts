import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { NvidiaProvider } from './providers/NvidiaProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';
import { GroqProvider } from './providers/GroqProvider';
import { ModelRegistry } from './registry/ModelRegistry';
import { Recommender } from './engine/Recommender';
import { Router } from './engine/Router';
import { ChatSession } from './chat/ChatSession';
import { SecretsManager, ProviderName } from './secrets';
import { EXPERT_PROFILES, DEFAULT_EXPERT_ID, getExpertProfile } from './data/expertProfiles';
import { AgentExecutor, AGENT_TOOLS_METADATA, getWorkspacePath, getWorkspaceRoot } from './engine/AgentExecutor';

interface SavedSession {
	id: string;
	title: string;
	expertId: string;
	createdAt: number;
	messages: any[];
}

type WebviewMessage =
	| { type: 'sendMessage'; text: string; expertId: string }
	| { type: 'changeExpert'; expertId: string }
	| { type: 'newChat' }
	| { type: 'refreshModels' }
	| { type: 'selectSession'; sessionId: string }
	| { type: 'deleteSession'; sessionId: string }
	| { type: 'approveTool'; id: string }
	| { type: 'rejectTool'; id: string }
	| { type: 'stopGeneration' }
	| { type: 'openFile'; path: string }
	| { type: 'insertCode'; text: string }
	| { type: 'runCommand'; command: string }
	| { type: 'approveAllReads' };

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('modelpilot');
	return {
		stream: cfg.get<boolean>('streamResponses', true),
		defaultExpert: cfg.get<string>('defaultExpert', DEFAULT_EXPERT_ID),
	};
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
		} else {
			contextStr += `No open workspace folder.\n`;
		}
	} catch (e) {
		// Ignore context gather errors
	}
	return contextStr;
}

import { ToolCall, Message } from './providers/IProvider';

const TOOLS_INSTRUCTION = `
[TOOL CALLING INSTRUCTION]
You have access to a set of controlled tools to interact with the workspace and run terminal commands.
You can request tool calls either using:
1. Native function calling (if supported by your API).
2. Or by outputting XML blocks in your text response. If you choose this, use the following exact XML structure:

<use_tool>
  <name>tool_name</name>
  <arguments>
    { "param": "value" }
  </arguments>
</use_tool>

Available Tools:

1. read_file
   Description: Read the contents of a file in the workspace. Requires approval.
   Arguments: { "path": "relative/path/to/file" }

2. write_file
   Description: Overwrite or update an existing file. Requires approval, shows diff.
   Arguments: { "path": "relative/path/to/file", "content": "full new content" }

3. create_file
   Description: Create a new file with content. Requires approval.
   Arguments: { "path": "relative/path/to/file", "content": "content" }

4. delete_file
   Description: Delete a file from the workspace. Requires approval.
   Arguments: { "path": "relative/path/to/file" }

5. search_workspace
   Description: Search the workspace files for a specific query string (grep).
   Arguments: { "query": "text to find" }

6. list_directory
   Description: List the contents of a directory in the workspace.
   Arguments: { "path": "relative/path/to/directory" }

7. get_open_files
   Description: List currently open files in editor tabs.
   Arguments: {}

8. run_terminal_command
   Description: Run a shell command in the workspace folder. Requires approval.
   Arguments: { "command": "npm test" }

Important:
- Read-only file content inspection (read_file) and modifying operations (write_file, create_file, delete_file, run_terminal_command) strictly require explicit user approval. You CANNOT execute these operations autonomously without the user explicitly clicking the "Approve" button on their screen. Always expect that your file reads, deletions, or terminal runs will be reviewed and approved by the user first.
- **Stricter Download/Installation Rules**: You are strictly prohibited from initiating package installations, compiling heavy binaries, or running shell commands that trigger network downloads (e.g. curl, wget, npm install, cargo build, pip install) without describing exactly what is being downloaded/installed in the chat and seeking user consent via chat *first*. This applies to all downloads, regardless of size (even light files).
- Use tools whenever you need to inspect the workspace, read files, edit code, search, or run build/test commands.
- **Automated Iterative Execution Loop**: Tool execution is fully automated and handled in a loop. When you request a tool call (either natively or via XML/JSON), the framework immediately intercepts it, prompts the user for approval (for modifying/destructive/read actions to ensure safety), executes it, and feeds the command output back to you in the next conversation turn automatically.
- **Do Not Ask the User to Run Commands Manually**: Never output text telling the user "run this command" or "let me know when the command is done." Just output the tool call. The system will run it and present you the output.
- **Reiterate on Tool Outputs**: Analyze the returned tool outputs, determine the next logical step, and call additional tools (e.g. read files, search, run sub-commands) in sequence to deep-dive. Continue iterating inside this loop until you have concrete, absolute findings.
- **Deliver Direct, Non-Vague Results**: Provide final, direct, and actionable findings (e.g. specific security flags, errors, or file structures) rather than generalized or vague summaries. Your goal is to deliver the complete answer autonomously.
- **Terminal Versatility**: The 'run_terminal_command' tool is your most general and powerful companion. Use it for complex system queries, running shell scripts, package managers, version control, running tests, or performing recursive system/workspace searches (like locating files by name or patterns) that are not covered by the simple read/write/list tools.
- **Scope Restriction**: File operations ('read_file', 'write_file', 'create_file', 'delete_file', 'list_directory') are strictly locked to the workspace root directory. To access, read, write, create, or modify files/directories outside the workspace root (e.g., '~/Downloads', system folders), you **must** use 'run_terminal_command'.
- **Operating System Casing & Path Rules**: Be mindful of path separators and case-sensitivity for the target OS (shown in [Environment Context]). For example, on Linux, paths are case-sensitive (e.g., '~/Downloads' is different from '~/downloads'), whereas Windows is typically case-insensitive. Always check for directory existence or use standard naming conventions to avoid creating redundant folders.
- Respond with tool calls to perform operations, then analyze the results returned to you, and proceed step-by-step until the task is complete.
`;

function isGreetingOrChitchat(text: string): boolean {
	const cleaned = text.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");

	const exactGreetings = new Set([
		'hi', 'hello', 'hey', 'hola', 'yo', 'sup', 'greetings', 'morning', 'afternoon', 'evening',
		'good morning', 'good afternoon', 'good evening', 'howdy',
		'how are you', 'how are you doing', 'hows it going', 'whats up', 'whats new',
		'who are you', 'what is your name', 'what are you', 'test', 'ping',
		'hi there', 'hello there', 'hey there', 'yo there'
	]);

	if (exactGreetings.has(cleaned)) {
		return true;
	}

	const conversationalWords = new Set([
		'hi', 'hello', 'hey', 'hola', 'yo', 'sup', 'greetings', 'morning', 'afternoon', 'evening',
		'good', 'howdy', 'how', 'are', 'you', 'doing', 'is', 'it', 'going', 'whats', 'up', 'new',
		'who', 'what', 'name', 'test', 'ping', 'there', 'this', 'a', 'the', 'to', 'your', 'today', 'buddy', 'friend'
	]);

	const words = cleaned.split(/\s+/).filter(w => w.length > 0);
	if (words.length > 0 && words.every(w => conversationalWords.has(w))) {
		return true;
	}

	// Smart chitchat heuristic: general informational queries that do not mention workspace files/code
	const isGeneralQuestion = /^(what is|who is|explain|tell me about|how do i|how does|why is|why do|what does)\b/i.test(cleaned);
	const mentionsWorkspace = /\b(file|folder|code|directory|project|workspace|repo|run|compile|test|build|error|debug|terminal|shell|command|function|class|method|variable|import|require)\b/i.test(cleaned);
	if (isGeneralQuestion && !mentionsWorkspace) {
		return true;
	}

	return false;
}

function checkIfCommandIsOutOfWorkspace(command: string): boolean {
	try {
		const root = getWorkspaceRoot();

		// Look for absolute paths (starting with / or C:\ or [letter]:\)
		const absPathRegex = /(?:\/|[A-Za-z]:\\)[\w_.\-\/\\*]+/g;
		let match;
		while ((match = absPathRegex.exec(command)) !== null) {
			const matchedPath = match[0];
			try {
				const resolved = path.resolve(root, matchedPath);
				if (!resolved.startsWith(root)) {
					return true;
				}
			} catch {
				// Path resolution failed (invalid characters, etc.) — continue checking
			}
		}

		// Look for relative paths traversing upwards
		if (command.includes('..')) {
			return true;
		}

		// Look for home directory shortcuts or environment variables pointing outside workspace
		if (command.includes('~/') || command.includes('$HOME') || command.includes('%USERPROFILE%')) {
			return true;
		}
	} catch {
		// If no workspace is open, then any command is technically out of workspace
		return true;
	}
	return false;
}

function cleanJsonString(str: string): string {
	let cleaned = str.trim();
	if (cleaned.startsWith('```')) {
		cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
	}
	return cleaned.trim();
}

function extractJsonObjects(text: string): any[] {
	const objects: any[] = [];
	let openBraces = 0;
	let startIdx = -1;
	let inString = false;
	let escapeNext = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (escapeNext) {
			escapeNext = false;
			continue;
		}
		if (char === '\\') {
			escapeNext = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (!inString) {
			if (char === '{') {
				if (openBraces === 0) {
					startIdx = i;
				}
				openBraces++;
			} else if (char === '}') {
				if (openBraces > 0) {
					openBraces--;
					if (openBraces === 0 && startIdx !== -1) {
						const candidate = text.slice(startIdx, i + 1);
						try {
							const cleaned = cleanJsonString(candidate);
							const obj = JSON.parse(cleaned);
							if (obj && typeof obj === 'object') {
								objects.push(obj);
							}
						} catch {
							// Ignore invalid JSON
						}
						startIdx = -1;
					}
				}
			}
		}
	}
	return objects;
}

function parseTextToolCalls(text: string): ToolCall[] {
	const toolCalls: ToolCall[] = [];
	let index = 0;

	// 1. Scan for XML-based use_tool blocks
	const blockRegex = /(?:<use_tool>|<_tool>|<tool>|use_tool>|_tool>|tool>|\buse_tool\b|\b_tool\b)\s*([\s\S]*?)\s*(?:<\/use_tool>|<\/_tool>|<\/tool>|\/use_tool>|\/_tool>|\/tool>|\/arguments|<\/arguments>|\buse_tool\b|\b_tool\b|$)/gi;
	let match;
	const xmlMatches: string[] = [];

	while ((match = blockRegex.exec(text)) !== null) {
		xmlMatches.push(match[0]);
		const content = match[1];
		if (!content.trim()) { continue; }

		const knownTools = [
			'read_file', 'write_file', 'create_file', 'delete_file',
			'search_workspace', 'list_directory', 'get_open_files', 'run_terminal_command'
		];
		let name = '';
		for (const t of knownTools) {
			if (content.includes(t)) {
				name = t;
				break;
			}
		}

		if (!name) {
			const nameMatch = content.match(/(?:name>|<name>|name\s*[:=]?\s*)([\w_-]+)/i);
			if (nameMatch) {
				name = nameMatch[1].trim();
				if (name.endsWith('name') && name.length > 4) {
					name = name.slice(0, -4);
				}
			}
		}

		let argsStr = '{}';
		const argsTagMatch = content.match(/(?:arguments>|<arguments>|arguments\s*[:=]?\s*)([\s\S]*?)(?:<\/arguments>|\/arguments|$)/i);
		if (argsTagMatch) {
			const rawArgs = argsTagMatch[1].trim();
			if (rawArgs.startsWith('{') && rawArgs.endsWith('}')) {
				argsStr = cleanJsonString(rawArgs);
			} else {
				if (name === 'run_terminal_command') {
					argsStr = JSON.stringify({ command: rawArgs });
				} else if (name === 'read_file' || name === 'delete_file' || name === 'list_directory') {
					argsStr = JSON.stringify({ path: rawArgs });
				} else if (name === 'search_workspace') {
					argsStr = JSON.stringify({ query: rawArgs });
				} else {
					const jsonMatch = rawArgs.match(/(\{[\s\S]*?\})/);
					argsStr = jsonMatch ? cleanJsonString(jsonMatch[1]) : '{}';
				}
			}
		} else {
			const jsonMatch = content.match(/(\{[\s\S]*?\})/);
			argsStr = jsonMatch ? cleanJsonString(jsonMatch[1]) : '{}';
		}

		if (name) {
			toolCalls.push({
				id: `call_${name}_${index++}_${crypto.randomBytes(4).toString('hex')}`,
				type: 'function',
				function: {
					name,
					arguments: argsStr
				}
			});
		}
	}

	// 2. Strip XML matches from text to prevent duplicate parsing of JSON inside XML arguments
	let remainingText = text;
	for (const xmlMatch of xmlMatches) {
		remainingText = remainingText.replace(xmlMatch, '');
	}

	// 3. Scan remaining text for raw JSON tool calls
	const jsonObjects = extractJsonObjects(remainingText);
	const knownTools = [
		'read_file', 'write_file', 'create_file', 'delete_file',
		'search_workspace', 'list_directory', 'get_open_files', 'run_terminal_command'
	];

	for (const obj of jsonObjects) {
		let name = '';
		let args: any = {};

		if (obj.name && typeof obj.name === 'string' && knownTools.includes(obj.name)) {
			name = obj.name;
			args = obj.parameters || obj.arguments || obj.args || obj;
		} else if (obj.tool && typeof obj.tool === 'string' && knownTools.includes(obj.tool)) {
			name = obj.tool;
			args = obj.arguments || obj.parameters || obj.args || obj;
		} else if (obj.action && typeof obj.action === 'string' && knownTools.includes(obj.action)) {
			name = obj.action;
			args = obj.arguments || obj.parameters || obj.args || obj;
		} else if (obj.function && typeof obj.function === 'object' && obj.function.name && typeof obj.function.name === 'string' && knownTools.includes(obj.function.name)) {
			name = obj.function.name;
			args = obj.function.arguments || obj.function.args || obj.arguments || obj.parameters || {};
		}

		// Ensure we don't self-reference name/tool/action inside arguments if args is the object itself
		if (args === obj) {
			const { name: _n, tool: _t, action: _a, function: _f, ...rest } = obj;
			args = rest;
		}

		if (name) {
			let argsStr = '{}';
			if (typeof args === 'string') {
				argsStr = args;
			} else if (typeof args === 'object' && args !== null) {
				argsStr = JSON.stringify(args);
			}

			toolCalls.push({
				id: `call_${name}_${index++}_${crypto.randomBytes(4).toString('hex')}`,
				type: 'function',
				function: {
					name,
					arguments: argsStr
				}
			});
		}
	}

	return toolCalls;
}

class ModelPilotViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private session: ChatSession;
	private sessions: SavedSession[] = [];
	private pendingApprovals = new Map<string, { resolve: (approved: boolean) => void; toolName: string }>();
	private activeAbortControllers = new Map<string, AbortController>();
	private commandQueue: { command: string; sId: string }[] = [];
	private isProcessingQueue = false;
	private autoApproveReads = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly extensionPath: string,
		private readonly registry: ModelRegistry,
		private readonly sm: SecretsManager,
		private readonly context: vscode.ExtensionContext,
	) {
		this.session = new ChatSession(getConfig().defaultExpert);
		this.sessions = this.context.workspaceState.get<SavedSession[]>('modelpilot.sessions', []);
	}

	resetSession() {
		this.session = new ChatSession(getConfig().defaultExpert);
	}

	syncSession(sessionToSync: ChatSession = this.session) {
		const idx = this.sessions.findIndex(s => s.id === sessionToSync.id);
		const currentMsgs = sessionToSync.getMessages().map(m => ({
			id: m.id,
			role: m.role,
			content: m.content,
			model: m.model,
			provider: m.provider,
			timestamp: m.timestamp,
		}));

		if (idx >= 0) {
			this.sessions[idx].messages = currentMsgs;
			this.sessions[idx].expertId = sessionToSync.expertId;
			if (this.sessions[idx].title === 'New Chat') {
				const firstUserMsg = sessionToSync.getMessages().find(m => m.role === 'user');
				if (firstUserMsg && firstUserMsg.content) {
					const cleanText = firstUserMsg.content.replace(/\s+/g, ' ').trim();
					this.sessions[idx].title = cleanText.length > 30 ? cleanText.slice(0, 30) + '...' : cleanText;
				}
			}
		} else {
			const firstUserMsg = sessionToSync.getMessages().find(m => m.role === 'user');
			let title = 'New Chat';
			if (firstUserMsg && firstUserMsg.content) {
				const cleanText = firstUserMsg.content.replace(/\s+/g, ' ').trim();
				title = cleanText.length > 30 ? cleanText.slice(0, 30) + '...' : cleanText;
			}

			this.sessions.push({
				id: sessionToSync.id,
				title,
				expertId: sessionToSync.expertId,
				createdAt: sessionToSync.createdAt,
				messages: currentMsgs,
			});
		}

		this.context.workspaceState.update('modelpilot.sessions', this.sessions);
		this._view?.webview.postMessage({ type: 'sessionsUpdated', sessions: this.sessions });
	}

	private async processCommandQueue(): Promise<void> {
		if (this.isProcessingQueue || this.commandQueue.length === 0) {
			return;
		}

		this.isProcessingQueue = true;

		try {
			while (this.commandQueue.length > 0) {
				const item = this.commandQueue[0];
				const toolCallId = `call_run_terminal_command_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
				const isOutOfWorkspace = checkIfCommandIsOutOfWorkspace(item.command);

				const abortController = new AbortController();
				this.activeAbortControllers.set(item.sId, abortController);

				this._view?.webview.postMessage({
					type: 'toolConfirm',
					id: toolCallId,
					name: 'run_terminal_command',
					args: { command: item.command },
					isOutOfWorkspace,
					sessionId: item.sId,
					standalone: true
				});

				const approved = await new Promise<boolean>((resolve) => {
					this.pendingApprovals.set(toolCallId, { resolve, toolName: 'run_terminal_command' });
				});

				if (approved && !abortController.signal.aborted) {
					this._view?.webview.postMessage({
						type: 'toolStart',
						id: toolCallId,
						name: 'run_terminal_command',
						args: { command: item.command },
						sessionId: item.sId,
						standalone: true
					});
					try {
						const result = await AgentExecutor.execute('run_terminal_command', { command: item.command }, abortController.signal);
						this._view?.webview.postMessage({
							type: 'toolEnd',
							id: toolCallId,
							name: 'run_terminal_command',
							success: true,
							result,
							status: 'completed',
							sessionId: item.sId,
							standalone: true
						});
					} catch (err: any) {
						this._view?.webview.postMessage({
							type: 'toolEnd',
							id: toolCallId,
							name: 'run_terminal_command',
							success: false,
							result: err.message,
							status: 'failed',
							sessionId: item.sId,
							standalone: true
						});
					}
				}

				this.activeAbortControllers.delete(item.sId);
				// Shift the queue after processing is finished
				this.commandQueue.shift();
			}
		} finally {
			this.isProcessingQueue = false;
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
		};

		webviewView.webview.html = this.getHtml(webviewView.webview);

		setTimeout(() => {
			const count = this.registry.getAvailable().length;
			this._view?.webview.postMessage({ type: 'modelsRefreshed', count });
			this._view?.webview.postMessage({ type: 'sessionsUpdated', sessions: this.sessions });
			this._view?.webview.postMessage({
				type: 'loadSession',
				session: {
					id: this.session.id,
					title: this.sessions.find(s => s.id === this.session.id)?.title || 'New Chat',
					expertId: this.session.expertId,
					createdAt: this.session.createdAt,
					messages: this.session.getMessages(),
				},
				isGenerating: this.activeAbortControllers.has(this.session.id)
			});
		}, 500);

		webviewView.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
			const keys = await this.sm.getAll();
			const providers = [
				new NvidiaProvider(keys.nvidia),
				new OpenRouterProvider(keys.openrouter),
				new GroqProvider(keys.groq),
			];
			const router = new Router(providers);

			switch (msg.type) {
				case 'newChat':
					this.session = new ChatSession(getConfig().defaultExpert);
					this._view?.webview.postMessage({
						type: 'loadSession',
						session: {
							id: this.session.id,
							title: 'New Chat',
							expertId: this.session.expertId,
							createdAt: this.session.createdAt,
							messages: [],
						},
						isGenerating: false
					});
					break;

				case 'changeExpert':
					this.session.expertId = msg.expertId;
					this.syncSession();
					break;

				case 'refreshModels': {
					await this.registry.refresh(providers);
					const count = this.registry.getAvailable().length;
					this._view?.webview.postMessage({ type: 'modelsRefreshed', count });
					vscode.window.showInformationMessage(`ModelPilot: ${count} models available.`);
					break;
				}

				case 'selectSession': {
					const saved = this.sessions.find(s => s.id === msg.sessionId);
					if (saved) {
						this.session.load(saved.id, saved.createdAt, saved.expertId, saved.messages as any);
						this._view?.webview.postMessage({
							type: 'loadSession',
							session: saved,
							isGenerating: this.activeAbortControllers.has(saved.id)
						});
					}
					break;
				}

				case 'deleteSession': {
					this.sessions = this.sessions.filter(s => s.id !== msg.sessionId);
					this.context.workspaceState.update('modelpilot.sessions', this.sessions);
					this._view?.webview.postMessage({ type: 'sessionsUpdated', sessions: this.sessions });

					if (this.session.id === msg.sessionId) {
						this.resetSession();
						this._view?.webview.postMessage({
							type: 'loadSession',
							session: {
								id: this.session.id,
								title: 'New Chat',
								expertId: this.session.expertId,
								createdAt: this.session.createdAt,
								messages: [],
							},
							isGenerating: false
						});
					}
					break;
				}

				case 'approveTool': {
					const pending = this.pendingApprovals.get(msg.id);
					if (pending) {
						pending.resolve(true);
						this.pendingApprovals.delete(msg.id);
					}
					break;
				}

				case 'rejectTool': {
					const pending = this.pendingApprovals.get(msg.id);
					if (pending) {
						pending.resolve(false);
						this.pendingApprovals.delete(msg.id);
					}
					break;
				}

				case 'approveAllReads': {
					this.autoApproveReads = true;
					for (const [id, pending] of this.pendingApprovals.entries()) {
						if (pending.toolName === 'read_file') {
							pending.resolve(true);
							this.pendingApprovals.delete(id);
						}
					}
					break;
				}

				case 'stopGeneration': {
					const sId = (msg as any).sessionId || this.session.id;
					const controller = this.activeAbortControllers.get(sId);
					if (controller) {
						controller.abort();
						this.activeAbortControllers.delete(sId);
					}
					for (const [id, pending] of this.pendingApprovals.entries()) {
						pending.resolve(false);
					}
					this.pendingApprovals.clear();
					break;
				}

				case 'openFile': {
					try {
						let filePath = msg.path;
						if (filePath.startsWith('file://')) {
							filePath = vscode.Uri.parse(filePath).fsPath;
						}
						if (!path.isAbsolute(filePath)) {
							const root = getWorkspaceRoot();
							filePath = path.join(root, filePath);
						}
						const doc = await vscode.workspace.openTextDocument(filePath);
						await vscode.window.showTextDocument(doc);
					} catch (e: any) {
						vscode.window.showErrorMessage(`Failed to open file: ${e.message}`);
					}
					break;
				}

				case 'insertCode': {
					const editor = vscode.window.activeTextEditor;
					if (editor) {
						editor.edit(editBuilder => {
							editBuilder.insert(editor.selection.active, msg.text);
						});
					} else {
						vscode.window.showErrorMessage('No active text editor to insert code.');
					}
					break;
				}

				case 'runCommand': {
					const sId = this.session.id;
					this.commandQueue.push({ command: msg.command, sId });
					this.processCommandQueue();
					break;
				}

				case 'sendMessage': {
					const generatingSession = this.session;
					const sessionId = generatingSession.id;

					this.autoApproveReads = false;
					generatingSession.addMessage('user', msg.text);
					generatingSession.expertId = msg.expertId;
					this.syncSession(generatingSession);



					const toolEnabledExperts = new Set([
						'general', 'coding', 'linux', 'reverse-engineering', 'binary-exploitation',
						'web-security', 'malware-analysis', 'cryptography', 'documentation',
						'writing', 'learning'
					]);
					const useTools = toolEnabledExperts.has(msg.expertId) && !isGreetingOrChitchat(msg.text);
					const recs = useTools
						? new Recommender(this.registry).recommend(msg.expertId)
						: new Recommender(this.registry).recommendForSpeed();

					if (recs.length === 0) {
						this._view?.webview.postMessage({
							type: 'messageError',
							id: 'no-model',
							error: 'No models available. Run "ModelPilot: Add API Key" from the Command Palette.',
							sessionId
						});
						return;
					}

					const lastModel = recs[0].model;
					let assistantMessage = generatingSession.addMessage(
						'assistant',
						'',
						lastModel.id,
						lastModel.provider
					);
					const assistantId = assistantMessage.id;

					// Tell the webview which ID to stream into
					this._view?.webview.postMessage({ type: 'thinking', id: assistantId, sessionId });

					const abortController = new AbortController();
					this.activeAbortControllers.set(sessionId, abortController);

					(async () => {
						let loopIteration = 0;
						const maxIterations = 15;
						let activeAssistantId = assistantId;

						try {
							while (loopIteration < maxIterations) {
								if (abortController.signal.aborted) {
									throw new Error('Agent execution interrupted by the user.');
								}
								loopIteration++;

								const contextText = getWorkspaceContextText();
								let apiMessages: Message[];

								if (useTools) {
									apiMessages = generatingSession.toApiMessages();
									// Remove the generating assistant message if it's at the end
									if (apiMessages[apiMessages.length - 1]?.role === 'assistant' && !apiMessages[apiMessages.length - 1].content && !apiMessages[apiMessages.length - 1].tool_calls) {
										apiMessages.pop();
									}

									// Extract and remove the first system message if it exists to create a single unified system prompt
									let expertSystemPrompt = '';
									if (apiMessages[0]?.role === 'system') {
										expertSystemPrompt = apiMessages[0].content;
										apiMessages.shift();
									}

									const systemPromptParts = [];
									if (expertSystemPrompt) {
										systemPromptParts.push(expertSystemPrompt);
									}

									const osPlatform = os.platform();
									const osHome = os.homedir();
									const shellType = osPlatform === 'win32' ? 'Windows (CMD/PowerShell)' : 'Unix/Linux (bash/zsh)';
									const pathSeparator = osPlatform === 'win32' ? '\\' : '/';
									const envContext = `[Environment Context]
- Operating System: ${osPlatform}
- User Home Directory: ${osHome}
- Path Separator: '${pathSeparator}'
- Shell Syntax: Always use commands, tools, and path syntax compatible with ${shellType}.`;

									systemPromptParts.push(envContext);
									systemPromptParts.push(TOOLS_INSTRUCTION);
									if (contextText) {
										systemPromptParts.push(`[Current Workspace Context]\n${contextText}`);
									}

									apiMessages.unshift({
										role: 'system',
										content: systemPromptParts.join('\n\n')
									});
								} else {
									const expert = getExpertProfile(generatingSession.expertId);
									const systemPrompt = expert?.systemPrompt || 'You are ModelPilot, a helpful AI assistant.';
									apiMessages = [
										{ role: 'system', content: systemPrompt },
										...generatingSession.getMessages()
											.filter(m => m.role !== 'tool')
											.filter((m, idx, arr) => !(m.role === 'assistant' && !m.content && idx === arr.length - 1))
											.map(m => {
												const msg: Message = { role: m.role, content: m.content };
												if (m.name !== undefined) { msg.name = m.name; }
												return msg;
											})
									];
								}

								const chatResult = await router.route(
									recs,
									apiMessages,
									useTools ? AGENT_TOOLS_METADATA : undefined,
									{
										stream: getConfig().stream,
										onChunk: (text) => {
											assistantMessage.content += text;
											this.syncSession(generatingSession);
											this._view?.webview.postMessage({ type: 'chunk', id: activeAssistantId, text, sessionId });
										},
										maxTokens: 2048,
										abortSignal: abortController.signal,
										timeout: useTools ? 30000 : 10000,
									},
									(from, to, reason) => {
										this._view?.webview.postMessage({ type: 'fallback', from, to, reason, sessionId });
									}
								);

								const assistantText = chatResult.content;
								const parsedCalls = parseTextToolCalls(assistantText);
								const toolCalls = [
									...(chatResult.toolCalls || []),
									...parsedCalls
								];

								// Update final content and tool calls if any
								assistantMessage.content = assistantText;
								if (toolCalls.length > 0) {
									assistantMessage.tool_calls = toolCalls;
								}
								this.syncSession(generatingSession);

								if (toolCalls.length === 0) {
									this._view?.webview.postMessage({
										type: 'messageComplete',
										id: activeAssistantId,
										model: lastModel.displayName,
										provider: lastModel.provider,
										sessionId
									});
									break;
								}

								for (const tc of toolCalls) {
									const toolId = tc.id;
									const toolName = tc.function.name;
									let toolArgs: any = {};
									try {
										toolArgs = JSON.parse(cleanJsonString(tc.function.arguments));
									} catch (err) {
										const errMsg = `Error parsing tool arguments: ${err instanceof Error ? err.message : String(err)}`;
										generatingSession.addMessage('tool', errMsg, undefined, undefined, toolName, toolId);
										this.syncSession(generatingSession);
										continue;
									}

									const needsApproval = AgentExecutor.requiresApproval(toolName);
									let approved = true;

									if (toolName === 'read_file' && this.autoApproveReads) {
										approved = true;
									} else if (needsApproval) {
										let diff: { oldContent: string; newContent: string } | undefined;
										if (toolName === 'write_file') {
											try {
												const filePath = getWorkspacePath(toolArgs.path);
												const oldContent = await fs.promises.readFile(filePath, 'utf8');
												diff = { oldContent, newContent: toolArgs.content };
											} catch {
												diff = { oldContent: '', newContent: toolArgs.content };
											}
										} else if (toolName === 'create_file') {
											diff = { oldContent: '', newContent: toolArgs.content };
										}

										const isOutOfWorkspace = toolName === 'run_terminal_command' && checkIfCommandIsOutOfWorkspace(toolArgs.command);
										this._view?.webview.postMessage({
											type: 'toolConfirm',
											id: toolId,
											name: toolName,
											args: toolArgs,
											diff,
											sessionId,
											isOutOfWorkspace
										});

										approved = await new Promise<boolean>((resolve) => {
											this.pendingApprovals.set(toolId, { resolve, toolName });
										});
									} else {
										this._view?.webview.postMessage({
											type: 'toolStart',
											id: toolId,
											name: toolName,
											args: toolArgs,
											sessionId
										});
									}

									let result = '';
									let success = false;
									let status: 'completed' | 'failed' | 'rejected' = 'completed';

									if (approved) {
										try {
											result = await AgentExecutor.execute(toolName, toolArgs, abortController.signal);
											success = true;
											status = 'completed';
										} catch (err) {
											result = err instanceof Error ? err.message : String(err);
											success = false;
											status = 'failed';
										}
									} else {
										result = 'Tool execution rejected by user.';
										success = false;
										status = 'rejected';
									}

									this._view?.webview.postMessage({
										type: 'toolEnd',
										id: toolId,
										name: toolName,
										success,
										result,
										status,
										sessionId
									});

									generatingSession.addMessage('tool', result, undefined, undefined, toolName, toolId);
									this.syncSession(generatingSession);

									if (abortController.signal.aborted) {
										throw new Error('Agent execution interrupted by the user.');
									}
								}

								// Prepare next iteration's assistant state
								activeAssistantId = crypto.randomBytes(8).toString('hex');
								assistantMessage = generatingSession.addMessage(
									'assistant',
									'',
									lastModel.id,
									lastModel.provider
								);
								this._view?.webview.postMessage({ type: 'thinking', id: activeAssistantId, sessionId });
							}

							if (loopIteration >= maxIterations) {
								throw new Error('Maximum agent loop iterations reached.');
							}

						} catch (err) {
							if (err instanceof Error && (err.name === 'AbortError' || err.message === 'Agent execution interrupted by the user.') || abortController.signal.aborted) {
								this._view?.webview.postMessage({ type: 'messageError', id: activeAssistantId, error: 'Agent execution interrupted by the user.', sessionId });
							} else {
								const error = err instanceof Error ? err.message : String(err);
								this._view?.webview.postMessage({ type: 'messageError', id: activeAssistantId, error, sessionId });
							}
						} finally {
							this.activeAbortControllers.delete(sessionId);
						}
					})();

					break;
				}
			}
		});
	}

	postMessage(msg: object) {
		this._view?.webview.postMessage(msg);
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('hex');
		const htmlPath = path.join(this.extensionPath, 'src', 'webview', 'panel.html');
		const jsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
		);
		return fs.readFileSync(htmlPath, 'utf8')
			.replaceAll('{{NONCE}}', nonce)
			.replace('{{WEBVIEW_JS}}', jsUri.toString());
	}
}

export function activate(context: vscode.ExtensionContext) {
	const sm = new SecretsManager(context.secrets);
	const registry = new ModelRegistry();

	const provider = new ModelPilotViewProvider(
		context.extensionUri,
		context.extensionPath,
		registry,
		sm,
		context,
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('modelpilot.chatView', provider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	async function refreshModels() {
		const keys = await sm.getAll();
		const providers = [
			new NvidiaProvider(keys.nvidia),
			new OpenRouterProvider(keys.openrouter),
			new GroqProvider(keys.groq),
		];
		await registry.refresh(providers);
		const count = registry.getAvailable().length;
		provider.postMessage({ type: 'modelsRefreshed', count });
		return count;
	}

	refreshModels();

	context.subscriptions.push(

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

		vscode.commands.registerCommand('modelpilot.newChat', () => {
			provider.resetSession();
			vscode.commands.executeCommand('modelpilot.chatView.focus');
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
			// Select expert from command palette will be bridged to the UI
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

			provider.postMessage({ type: 'setExpert', expertId: picked.id });
			vscode.commands.executeCommand('modelpilot.chatView.focus');
		}),
	);
}

export function deactivate() { }
