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

	setup(() => {
		originalSpawn = McpServerConnection.spawn;
		mockProcess = new MockChildProcess();
		McpServerConnection.spawn = (command: string, args: string[], options: any) => {
			return mockProcess as any;
		};
	});

	teardown(() => {
		McpServerConnection.spawn = originalSpawn;
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
});
