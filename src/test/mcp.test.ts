import * as assert from 'assert';
import { EventEmitter } from 'events';
import { McpServerConnection, mcpManager } from '../engine/McpManager';
import * as vscode from 'vscode';

class MockChildProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = {
		write: (data: string) => {
			process.nextTick(() => this.handleInput(data));
		}
	};
	pid = 9999;

	handleInput(data: string) {
		try {
			const parsed = JSON.parse(data.trim());
			if (parsed.method === 'initialize') {
				this.stdout.emit('data', JSON.stringify({
					jsonrpc: '2.0',
					id: parsed.id,
					result: {
						protocolVersion: '2024-11-05',
						capabilities: {},
						serverInfo: { name: 'MockServer', version: '1.0.0' }
					}
				}) + '\n');
			} else if (parsed.method === 'tools/list') {
				this.stdout.emit('data', JSON.stringify({
					jsonrpc: '2.0',
					id: parsed.id,
					result: {
						tools: [
							{ name: 'get_weather', description: 'Get weather forecast', inputSchema: { type: 'object', properties: {} } }
						]
					}
				}) + '\n');
			} else if (parsed.method === 'tools/call') {
				this.stdout.emit('data', JSON.stringify({
					jsonrpc: '2.0',
					id: parsed.id,
					result: {
						content: [{ type: 'text', text: 'Sunny, 72F' }],
						isError: false
					}
				}) + '\n');
			}
		} catch (err) {
			// ignore malformed JSON in mock
		}
	}

	kill(signal?: string) {
		process.nextTick(() => {
			this.emit('close', 0);
		});
		return true;
	}
}

suite('ModelPilot MCP Integration Tests', () => {
	let originalSpawn: any;
	let mockProcess: MockChildProcess;
	const childProcessModule = require('child_process');

	setup(() => {
		originalSpawn = childProcessModule.spawn;
		mockProcess = new MockChildProcess();
		childProcessModule.spawn = (command: string, args: string[], options: any) => {
			return mockProcess as any;
		};
	});

	teardown(() => {
		childProcessModule.spawn = originalSpawn;
	});

	test('McpServerConnection handshake and tool listing', async () => {
		const conn = new McpServerConnection('weather', { command: 'node', args: [] });
		const tools = await conn.initialize();

		assert.strictEqual(tools.length, 1);
		assert.strictEqual(tools[0].function.name, 'mcp__weather__get_weather');
		assert.strictEqual(tools[0].function.description, 'Get weather forecast');

		conn.dispose();
	});

	test('McpServerConnection tool execution', async () => {
		const conn = new McpServerConnection('weather', { command: 'node', args: [] });
		await conn.initialize();

		const result = await conn.executeTool('get_weather', { location: 'San Francisco' });
		assert.strictEqual(result, 'Sunny, 72F');

		conn.dispose();
	});

	test('McpManager initialized tools aggregation and execution routing', async () => {
		const originalGet = vscode.workspace.getConfiguration;
		(vscode.workspace as any).getConfiguration = (section?: string) => {
			return {
				get: (key: string, defaultValue?: any) => {
					if (key === 'mcpServers') {
						return {
							weather: { command: 'node', args: [] }
						};
					}
					return defaultValue;
				}
			} as any;
		};

		try {
			await mcpManager.initializeFromConfig();
			const tools = mcpManager.getTools();
			assert.strictEqual(tools.length, 1);
			assert.strictEqual(tools[0].function.name, 'mcp__weather__get_weather');

			const result = await mcpManager.execute('mcp__weather__get_weather', { location: 'San Francisco' });
			assert.strictEqual(result, 'Sunny, 72F');
		} finally {
			mcpManager.dispose();
			vscode.workspace.getConfiguration = originalGet;
		}
	});

	test('configureMcpServer command configuration flow', async () => {
		const originalQuickPick = vscode.window.showQuickPick;
		const originalInputBox = vscode.window.showInputBox;
		const originalProgress = vscode.window.withProgress;
		const originalInfoMessage = vscode.window.showInformationMessage;
		const originalGetConfig = vscode.workspace.getConfiguration;

		let updatedConfigValue: any = null;
		let infoMessageText = '';

		const mockMcpServers: Record<string, any> = {};

		// Mock VS Code settings update
		(vscode.workspace as any).getConfiguration = (section?: string) => {
			return {
				get: (key: string, defaultValue?: any) => {
					if (key === 'mcpServers') { return mockMcpServers; }
					return defaultValue;
				},
				update: async (key: string, value: any, target: any) => {
					if (key === 'mcpServers') {
						updatedConfigValue = value;
					}
				}
			} as any;
		};

		// Mock inputs
		let quickPickStep = 0;
		(vscode.window as any).showQuickPick = async (items: any[], options?: any) => {
			quickPickStep++;
			if (quickPickStep === 1) {
				// Select "Add/Edit MCP Server"
				return items.find(i => i.value === 'add');
			}
			return null;
		};

		let inputBoxStep = 0;
		(vscode.window as any).showInputBox = async (options?: any) => {
			inputBoxStep++;
			if (inputBoxStep === 1) {
				// Server name
				return 'weather-test';
			} else if (inputBoxStep === 2) {
				// Command
				return 'node';
			} else if (inputBoxStep === 3) {
				// Args
				return 'path/to/server.js';
			} else if (inputBoxStep === 4) {
				// Env
				return 'API_KEY=testkey';
			}
			return '';
		};

		(vscode.window as any).showInformationMessage = async (message: string, ...items: any[]) => {
			infoMessageText = message;
			return undefined as any;
		};

		(vscode.window as any).withProgress = async (options: any, task: (progress: any, token: any) => Thenable<any>) => {
			return task({ report: () => {} }, null);
		};

		try {
			await vscode.commands.executeCommand('modelpilot.configureMcpServer');

			// Asserts
			assert.ok(updatedConfigValue);
			assert.ok(updatedConfigValue['weather-test']);
			assert.strictEqual(updatedConfigValue['weather-test'].command, 'node');
			assert.deepStrictEqual(updatedConfigValue['weather-test'].args, ['path/to/server.js']);
			assert.deepStrictEqual(updatedConfigValue['weather-test'].env, { API_KEY: 'testkey' });
			assert.ok(infoMessageText.includes('weather-test'));
			assert.ok(infoMessageText.includes('validated and saved successfully'));
		} finally {
			vscode.window.showQuickPick = originalQuickPick;
			vscode.window.showInputBox = originalInputBox;
			vscode.window.withProgress = originalProgress;
			vscode.window.showInformationMessage = originalInfoMessage;
			vscode.workspace.getConfiguration = originalGetConfig;
		}
	});
});
