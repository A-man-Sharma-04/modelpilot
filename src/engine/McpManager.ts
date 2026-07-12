import * as childProcess from 'child_process';
import * as vscode from 'vscode';
import { Tool } from '../providers/IProvider';

interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export class McpServerConnection {
	private child: childProcess.ChildProcess | null = null;
	private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
	private requestIdCounter = 1;
	private buffer = '';
	private initializedPromise: Promise<Tool[]> | null = null;

	constructor(
		public readonly name: string,
		private readonly config: McpServerConfig
	) {}

	async initialize(): Promise<Tool[]> {
		if (this.initializedPromise) {
			return this.initializedPromise;
		}
		this.initializedPromise = this.startAndHandshake();
		return this.initializedPromise;
	}

	private async startAndHandshake(): Promise<Tool[]> {
		const env = { ...process.env, ...(this.config.env || {}) };
		const args = this.config.args || [];
		
		try {
			this.child = McpServerConnection.spawn(this.config.command, args, {
				env,
				shell: true,
			});
		} catch (err: any) {
			throw new Error(`Failed to spawn MCP server "${this.name}": ${err.message}`);
		}

		this.child.stderr?.on('data', (data: any) => {
			console.warn(`[MCP Server: ${this.name} STDERR] ${data.toString().trim()}`);
		});

		this.child.stdout?.on('data', (data: any) => {
			this.buffer += data.toString();
			const lines = this.buffer.split(/\r?\n/);
			this.buffer = lines.pop() ?? '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) { continue; }
				this.handleMessage(trimmed);
			}
		});

		this.child.on('close', (code: any) => {
			console.log(`MCP server "${this.name}" process exited with code ${code}`);
			this.rejectAllPending(new Error(`MCP server subprocess exited with code ${code}`));
			this.child = null;
			this.initializedPromise = null;
		});

		this.child.on('error', (err: any) => {
			console.error(`MCP server "${this.name}" error: ${err.message}`);
			this.rejectAllPending(err);
		});

		// 1. Send initialize request
		const initRes = await this.sendRequest('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'ModelPilot', version: '1.0.0' }
		});

		// 2. Send initialized notification
		this.sendNotification('notifications/initialized');

		// 3. List tools
		const listRes = await this.sendRequest('tools/list', {});
		const rawTools = (listRes.tools || []) as { name: string; description?: string; inputSchema?: any }[];

		// Map tools with prefix namespace to prevent collisions
		const mappedTools: Tool[] = rawTools.map((t) => ({
			type: 'function' as const,
			function: {
				name: `mcp__${this.name}__${t.name}`,
				description: t.description || `MCP tool from server ${this.name}`,
				parameters: t.inputSchema || { type: 'object', properties: {} }
			}
		}));

		return mappedTools;
	}

	async executeTool(toolName: string, args: any): Promise<string> {
		if (!this.child) {
			throw new Error(`MCP server "${this.name}" is not running.`);
		}
		const res = await this.sendRequest('tools/call', {
			name: toolName,
			arguments: args
		});

		if (res.isError) {
			const errContent = res.content?.map((c: any) => c.text || JSON.stringify(c)).join('\n') || 'Unknown error';
			throw new Error(`MCP tool execution failed: ${errContent}`);
		}

		if (res.content && Array.isArray(res.content)) {
			return res.content.map((c: any) => {
				if (c.type === 'text') { return c.text; }
				if (c.type === 'image') { return `[Image content: ${c.mimeType || 'unknown'}]`; }
				return JSON.stringify(c);
			}).join('\n');
		}

		return JSON.stringify(res);
	}

	sendRequest(method: string, params: any): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.child || !this.child.stdin) {
				return reject(new Error(`MCP server "${this.name}" is not running/stdin unavailable.`));
			}

			const id = this.requestIdCounter++;
			const message = {
				jsonrpc: '2.0',
				id,
				method,
				params
			};

			this.pendingRequests.set(id, { resolve, reject });
			this.child.stdin.write(JSON.stringify(message) + '\n');
		});
	}

	sendNotification(method: string, params?: any): void {
		if (!this.child || !this.child.stdin) { return; }
		const message = {
			jsonrpc: '2.0',
			method,
			params
		};
		this.child.stdin.write(JSON.stringify(message) + '\n');
	}

	private handleMessage(line: string): void {
		try {
			const parsed = JSON.parse(line);
			if (parsed.jsonrpc === '2.0' && parsed.id !== undefined) {
				const pending = this.pendingRequests.get(parsed.id);
				if (pending) {
					this.pendingRequests.delete(parsed.id);
					if (parsed.error) {
						pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
					} else {
						pending.resolve(parsed.result);
					}
				}
			}
		} catch (err) {
			console.error(`[MCP Message Parsing Error] line: "${line}", error: ${err}`);
		}
	}

	private rejectAllPending(err: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(err);
		}
		this.pendingRequests.clear();
	}

	dispose(): void {
		if (this.child) {
			try {
				if (process.platform === 'win32') {
					this.child.kill();
				} else {
					// Send SIGKILL or close stdin/stdout
					this.child.kill('SIGKILL');
				}
			} catch {}
			this.child = null;
		}
		this.rejectAllPending(new Error('Connection disposed.'));
		this.initializedPromise = null;
	}

	public static spawn(command: string, args: string[], options: any): childProcess.ChildProcess {
		return childProcess.spawn(command, args, options);
	}
}

export class McpManager {
	private connections = new Map<string, McpServerConnection>();
	private toolsList: Tool[] = [];
	private initialized = false;

	async initializeFromConfig(): Promise<void> {
		this.dispose();

		const config = vscode.workspace.getConfiguration('modelpilot');
		const mcpServers = config.get<Record<string, McpServerConfig>>('mcpServers', {});

		const tools: Tool[] = [];
		const initPromises: Promise<Tool[]>[] = [];

		for (const [name, serverConfig] of Object.entries(mcpServers)) {
			if (!serverConfig || !serverConfig.command) { continue; }
			const connection = new McpServerConnection(name, serverConfig);
			this.connections.set(name, connection);

			const p = connection.initialize().catch((err) => {
				console.error(`Failed to initialize MCP server "${name}":`, err);
				vscode.window.showWarningMessage(`ModelPilot: Failed to initialize MCP server "${name}": ${err.message}`);
				return [] as Tool[];
			});
			initPromises.push(p);
		}

		const results = await Promise.all(initPromises);
		for (const r of results) {
			tools.push(...r);
		}

		this.toolsList = tools;
		this.initialized = true;
		console.log(`ModelPilot: Initialized MCP Manager. Loaded ${tools.length} MCP tools.`);
	}

	getTools(): Tool[] {
		return this.toolsList;
	}

	async execute(prefixedToolName: string, args: any): Promise<string> {
		const match = prefixedToolName.match(/^mcp__([a-zA-Z0-9_\-]+)__(.+)$/);
		if (!match) {
			throw new Error(`Invalid MCP tool name format: "${prefixedToolName}"`);
		}
		const serverName = match[1];
		const originalToolName = match[2];

		const connection = this.connections.get(serverName);
		if (!connection) {
			throw new Error(`MCP server "${serverName}" is not configured or running.`);
		}

		return await connection.executeTool(originalToolName, args);
	}

	dispose(): void {
		for (const conn of this.connections.values()) {
			conn.dispose();
		}
		this.connections.clear();
		this.toolsList = [];
		this.initialized = false;
	}
}

export const mcpManager = new McpManager();
