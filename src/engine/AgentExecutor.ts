import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as os from 'os';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('ModelPilot Task Runner');
	}
	return outputChannel;
}

export function getWorkspaceRoot(): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (root) {
		return root;
	}
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor && activeEditor.document.uri.scheme === 'file') {
		return path.dirname(activeEditor.document.uri.fsPath);
	}
	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.uri.scheme === 'file') {
			return path.dirname(editor.document.uri.fsPath);
		}
	}
	return os.homedir();
}

export function getWorkspacePath(relPath: string, agentCwd: string = '.'): string {
	const root = getWorkspaceRoot();
	let resolved: string;
	if (path.isAbsolute(relPath)) {
		resolved = path.resolve(relPath);
	} else {
		resolved = path.resolve(root, agentCwd, relPath);
	}
	const isInside = resolved === root || resolved.startsWith(root + path.sep);
	if (!isInside) {
		throw new Error(`Access Denied: Path "${relPath}" resolves to "${resolved}" which is outside the workspace root.`);
	}
	return resolved;
}

export const AGENT_TOOLS_METADATA = [
	{
		type: 'function' as const,
		function: {
			name: 'read_file',
			description: 'Read the contents of a file in the workspace.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path of the file to read.' },
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'write_file',
			description: 'Overwrite or update an existing file with new content. Shows a diff to the user for confirmation.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path of the file to write.' },
					content: { type: 'string', description: 'The full new content for the file.' },
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'create_file',
			description: 'Create a new file with content. Requires user approval.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path of the file to create.' },
					content: { type: 'string', description: 'The content of the file.' },
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'delete_file',
			description: 'Delete a file from the workspace. Requires user approval.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path of the file to delete.' },
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'search_workspace',
			description: 'Search the workspace files for a specific query string (grep).',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'The text query or symbol to search for.' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'list_directory',
			description: 'List the contents of a directory in the workspace.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path of the directory.' },
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'get_open_files',
			description: 'List the currently open files in the editor tabs.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'run_terminal_command',
			description: 'Execute a terminal command in the workspace folder. Requires user approval.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'The shell command to execute.' },
				},
				required: ['command'],
			},
		},
	},
];

export class AgentExecutor {
	static requiresApproval(toolName: string): boolean {
		return ['read_file', 'write_file', 'create_file', 'delete_file', 'run_terminal_command'].includes(toolName);
	}

	static async execute(toolName: string, args: any, agentCwd: string, abortSignal?: AbortSignal): Promise<{ result: string; newCwd?: string }> {
		if (!args || typeof args !== 'object') {
			throw new Error(`Invalid arguments format: Expected a key-value object.`);
		}

		switch (toolName) {
			case 'read_file':
				if (typeof args.path !== 'string' || !args.path) {
					throw new Error(`Missing or invalid required argument: 'path' must be a non-empty string.`);
				}
				return { result: await this.readFile(args.path, agentCwd) };
			case 'write_file':
				if (typeof args.path !== 'string' || !args.path) {
					throw new Error(`Missing or invalid required argument: 'path' must be a non-empty string.`);
				}
				if (typeof args.content !== 'string') {
					throw new Error(`Missing or invalid required argument: 'content' must be a string.`);
				}
				return { result: await this.writeFile(args.path, args.content, agentCwd) };
			case 'create_file':
				if (typeof args.path !== 'string' || !args.path) {
					throw new Error(`Missing or invalid required argument: 'path' must be a non-empty string.`);
				}
				if (typeof args.content !== 'string') {
					throw new Error(`Missing or invalid required argument: 'content' must be a string.`);
				}
				return { result: await this.createFile(args.path, args.content, agentCwd) };
			case 'delete_file':
				if (typeof args.path !== 'string' || !args.path) {
					throw new Error(`Missing or invalid required argument: 'path' must be a non-empty string.`);
				}
				return { result: await this.deleteFile(args.path, agentCwd) };
			case 'search_workspace':
				if (typeof args.query !== 'string') {
					throw new Error(`Missing or invalid required argument: 'query' must be a string.`);
				}
				return { result: await this.searchWorkspace(args.query, agentCwd) };
			case 'list_directory':
				if (args.path !== undefined && typeof args.path !== 'string') {
					throw new Error(`Invalid argument: 'path' must be a string.`);
				}
				return { result: await this.listDirectory(args.path, agentCwd) };
			case 'get_open_files':
				return { result: this.getOpenFiles() };
			case 'run_terminal_command':
				if (typeof args.command !== 'string' || !args.command) {
					throw new Error(`Missing or invalid required argument: 'command' must be a non-empty string.`);
				}
				return await this.runTerminalCommand(args.command, agentCwd, abortSignal);
			default:
				throw new Error(`Unknown tool: ${toolName}`);
		}
	}

	private static async readFile(relPath: string, agentCwd: string): Promise<string> {
		const p = getWorkspacePath(relPath, agentCwd);
		const content = await fs.promises.readFile(p, 'utf8');
		const maxChars = 10000;
		if (content.length > maxChars) {
			const head = content.slice(0, 5000);
			const tail = content.slice(-5000);
			return `${head}\n\n[NOTE: File content truncated for length. Showing first 5000 and last 5000 characters out of ${content.length} total.]\n\n${tail}`;
		}
		return content;
	}

	private static async writeFile(relPath: string, content: string, agentCwd: string): Promise<string> {
		const p = getWorkspacePath(relPath, agentCwd);
		await fs.promises.writeFile(p, content, 'utf8');
		try {
			const doc = await vscode.workspace.openTextDocument(p);
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch {
			// Ignore editor opening errors in headless test environments
		}
		return `File "${relPath}" updated successfully.`;
	}

	private static async createFile(relPath: string, content: string, agentCwd: string): Promise<string> {
		const p = getWorkspacePath(relPath, agentCwd);
		const dir = path.dirname(p);
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(p, content, 'utf8');
		try {
			const doc = await vscode.workspace.openTextDocument(p);
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch {
			// Ignore editor opening errors in headless test environments
		}
		return `File "${relPath}" created successfully.`;
	}

	private static async deleteFile(relPath: string, agentCwd: string): Promise<string> {
		const p = getWorkspacePath(relPath, agentCwd);
		await fs.promises.unlink(p);
		return `File "${relPath}" deleted successfully.`;
	}

	private static async searchWorkspace(query: string, agentCwd: string): Promise<string> {
		const root = getWorkspaceRoot();
		const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
		const results: string[] = [];

		const batchSize = 30;
		for (let i = 0; i < files.length; i += batchSize) {
			const batch = files.slice(i, i + batchSize);
			await Promise.all(batch.map(async (file) => {
				const relPath = path.relative(root, file.fsPath);
				try {
					const content = await fs.promises.readFile(file.fsPath, 'utf8');
					if (content.toLowerCase().includes(query.toLowerCase())) {
						const lines = content.split('\n');
						lines.forEach((line, idx) => {
							if (line.toLowerCase().includes(query.toLowerCase())) {
								results.push(`${relPath}:${idx + 1}: ${line.trim().slice(0, 120)}`);
							}
						});
					}
				} catch {
					// Skip binary files
				}
			}));

			if (results.length >= 50) {
				break;
			}
		}

		if (results.length > 50) {
			const sliced = results.slice(0, 50);
			sliced.push('... showing first 50 results.');
			return sliced.join('\n');
		}

		return results.length > 0 ? results.join('\n') : 'No matching query results found.';
	}

	private static async listDirectory(relPath: string, agentCwd: string): Promise<string> {
		const p = getWorkspacePath(relPath || '.', agentCwd);
		const entries = await fs.promises.readdir(p, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		let results = entries.map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`);
		const maxEntries = 100;
		if (results.length > maxEntries) {
			const total = results.length;
			results = results.slice(0, maxEntries);
			results.push(`\n[NOTE: Directory listing truncated. Showing first ${maxEntries} of ${total} entries. Use more specific paths or subdirectories to explore further.]`);
		}
		return results.length > 0 ? results.join('\n') : 'Directory is empty.';
	}

	private static getOpenFiles(): string {
		const root = getWorkspaceRoot();
		const documents = vscode.window.visibleTextEditors.map(e => {
			const fsPath = e.document.uri.fsPath;
			return path.relative(root, fsPath);
		});
		const unique = Array.from(new Set(documents));
		return unique.length > 0 ? unique.join('\n') : 'No active text files open in editor.';
	}

	private static async runTerminalCommand(command: string, agentCwd: string, abortSignal?: AbortSignal): Promise<{ result: string; newCwd?: string }> {
		let root: string;
		try {
			root = getWorkspaceRoot();
		} catch {
			root = os.homedir();
		}

		let commandCwd = root;
		try {
			const resolved = path.resolve(root, agentCwd);
			if (resolved === root || resolved.startsWith(root + path.sep)) {
				commandCwd = resolved;
			}
		} catch {
			// fallback to root
		}

		const channel = getOutputChannel();
		channel.clear();
		channel.show(true);

		channel.appendLine(`Running: $ ${command}\n`);

		return new Promise((resolve) => {
			if (abortSignal?.aborted) {
				return resolve({ result: 'Command cancelled by user.' });
			}

			const isWin = os.platform() === 'win32';
			const suffix = isWin ? ' & echo MODELPILOT_PWD:%CD%' : ' ; echo "MODELPILOT_PWD:$(pwd)"';
			const fullCommand = command + suffix;

			const proc = spawn(fullCommand, {
				shell: true,
				cwd: commandCwd,
				detached: true,
			});

			proc.stdin?.end();

			let output = '';

			const abortListener = () => {
				try {
					if (proc.pid !== undefined) {
						process.kill(-proc.pid, 'SIGKILL');
					} else {
						proc.kill();
					}
				} catch {
					proc.kill();
				}
				resolve({ result: 'Command cancelled by user.' });
			};
			abortSignal?.addEventListener('abort', abortListener);

			const appendToOutput = (data: Buffer) => {
				const text = data.toString();
				output += text;

				if (text.includes('MODELPILOT_PWD:')) {
					const lines = text.split('\n');
					for (const line of lines) {
						if (!line.includes('MODELPILOT_PWD:')) {
							channel.append(line + (lines.length > 1 ? '\n' : ''));
						}
					}
				} else {
					channel.append(text);
				}
			};

			proc.stdout.on('data', appendToOutput);
			proc.stderr.on('data', appendToOutput);

			proc.on('close', (code) => {
				if (abortSignal) {
					abortSignal.removeEventListener('abort', abortListener);
				}
				channel.appendLine(`\nProcess exited with code ${code}`);

				let finalPwd = '';
				const pwdMatch = output.match(/MODELPILOT_PWD:([^\r\n]+)/);
				if (pwdMatch) {
					finalPwd = pwdMatch[1].trim();
					output = output.replace(/MODELPILOT_PWD:[^\r\n]*\r?\n?/g, '');
				}

				let newCwd: string | undefined;
				if (finalPwd) {
					try {
						const rel = path.relative(root, finalPwd);
						if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
							newCwd = rel || '.';
						}
					} catch {
						// ignore
					}
				}

				const maxChars = 10000;
				let finalOutput = output;
				if (finalOutput.length > maxChars) {
					const head = finalOutput.slice(0, 2000);
					const tail = finalOutput.slice(-8000);
					finalOutput = `${head}\n\n[NOTE: Command output truncated for length. Showing first 2000 and last 8000 characters out of ${finalOutput.length} total.]\n\n${tail}`;
				}
				const exitInfo = `\n[Exit code: ${code}]`;
				const resultStr = finalOutput
					? finalOutput + exitInfo
					: (code === 0 ? '[Command executed successfully with no output. Exit code: 0]' : `[Command exited with code ${code} and no output]`);
				resolve({ result: resultStr, newCwd });
			});

			proc.on('error', (err) => {
				if (abortSignal) {
					abortSignal.removeEventListener('abort', abortListener);
				}
				channel.appendLine(`\nError: ${err.message}`);
				resolve({ result: `Failed to start command execution: ${err.message}` });
			});
		});
	}
}
