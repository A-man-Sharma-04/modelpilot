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

export function getWorkspacePath(relPath: string): string {
	const root = getWorkspaceRoot();
	const resolved = path.resolve(root, relPath);
	if (!resolved.startsWith(root)) {
		throw new Error(`Access Denied: Path "${relPath}" is outside the workspace root.`);
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

	static async execute(toolName: string, args: any, abortSignal?: AbortSignal): Promise<string> {
		switch (toolName) {
			case 'read_file':
				return await this.readFile(args.path);
			case 'write_file':
				return await this.writeFile(args.path, args.content);
			case 'create_file':
				return await this.createFile(args.path, args.content);
			case 'delete_file':
				return await this.deleteFile(args.path);
			case 'search_workspace':
				return await this.searchWorkspace(args.query);
			case 'list_directory':
				return await this.listDirectory(args.path);
			case 'get_open_files':
				return this.getOpenFiles();
			case 'run_terminal_command':
				return await this.runTerminalCommand(args.command, abortSignal);
			default:
				throw new Error(`Unknown tool: ${toolName}`);
		}
	}

	private static async readFile(relPath: string): Promise<string> {
		const p = getWorkspacePath(relPath);
		const content = await fs.promises.readFile(p, 'utf8');
		const maxChars = 10000;
		if (content.length > maxChars) {
			return `${content.slice(0, maxChars)}\n\n[NOTE: File content truncated for length. Only first ${maxChars} characters shown out of ${content.length}.]`;
		}
		return content;
	}

	private static async writeFile(relPath: string, content: string): Promise<string> {
		const p = getWorkspacePath(relPath);
		await fs.promises.writeFile(p, content, 'utf8');
		return `File "${relPath}" updated successfully.`;
	}

	private static async createFile(relPath: string, content: string): Promise<string> {
		const p = getWorkspacePath(relPath);
		const dir = path.dirname(p);
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(p, content, 'utf8');
		return `File "${relPath}" created successfully.`;
	}

	private static async deleteFile(relPath: string): Promise<string> {
		const p = getWorkspacePath(relPath);
		await fs.promises.unlink(p);
		return `File "${relPath}" deleted successfully.`;
	}

	private static async searchWorkspace(query: string): Promise<string> {
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

	private static async listDirectory(relPath: string): Promise<string> {
		const p = getWorkspacePath(relPath || '.');
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

	private static async runTerminalCommand(command: string, abortSignal?: AbortSignal): Promise<string> {
		let root: string;
		try {
			root = getWorkspaceRoot();
		} catch {
			root = os.homedir();
		}
		const channel = getOutputChannel();
		channel.clear();
		channel.show(true);

		channel.appendLine(`Running: $ ${command}\n`);

		return new Promise((resolve) => {
			if (abortSignal?.aborted) {
				return resolve('Command cancelled by user.');
			}

			const proc = spawn(command, {
				shell: true,
				cwd: root,
				detached: true,
			});

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
				resolve('Command cancelled by user.');
			};
			abortSignal?.addEventListener('abort', abortListener);

			proc.stdout.on('data', (data) => {
				const text = data.toString();
				output += text;
				channel.append(text);
			});

			proc.stderr.on('data', (data) => {
				const text = data.toString();
				output += text;
				channel.append(text);
			});

			proc.on('close', (code) => {
				if (abortSignal) {
					abortSignal.removeEventListener('abort', abortListener);
				}
				channel.appendLine(`\nProcess exited with code ${code}`);
				const maxChars = 10000;
				let finalOutput = output;
				if (finalOutput.length > maxChars) {
					finalOutput = `[NOTE: Command output truncated for length. Showing last ${maxChars} characters of ${finalOutput.length} total.]\n\n... (truncated) ...\n\n${finalOutput.slice(-maxChars)}`;
				}
				resolve(finalOutput || `Process finished with exit code ${code}`);
			});

			proc.on('error', (err) => {
				if (abortSignal) {
					abortSignal.removeEventListener('abort', abortListener);
				}
				channel.appendLine(`\nError: ${err.message}`);
				resolve(`Failed to start command execution: ${err.message}`);
			});
		});
	}
}
