import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleChatRequest } from '../extension';
import { ModelRegistry } from '../registry/ModelRegistry';
import { Router } from '../engine/Router';
import { SecretsManager } from '../secrets';
import { healthMonitor } from '../engine/HealthMonitor';
import { getWorkspaceRoot, AgentExecutor } from '../engine/AgentExecutor';
import { OpenAICompatibleProvider } from '../providers/OpenAICompatibleProvider';

suite('ModelPilot Chat Participant Integration Tests', () => {
	let originalRoute: any;
	let originalShowWarningMessage: any;
	let registry: ModelRegistry;
	let mockSm: any;
	let config: any;

	suiteSetup(() => {
		originalRoute = Router.prototype.route;
		originalShowWarningMessage = vscode.window.showWarningMessage;

		// Configure mock secrets manager
		mockSm = {
			getAll: async () => ({ nvidia: 'key1', openrouter: 'key2', groq: 'key3' }),
			get: async () => ['key1'],
		};

		// Configure mock registry
		registry = new ModelRegistry();
		registry.getAvailable = () => [
			{
				id: 'fast-model',
				provider: 'groq',
				displayName: 'Fast Model',
				contextLength: 32000,
				capabilities: { coding: 3, reasoning: 3, writing: 3, learning: 3, security: 3, speed: 9 },
				description: 'Mock fast model',
				lastVerified: '2026-06-11',
				available: true
			},
			{
				id: 'coding-model',
				provider: 'nvidia',
				displayName: 'Coding Expert Model',
				contextLength: 32000,
				capabilities: { coding: 9, reasoning: 8, writing: 3, learning: 5, security: 4, speed: 3 },
				description: 'Mock coding model',
				lastVerified: '2026-06-11',
				available: true
			},
			{
				id: 'security-model',
				provider: 'openrouter',
				displayName: 'Security Expert Model',
				contextLength: 32000,
				capabilities: { coding: 6, reasoning: 8, writing: 4, learning: 4, security: 9, speed: 2 },
				description: 'Mock security model',
				lastVerified: '2026-06-11',
				available: true
			}
		];

		config = {
			stream: true,
			defaultExpert: 'coding'
		};
	});

	setup(async () => {
		try {
			await vscode.workspace.getConfiguration('modelpilot').update('approvalMode', undefined, vscode.ConfigurationTarget.Global);
		} catch {}
	});

	suiteTeardown(() => {
		Router.prototype.route = originalRoute;
		vscode.window.showWarningMessage = originalShowWarningMessage;
	});

	test('should successfully route a general greeting chitchat query to speed recommended model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			if (messages[0]?.content?.includes('intent classifier')) {
				return { content: '{"isChitchat": true, "expertId": "general"}' };
			}
			assert.strictEqual(recs[0].model.id, 'fast-model', 'Chitchat queries should route to the fastest model');
			// Verify that system prompt does not contain tools description
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(!systemMsg.content.includes('[TOOL CALLING INSTRUCTIONS]'), 'Greeting should bypass tool calling system prompt');
			
			const content = 'Hello! How can I assist you today?';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return {
				content
			};
		};

		const mockRequest: any = {
			prompt: 'hi there buddy',
			references: []
		};
		const mockContext: any = {
			history: []
		};

		const markdowns: string[] = [];
		const progresses: string[] = [];

		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: (value: string) => {
				progresses.push(value);
				return mockResponseStream;
			}
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.strictEqual(markdowns.length, 1);
		assert.strictEqual(markdowns[0], 'Hello! How can I assist you today?');
	});

	test('should route a coding task to the coding model and handle agent tool confirmations', async () => {
		let turnCount = 0;
		const createdFiles: string[] = [];

		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'coding-model', 'Coding query should route to the coding-expert model');
			
			// Verify that system prompt contains tools instruction
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('[TOOL CALLING INSTRUCTIONS]'), 'Agent queries must include tool calling instructions');

			if (turnCount === 0) {
				turnCount++;
				const content = 'I will create a prime checker utility.';
				if (options?.onChunk) {
					options.onChunk(content);
				}
				return {
					content,
					toolCalls: [
						{
							id: 'call_create_prime',
							type: 'function',
							function: {
								name: 'create_file',
								arguments: JSON.stringify({ path: 'src/prime.ts', content: 'export function isPrime() { return true; }' })
							}
						}
					]
				};
			} else {
				// Second turn, check that the execution result is passed back to model
				const toolResultMsg = messages.find(m => m.role === 'tool');
				assert.ok(toolResultMsg, 'The tool results must be appended back into model history');
				assert.strictEqual(toolResultMsg.tool_call_id, 'call_create_prime');
				assert.ok(toolResultMsg.content.includes('created successfully'), 'Tool response should indicate success');
				
				const content = 'I have successfully created the file prime.ts.';
				if (options?.onChunk) {
					options.onChunk(content);
				}
				return {
					content
				};
			}
		};

		// Mock the window approval dialog to auto-approve
		// @ts-ignore
		vscode.window.showWarningMessage = async (message: string, options: any, ...items: string[]) => {
			assert.ok(message.includes('prime.ts'), 'Warning dialog should correctly list the file path being created');
			return 'Approve';
		};

		const mockRequest: any = {
			prompt: 'write a typescript prime checker utility',
			command: 'coding',
			references: []
		};
		const mockContext: any = {
			history: []
		};

		const markdowns: string[] = [];
		const progresses: string[] = [];

		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: (value: string) => {
				progresses.push(value);
				return mockResponseStream;
			}
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		// Setup clean test folder structure if required
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const targetFile = root ? path.resolve(root, 'src/prime.ts') : undefined;

		try {
			await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				config,
				async () => 3
			);

			assert.strictEqual(markdowns.length, 2, 'Should have streamed responses from both turns');
			assert.ok(markdowns[1].includes('successfully created'), 'Final response should confirm task resolution');

			// Clean up created file if it was actually written
			if (targetFile && fs.existsSync(targetFile)) {
				fs.unlinkSync(targetFile);
			}
		} catch (err) {
			if (targetFile && fs.existsSync(targetFile)) {
				fs.unlinkSync(targetFile);
			}
			throw err;
		}
	});

	test('should handle tool rejection and pass rejection response to the model', async () => {
		let turnCount = 0;

		Router.prototype.route = async (recs, messages, tools, options) => {
			if (messages[0]?.content?.includes('intent classifier')) {
				return { content: '{"isChitchat": false, "expertId": "coding"}' };
			}
			if (turnCount === 0) {
				turnCount++;
				const content = 'I want to check directories.';
				if (options?.onChunk) {
					options.onChunk(content);
				}
				return {
					content,
					toolCalls: [
						{
							id: 'call_list_dir',
							type: 'function',
							function: {
								name: 'run_terminal_command',
								arguments: JSON.stringify({ command: 'rm -rf /' })
							}
						}
					]
				};
			} else {
				// Verify rejection response in history
				const toolResultMsg = messages.find(m => m.role === 'tool');
				assert.ok(toolResultMsg);
				assert.strictEqual(toolResultMsg.content, 'Tool execution rejected by user.');
				
				const content = 'No problem, I will not execute the command.';
				if (options?.onChunk) {
					options.onChunk(content);
				}
				return {
					content
				};
			}
		};

		// Mock the window approval dialog to reject
		// @ts-ignore
		vscode.window.showWarningMessage = async (message: string, options: any, ...items: string[]) => {
			return 'Reject';
		};

		const mockRequest: any = {
			prompt: 'inspect directory contents please',
			references: []
		};
		const mockContext: any = {
			history: []
		};

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.strictEqual(markdowns.length, 2);
		assert.ok(markdowns[1].includes('not execute the command'), 'Assistant response should acknowledge rejection');
	});

	test('should successfully route a reverse-engineering task to security model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'security-model', 'Reverse engineering should route to security-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('reverse engineering expert'), 'System prompt should match Reverse Engineering expert');
			
			const content = 'Analyzed decompiled loop: it represents a basic XOR key lookup.';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'analyze decompiled loop',
			command: 'reverse-engineering',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.ok(markdowns[0].includes('XOR key lookup'));
	});

	test('should successfully route a learning task to fast model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'fast-model', 'Learning should route to fast-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('patient and skilled teacher'), 'System prompt should match Learning expert');
			
			const content = 'Recursion is when a function calls itself.';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'explain recursion',
			command: 'learning',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.ok(markdowns[0].includes('function calls itself'));
	});

	test('should successfully route a documentation task to correct model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'fast-model', 'Documentation should route to fast-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('technical documentation specialist'), 'System prompt should match Documentation expert');
			
			const content = '# ModelPilot README';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'generate README',
			command: 'documentation',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.strictEqual(markdowns[0], '# ModelPilot README');
	});

	test('should successfully route a binary-exploitation task to security model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'security-model', 'Binary exploitation should route to security-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('binary exploitation expert'), 'System prompt should match Binary Exploitation expert');
			
			const content = 'Offset to EIP is 64 bytes. We can construct a ROP chain.';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'craft buffer overflow exploit',
			command: 'binary-exploitation',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.ok(markdowns[0].includes('ROP chain'));
	});

	test('should successfully route a web-security task to security model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'security-model', 'Web security should route to security-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('web application security analyst'), 'System prompt should match Web Security expert');
			
			const content = 'Vulnerability: stored XSS on search endpoint.';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'test website for cross-site scripting',
			command: 'web-security',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.ok(markdowns[0].includes('stored XSS'));
	});

	test('should successfully route a malware-analysis task to security model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'security-model', 'Malware analysis should route to security-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('malware analyst with threat intelligence'), 'System prompt should match Malware Analysis expert');
			
			const content = 'Detected a Trojan family loader communicating with static C2.';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'analyze binary behaviour',
			command: 'malware-analysis',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.ok(markdowns[0].includes('static C2'));
	});

	test('should successfully route a cryptography task to security model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'security-model', 'Cryptography should route to security-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('cryptography expert specialising in CTF'), 'System prompt should match Cryptography expert');
			
			const content = 'This is an RSA small-e attack.';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'solve cipher',
			command: 'cryptography',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.ok(markdowns[0].includes('RSA small-e'));
	});

	test('should successfully route a linux task to security model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'security-model', 'Linux tasks should route to security-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('Linux systems expert with deep knowledge'), 'System prompt should match Linux expert');
			
			const content = 'Here is the cron job format.';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'configure cron job',
			command: 'linux',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.ok(markdowns[0].includes('cron job'));
	});

	test('should successfully route a writing task to fast model', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			assert.strictEqual(recs[0].model.id, 'fast-model', 'Writing tasks should route to fast-model');
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('expert writer with a clear'), 'System prompt should match Writing expert');
			
			const content = 'Once upon a time, in a clean architecture...';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'write a short story',
			command: 'writing',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(mockRequest, mockContext, mockResponseStream, mockToken, mockSm as SecretsManager, registry, config, async () => 3);
		assert.strictEqual(markdowns.length, 1);
		assert.ok(markdowns[0].includes('clean architecture'));
	});

	test('should fall back to unhealthy providers if all healthy providers fail', async () => {
		// Restore original route method
		Router.prototype.route = originalRoute;
		// Clear monitor and record failures to mark nvidia as unhealthy
		healthMonitor.clear();
		healthMonitor.recordFailure('nvidia');
		healthMonitor.recordFailure('nvidia');
		healthMonitor.recordFailure('nvidia');
		assert.strictEqual(healthMonitor.isHealthy('nvidia'), false, 'Nvidia should be marked unhealthy after 3 failures');
		assert.strictEqual(healthMonitor.isHealthy('groq'), true, 'Groq should be healthy by default');

		// Setup mock providers
		const mockNvidiaProvider: any = {
			name: 'nvidia',
			isConfigured: () => true,
			chat: async () => ({ content: 'Nvidia response after Groq failed' }),
			listModels: async () => []
		};
		const mockGroqProvider: any = {
			name: 'groq',
			isConfigured: () => true,
			chat: async () => {
				throw new Error('Groq rate limited');
			},
			listModels: async () => []
		};

		const router = new Router([mockGroqProvider, mockNvidiaProvider]);

		const recommendations = [
			{ model: { id: 'groq-model', provider: 'groq', displayName: 'Groq Model' } as any, rank: 1, reason: '' },
			{ model: { id: 'nvidia-model', provider: 'nvidia', displayName: 'Nvidia Model' } as any, rank: 2, reason: '' }
		];

		const result = await router.route(recommendations, [{ role: 'user', content: 'test' }]);
		assert.strictEqual(result.content, 'Nvidia response after Groq failed', 'Should successfully fall back to unhealthy Nvidia model');

		// Cleanup health monitor
		healthMonitor.clear();
	});

	test('should process request natively with ModelPilot routing when chat session was started with @modelpilot', async () => {
		let routerRouteCalled = false;
		Router.prototype.route = async (recs, messages, tools, options) => {
			routerRouteCalled = true;
			const content = 'ModelPilot handled this turn';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'tell me more',
			references: []
		};
		// First turn in history was handled by modelpilot
		const mockContext: any = {
			history: [
				{
					prompt: 'hello modelpilot',
					participant: 'modelpilot.chatParticipant'
				},
				{
					response: [{ value: 'hello user' }],
					participant: 'modelpilot.chatParticipant',
					result: {
						metadata: {
							messages: []
						}
					}
				}
			]
		};

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.ok(routerRouteCalled, 'ModelPilot router should be called');
		assert.strictEqual(markdowns.length, 1);
		assert.strictEqual(markdowns[0], 'ModelPilot handled this turn');
	});

	test('should delegate/forward request to Copilot when chat session was started with another participant', async () => {
		let routerRouteCalled = false;
		Router.prototype.route = async (recs, messages, tools, options) => {
			routerRouteCalled = true;
			return { content: 'ModelPilot handled this turn' };
		};

		let sendRequestCalled = false;
		const mockRequest: any = {
			prompt: 'tell me more',
			references: [],
			model: {
				sendRequest: async (messages: any, options: any, token: any) => {
					sendRequestCalled = true;
					return {
						stream: (async function* () {
							yield new vscode.LanguageModelTextPart('Copilot handled this turn');
						})()
					};
				}
			}
		};
		// First turn in history was handled by workspace participant
		const mockContext: any = {
			history: [
				{
					prompt: 'hello workspace',
					participant: 'vscode.workspace'
				},
				{
					response: [{ value: 'hello user' }],
					participant: 'vscode.workspace'
				}
			]
		};

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.ok(!routerRouteCalled, 'ModelPilot router should not be called');
		assert.ok(sendRequestCalled, 'Copilot model.sendRequest should be called');
		assert.strictEqual(markdowns.length, 1);
		assert.strictEqual(markdowns[0], 'Copilot handled this turn');
	});

	test('should correctly reconstruct chat history turns including tool calls and results from metadata.messages', async () => {
		let receivedMessages: any[] = [];
		Router.prototype.route = async (recs, messages, tools, options) => {
			receivedMessages = messages;
			const content = 'ModelPilot resolved this turn';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'why did you delete that file?',
			references: []
		};

		const mockHistoryMessages = [
			{ role: 'user', content: 'delete temporary file temp.txt' },
			{
				role: 'assistant',
				content: 'I will delete the file temp.txt.',
				tool_calls: [
					{
						id: 'call_del_temp',
						type: 'function',
						function: {
							name: 'delete_file',
							arguments: JSON.stringify({ path: 'temp.txt' })
						}
					}
				]
			},
			{
				role: 'tool',
				name: 'delete_file',
				tool_call_id: 'call_del_temp',
				content: 'File temp.txt deleted successfully.'
			}
		];

		const mockContext: any = {
			history: [
				{
					prompt: 'delete temporary file temp.txt',
					participant: 'modelpilot.chatParticipant'
				},
				{
					response: [{ value: 'I will delete the file temp.txt.' }],
					participant: 'modelpilot.chatParticipant',
					result: {
						metadata: {
							messages: mockHistoryMessages
						}
					}
				}
			]
		};

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		// The reconstructed history should contain:
		// 1. System prompt
		// 2. The three messages from metadata (User, Assistant with tool_calls, Tool result)
		// 3. The current user prompt
		// 4. The assistant response added during handling
		assert.strictEqual(receivedMessages.length, 6, 'Should reconstruct 6 messages total');
		
		const systemMsg = receivedMessages[0];
		assert.strictEqual(systemMsg.role, 'system');
		
		assert.strictEqual(receivedMessages[1].role, 'user');
		assert.strictEqual(receivedMessages[1].content, 'delete temporary file temp.txt');

		assert.strictEqual(receivedMessages[2].role, 'assistant');
		assert.strictEqual(receivedMessages[2].tool_calls?.[0]?.id, 'call_del_temp');

		assert.strictEqual(receivedMessages[3].role, 'tool');
		assert.strictEqual(receivedMessages[3].tool_call_id, 'call_del_temp');

		assert.strictEqual(receivedMessages[4].role, 'user');
		assert.strictEqual(receivedMessages[4].content, 'why did you delete that file?');

		assert.strictEqual(receivedMessages[5].role, 'assistant');
		assert.strictEqual(receivedMessages[5].content, 'ModelPilot resolved this turn');
	});

	test('should handle request natively if the last turn in history was handled by ModelPilot (sticky routing)', async () => {
		let routerRouteCalled = false;
		Router.prototype.route = async (recs, messages, tools, options) => {
			routerRouteCalled = true;
			const content = 'ModelPilot handled this turn';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'continue with modelpilot',
			references: []
		};
		// Session started with workspace, but last turn was modelpilot
		const mockContext: any = {
			history: [
				{
					prompt: 'hello workspace',
					participant: 'vscode.workspace'
				},
				{
					response: [{ value: 'hello user' }],
					participant: 'vscode.workspace'
				},
				{
					prompt: 'hello modelpilot',
					participant: 'modelpilot.chatParticipant'
				},
				{
					response: [{ value: 'how can I help?' }],
					participant: 'modelpilot.chatParticipant',
					result: {
						metadata: {
							messages: []
						}
					}
				}
			]
		};

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.ok(routerRouteCalled, 'ModelPilot router should be called because of sticky routing');
		assert.strictEqual(markdowns.length, 1);
		assert.strictEqual(markdowns[0], 'ModelPilot handled this turn');
	});

	test('should handle request natively if the last turn in history was handled by ModelPilot with fully qualified participant ID', async () => {
		let routerRouteCalled = false;
		Router.prototype.route = async (recs, messages, tools, options) => {
			routerRouteCalled = true;
			const content = 'ModelPilot handled this turn';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'continue with modelpilot',
			references: []
		};
		const mockContext: any = {
			history: [
				{
					prompt: 'hello workspace',
					participant: 'vscode.workspace'
				},
				{
					response: [{ value: 'hello user' }],
					participant: 'vscode.workspace'
				},
				{
					prompt: 'hello modelpilot',
					participant: 'pub.ext.modelpilot.chatParticipant'
				},
				{
					response: [{ value: 'how can I help?' }],
					participant: 'pub.ext.modelpilot.chatParticipant',
					result: {
						metadata: {
							messages: []
						}
					}
				}
			]
		};

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.ok(routerRouteCalled, 'ModelPilot router should be called because of sticky routing');
		assert.strictEqual(markdowns.length, 1);
		assert.strictEqual(markdowns[0], 'ModelPilot handled this turn');
	});

	test('should run /ask command without tool executions', async () => {
		let routerRouteCalled = false;
		let receivedTools: any = null;
		Router.prototype.route = async (recs, messages, tools, options) => {
			routerRouteCalled = true;
			receivedTools = tools;
			const content = 'Ask Mode Response';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'tell me about quantum computing',
			command: 'ask',
			references: []
		};
		const mockContext: any = { history: [] };

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.ok(routerRouteCalled);
		assert.strictEqual(receivedTools, undefined, 'Ask mode should not pass tools');
		assert.strictEqual(markdowns[0], 'Ask Mode Response');
	});

	test('should run /plan command with plan prompts and without tool executions', async () => {
		let planSystemPrompt = '';
		let receivedTools: any = null;
		Router.prototype.route = async (recs, messages, tools, options) => {
			planSystemPrompt = messages.find(m => m.role === 'system')?.content || '';
			receivedTools = tools;
			const content = 'Here is the plan...';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'how to build a website',
			command: 'plan',
			references: []
		};
		const mockContext: any = { history: [] };

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.strictEqual(receivedTools, undefined, 'Plan mode should not run tools');
		assert.ok(planSystemPrompt.includes('Plan Mode'), 'Should inject Plan Mode context in system prompt');
		assert.strictEqual(markdowns[0], 'Here is the plan...');
	});

	test('should run /agent command with tools and agent prompts', async () => {
		let agentSystemPrompt = '';
		let receivedTools: any = null;
		Router.prototype.route = async (recs, messages, tools, options) => {
			agentSystemPrompt = messages.find(m => m.role === 'system')?.content || '';
			receivedTools = tools;
			const content = 'Agent is executing';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'create a file',
			command: 'agent',
			references: []
		};
		const mockContext: any = { history: [] };

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.ok(receivedTools !== undefined, 'Agent mode should enable tools');
		assert.ok(agentSystemPrompt.includes('Agent Mode'), 'Should inject Agent Mode context in system prompt');
	});

	test('should auto-approve tool execution and run autonomously in bypass approval mode', async () => {
		// Mock configuration for bypass mode
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string, scope?: any) => {
			if (section === 'modelpilot') {
				return {
					get: (key: string) => {
						if (key === 'approvalMode') {
							return 'bypass';
						}
						return undefined;
					}
				} as any;
			}
			return originalGetConfiguration(section, scope);
		};
		
		let showWarningMessageCalled = false;
		vscode.window.showWarningMessage = async () => {
			showWarningMessageCalled = true;
			return 'Approve';
		};

		Router.prototype.route = async (recs, messages, tools, options) => {
			// Return a tool call
			if (messages.length === 1) {
				const content = 'Creating a file';
				if (options?.onChunk) {
					options.onChunk(content);
				}
				return {
					content,
					toolCalls: [{
						id: 'call_create',
						type: 'function',
						function: {
							name: 'create_file',
							arguments: JSON.stringify({ path: 'test_auto.txt', content: 'test autopilot content' })
						}
					}]
				};
			}
			// Second iteration - tool completed
			const content = 'File created';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'create file test_auto.txt',
			references: []
		};
		const mockContext: any = { history: [] };

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		try {
			await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				config,
				async () => 3
			);

			assert.ok(!showWarningMessageCalled, 'Should not prompt user in bypass approval mode');
			assert.strictEqual(markdowns[markdowns.length - 1], 'File created');
		} finally {
			// Cleanup
			vscode.workspace.getConfiguration = originalGetConfiguration;
			// Clean up created file
			try {
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (workspaceRoot) {
					fs.unlinkSync(path.join(workspaceRoot, 'test_auto.txt'));
				}
			} catch {}
		}
	});

	test('should auto-extend loop iteration limits autonomously in autopilot approval mode', async () => {
		// Mock configuration for autopilot mode
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string, scope?: any) => {
			if (section === 'modelpilot') {
				return {
					get: (key: string) => {
						if (key === 'approvalMode') {
							return 'autopilot';
						}
						return undefined;
					}
				} as any;
			}
			return originalGetConfiguration(section, scope);
		};
		
		let showWarningMessageCalled = false;
		vscode.window.showWarningMessage = async () => {
			showWarningMessageCalled = true;
			return 'Approve';
		};

		let callCounter = 0;
		Router.prototype.route = async (recs, messages, tools, options) => {
			callCounter++;
			if (callCounter <= 16) {
				const content = `Loop iteration ${callCounter}`;
				if (options?.onChunk) {
					options.onChunk(content);
				}
				// Keep calling a dummy tool to exceed 15 limit
				return {
					content,
					toolCalls: [{
						id: `call_${callCounter}`,
						type: 'function',
						function: {
							name: 'read_file',
							arguments: JSON.stringify({ path: 'package.json' })
						}
					}]
				};
			}
			const content = 'Autonomous loops finished';
			if (options?.onChunk) {
				options.onChunk(content);
			}
			return { content };
		};

		const mockRequest: any = {
			prompt: 'loop read file',
			references: []
		};
		const mockContext: any = { history: [] };

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		const mockGlobalState: any = {
			storage: { autopilotConsent: true },
			get(key: string, def?: any) { return this.storage[key] !== undefined ? this.storage[key] : def; },
			update(key: string, val: any) { this.storage[key] = val; return Promise.resolve(); }
		};

		try {
			await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				config,
				async () => 3,
				mockGlobalState
			);

			assert.ok(!showWarningMessageCalled, 'Should not prompt user in autopilot mode for approval when already consented');
			assert.strictEqual(markdowns[markdowns.length - 1], 'Autonomous loops finished');
			assert.ok(callCounter > 15, 'Should autonomously iterate past 15 times');
		} finally {
			// Cleanup
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});

	test('should resolve default VS Code autopilot permission setting to autopilot mode', () => {
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string, scope?: any) => {
			if (section === 'modelpilot') {
				return { get: () => 'default' } as any;
			}
			if (section === 'chat.permissions') {
				return { get: (key: string) => key === 'default' ? 'autopilot' : undefined } as any;
			}
			return originalGetConfiguration(section, scope);
		};

		try {
			const { getApprovalMode } = require('../extension');
			assert.strictEqual(getApprovalMode(), 'autopilot');
		} finally {
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});

	test('should prompt user for autopilot consent once when not consented, and then run autonomously without prompting after consent is saved', async () => {
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string, scope?: any) => {
			if (section === 'modelpilot') {
				return {
					get: (key: string) => {
						if (key === 'approvalMode') {
							return 'autopilot';
						}
						return undefined;
					}
				} as any;
			}
			return originalGetConfiguration(section, scope);
		};

		let showWarningMessageCallCount = 0;
		let lastWarningMessage = '';
		vscode.window.showWarningMessage = async (message: string, ...items: any[]) => {
			showWarningMessageCallCount++;
			lastWarningMessage = message;
			return 'I Consent';
		};

		let routeCallCount = 0;
		Router.prototype.route = async (recs, messages, tools, options) => {
			if (messages[0]?.content?.includes('intent classifier')) {
				return { content: '{"isChitchat": false, "expertId": "coding"}' };
			}
			routeCallCount++;
			if (routeCallCount === 1) {
				return {
					content: 'Running terminal command',
					toolCalls: [{
						id: 'call_cmd',
						type: 'function',
						function: {
							name: 'run_terminal_command',
							arguments: JSON.stringify({ command: 'echo "hello"' })
						}
					}]
				};
			}
			return { content: 'Finished' };
		};

		const mockRequest: any = {
			prompt: 'run a command',
			references: []
		};
		const mockContext: any = { history: [] };

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		const mockGlobalState: any = {
			storage: {},
			get(key: string, def?: any) { return this.storage[key] !== undefined ? this.storage[key] : def; },
			update(key: string, val: any) { this.storage[key] = val; return Promise.resolve(); }
		};

		try {
			// First run - should prompt and get consent
			await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				config,
				async () => 3,
				mockGlobalState
			);

			assert.strictEqual(showWarningMessageCallCount, 1, 'Should prompt user once for autopilot consent');
			assert.ok(lastWarningMessage.includes('Autopilot mode'), 'Prompt should ask for Autopilot consent');
			assert.strictEqual(mockGlobalState.storage.autopilotConsent, true, 'Autopilot consent should be stored in globalState');
			assert.ok(markdowns.some(m => m.includes('ModelPilot Autopilot Warning')), 'Warning should be printed in chat');

			// Second run - should NOT prompt again
			showWarningMessageCallCount = 0;
			routeCallCount = 0;
			markdowns.length = 0;

			await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				config,
				async () => 3,
				mockGlobalState
			);

			assert.strictEqual(showWarningMessageCallCount, 0, 'Should not prompt user again once consent is stored');
			assert.ok(!markdowns.some(m => m.includes('ModelPilot Autopilot Warning')), 'Consent warning should not be printed in chat again');

		} finally {
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});

	test('should track stateful agentCwd, resolve files relative to it, and persist in history metadata', async () => {
		// Mock configuration to bypass approval so tools run automatically
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		vscode.workspace.getConfiguration = (section?: string, scope?: any) => {
			if (section === 'modelpilot') {
				return {
					get: (key: string) => {
						if (key === 'approvalMode') {
							return 'bypass';
						}
						return undefined;
					}
				} as any;
			}
			return originalGetConfiguration(section, scope);
		};

		const root = getWorkspaceRoot();

		// Prepare directories
		const testSubdir = path.join(root, 'test-cwd-subdir');
		if (!fs.existsSync(testSubdir)) {
			fs.mkdirSync(testSubdir, { recursive: true });
		}

		let turnCount = 0;
		Router.prototype.route = async (recs, messages, tools, options) => {
			if (messages[0]?.content?.includes('intent classifier')) {
				return { content: '{"isChitchat": false, "expertId": "coding"}' };
			}
			if (turnCount === 0) {
				turnCount++;
				const content = 'Going to run cd and then create a file';
				if (options?.onChunk) {
					options.onChunk(content);
				}
				return {
					content,
					toolCalls: [
						{
							id: 'call_cd',
							type: 'function',
							function: {
								name: 'run_terminal_command',
								arguments: JSON.stringify({ command: 'cd test-cwd-subdir' })
							}
						}
					]
				};
			} else if (turnCount === 1) {
				turnCount++;
				// Verify Cwd is passed/updated and shown in Environment Context
				const systemMsg = messages.find(m => m.role === 'system');
				assert.ok(systemMsg);
				assert.ok(systemMsg.content.includes("- Current Working Directory (Cwd): 'test-cwd-subdir'"), 'System prompt should include the updated Cwd context');

				const content = 'Creating relative file';
				if (options?.onChunk) {
					options.onChunk(content);
				}
				return {
					content,
					toolCalls: [
						{
							id: 'call_create_file',
							type: 'function',
							function: {
								name: 'create_file',
								arguments: JSON.stringify({ path: 'inside_subdir.txt', content: 'hello inside subdir' })
							}
						}
					]
				};
			} else {
				const content = 'Done';
				if (options?.onChunk) {
					options.onChunk(content);
				}
				return { content };
			}
		};

		const mockRequest: any = {
			prompt: 'cwd test',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		try {
			const chatResult = await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				config,
				async () => 3
			);

			// Check that file was created in the subdirectory (resolving relative to agentCwd)
			const expectedFile = path.join(testSubdir, 'inside_subdir.txt');
			assert.ok(fs.existsSync(expectedFile), 'File should be created inside the subdir relative to active agentCwd');
			assert.strictEqual(fs.readFileSync(expectedFile, 'utf8'), 'hello inside subdir');

			// Check that final agentCwd is returned in metadata
			assert.strictEqual(chatResult?.metadata?.agentCwd, 'test-cwd-subdir');

		} finally {
			// Cleanup
			vscode.workspace.getConfiguration = originalGetConfiguration;
			try {
				const expectedFile = path.join(testSubdir, 'inside_subdir.txt');
				if (fs.existsSync(expectedFile)) {
					fs.unlinkSync(expectedFile);
				}
				if (fs.existsSync(testSubdir)) {
					fs.rmdirSync(testSubdir);
				}
			} catch {}
		}
	});

	test('should recursively list and include folder context structure in user prompt references', async () => {
		const root = getWorkspaceRoot();
		const testFolder = path.join(root, 'test-references-folder');
		if (!fs.existsSync(testFolder)) {
			fs.mkdirSync(testFolder, { recursive: true });
		}
		const subFile1 = path.join(testFolder, 'file1.txt');
		const subFile2 = path.join(testFolder, 'file2.txt');
		fs.writeFileSync(subFile1, 'content1');
		fs.writeFileSync(subFile2, 'content2');

		let receivedPrompt = '';
		Router.prototype.route = async (recs, messages, tools, options) => {
			const userMsg = messages.find(m => m.role === 'user');
			if (userMsg) {
				receivedPrompt = userMsg.content;
			}
			return { content: 'Folder scanned' };
		};

		const mockRequest: any = {
			prompt: 'inspect this folder',
			references: [
				{
					id: 'folder',
					value: vscode.Uri.file(testFolder)
				}
			]
		};
		const mockContext: any = { history: [] };
		const mockResponseStream: any = {
			markdown: () => mockResponseStream,
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		try {
			await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				config,
				async () => 3
			);

			assert.ok(receivedPrompt.includes('--- Folder: test-references-folder ---'), 'Should include folder reference banner');
			assert.ok(receivedPrompt.includes('[File] file1.txt'), 'Should list sub-file 1');
			assert.ok(receivedPrompt.includes('[File] file2.txt'), 'Should list sub-file 2');
		} finally {
			try {
				if (fs.existsSync(subFile1)) {
					fs.unlinkSync(subFile1);
				}
				if (fs.existsSync(subFile2)) {
					fs.unlinkSync(subFile2);
				}
				if (fs.existsSync(testFolder)) {
					fs.rmdirSync(testFolder);
				}
			} catch {}
		}
	});

	test('should resolve and scan vscode.Location reference values successfully', async () => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { return; }
		const testFile = path.resolve(root, 'test-location-file.txt');
		fs.writeFileSync(testFile, 'Location context file content');

		let receivedPrompt = '';
		Router.prototype.route = async (recs, messages, tools, options) => {
			const userMsg = messages.find(m => m.role === 'user');
			if (userMsg) {
				receivedPrompt = userMsg.content;
			}
			return { content: 'Location resolved' };
		};

		const mockRequest: any = {
			prompt: 'analyze code symbol location',
			references: [
				{
					id: 'symbol-location',
					value: {
						uri: vscode.Uri.file(testFile),
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 5 }
						}
					}
				}
			]
		};
		const mockContext: any = { history: [] };
		const mockResponseStream: any = {
			markdown: () => mockResponseStream,
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		try {
			await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				config,
				async () => 3
			);

			assert.ok(receivedPrompt.includes('--- File: test-location-file.txt ---'), 'Should include location file reference banner');
			assert.ok(receivedPrompt.includes('Location context file content'), 'Should include location file content');
		} finally {
			if (fs.existsSync(testFile)) {
				fs.unlinkSync(testFile);
			}
		}
	});

	test('should auto-classify operationMode using fast intent classifier', async () => {
		Router.prototype.route = async (recs, messages, tools, options) => {
			if (messages[0]?.content?.includes('intent classifier')) {
				return { content: '{"isChitchat": false, "expertId": "coding", "operationMode": "plan"}' };
			}
			const systemMsg = messages.find(m => m.role === 'system');
			assert.ok(systemMsg);
			assert.ok(systemMsg.content.includes('[Mode Context: Plan Mode]'), 'Should route to Plan Mode');
			return { content: 'Dynamic plan formulated' };
		};

		const mockRequest: any = {
			prompt: 'how should we implement a database backup?',
			references: []
		};
		const mockContext: any = { history: [] };
		const mockResponseStream: any = {
			markdown: () => mockResponseStream,
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);
	});

	test('should respect modelpilot.defaultMode configuration setting', async () => {
		const originalGetConfiguration = vscode.workspace.getConfiguration;
		// @ts-ignore
		vscode.workspace.getConfiguration = (section?: string) => {
			if (section === 'modelpilot') {
				return {
					get: (key: string, defaultValue?: any) => {
						if (key === 'defaultMode') { return 'plan'; }
						if (key === 'approvalMode') { return 'default'; }
						return defaultValue;
					}
				};
			}
			return originalGetConfiguration(section);
		};

		let systemPrompt = '';
		Router.prototype.route = async (recs, messages, tools, options) => {
			systemPrompt = messages.find(m => m.role === 'system')?.content || '';
			return { content: 'Respected defaultMode config' };
		};

		const mockRequest: any = {
			prompt: 'write code',
			references: []
		};
		const mockContext: any = { history: [] };
		const mockResponseStream: any = {
			markdown: () => mockResponseStream,
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		try {
			await handleChatRequest(
				mockRequest,
				mockContext,
				mockResponseStream,
				mockToken,
				mockSm as SecretsManager,
				registry,
				{ ...config, defaultMode: 'plan' },
				async () => 3
			);

			assert.ok(systemPrompt.includes('[Mode Context: Plan Mode]'), 'Should default to Plan Mode via configuration');
		} finally {
			vscode.workspace.getConfiguration = originalGetConfiguration;
		}
	});

	test('should include model reliability instructions in system prompt', async () => {
		let systemPrompt = '';
		Router.prototype.route = async (recs, messages, tools, options) => {
			systemPrompt = messages.find(m => m.role === 'system')?.content || '';
			return { content: 'Tested model reliability prompt inclusion' };
		};

		const mockRequest: any = {
			prompt: 'write code to connect to mysql',
			references: []
		};
		const mockContext: any = { history: [] };
		const mockResponseStream: any = {
			markdown: () => mockResponseStream,
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.ok(systemPrompt.includes('[MODEL RELIABILITY INSTRUCTIONS]'), 'System prompt should include model reliability instructions');
		assert.ok(systemPrompt.includes('CHAIN-OF-THOUGHT FORCING FOR COMPLEX TASKS'), 'System prompt should include chain-of-thought guidelines');
		assert.ok(systemPrompt.includes('EXPLICIT OUTPUT CONTRACTS'), 'System prompt should include output contract guidelines');
	});

	test('should correctly decompose complex user requests using TaskDecomposer', () => {
		const { decompose } = require('../engine/TaskDecomposer');
		const task = decompose('refactor this auth module and add tests');
		assert.ok(task);
		assert.strictEqual(task.subtasks.length, 2);
		assert.strictEqual(task.subtasks[0].category, 'coding');
		assert.strictEqual(task.subtasks[1].category, 'coding');
		assert.deepStrictEqual(task.subtasks[1].dependsOn, ['0']);

		const nonComplex = decompose('hello general assistant');
		assert.strictEqual(nonComplex, null);
	});

	test('should route and execute decomposed subtasks sequentially in handleChatRequest', async () => {
		const routedSubtasks: string[] = [];
		Router.prototype.route = async (recs, messages, tools, options) => {
			const userMsg = messages.find(m => m.role === 'user');
			
			// Detect which subtask is currently running
			if (userMsg?.content?.includes('Your specific task: Refactor')) {
				routedSubtasks.push('refactor');
				return { content: 'Refactored auth module content' };
			} else if (userMsg?.content?.includes('Your specific task: Write comprehensive tests')) {
				routedSubtasks.push('test');
				assert.ok(userMsg.content.includes('Context from previous step:\nRefactored auth module content'), 'Should pass context from previous step');
				return { content: 'Generated tests' };
			}
			return { content: 'Fallback response' };
		};

		const mockRequest: any = {
			prompt: 'refactor this auth module and add tests',
			references: []
		};
		const mockContext: any = { history: [] };
		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};
		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		assert.deepStrictEqual(routedSubtasks, ['refactor', 'test'], 'Should run subtasks sequentially');
	});

	test('should run /export command and write Markdown export to workspace', async () => {
		const mockRequest: any = {
			prompt: 'export this chat',
			command: 'export',
			references: []
		};
		const mockContext: any = {
			history: [
				{
					prompt: 'Hello ModelPilot',
					references: []
				},
				{
					response: [
						{ value: 'Hello User' }
					]
				}
			]
		};

		const markdowns: string[] = [];
		const mockResponseStream: any = {
			markdown: (value: any) => {
				markdowns.push(typeof value === 'string' ? value : value.value);
				return mockResponseStream;
			},
			progress: () => mockResponseStream
		};

		const mockToken: any = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} })
		};

		await handleChatRequest(
			mockRequest,
			mockContext,
			mockResponseStream,
			mockToken,
			mockSm as SecretsManager,
			registry,
			config,
			async () => 3
		);

		try {
			assert.ok(markdowns.some(m => m.includes('Chat successfully exported')));
		} catch (err) {
			console.log("TEST DEBUG - markdowns:", markdowns);
			throw err;
		}

		const workspaceFolders = vscode.workspace.workspaceFolders;
		const rootUri = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri : vscode.Uri.file(os.tmpdir());
		const files = await vscode.workspace.fs.readDirectory(rootUri);
		const exportFiles = files.filter(([name]) => name.startsWith('modelpilot-chat-export-') && name.endsWith('.md'));
		assert.ok(exportFiles.length > 0, 'An export file should have been created');

		for (const [name] of exportFiles) {
			const fileUri = vscode.Uri.joinPath(rootUri, name);
			await vscode.workspace.fs.delete(fileUri);
		}
	});

	test('should rotate key immediately on 429 rate limit without retrying same key', async () => {
		const originalFetch = global.fetch;
		const requestedKeys: string[] = [];
		
		// Create a test provider
		class TestProvider extends OpenAICompatibleProvider {
			readonly name = 'test-provider';
			readonly baseUrl = 'https://api.example.com';
			constructor(readonly apiKeys: string[]) {
				super();
			}
			async listModels() {
				return [];
			}
		}

		const provider = new TestProvider(['key-0', 'key-1']);

		// Mock global.fetch
		// @ts-ignore
		global.fetch = async (url: string, init?: any) => {
			const authHeader = init?.headers?.['Authorization'] || '';
			const key = authHeader.replace('Bearer ', '').trim();
			requestedKeys.push(key);

			if (key === 'key-0') {
				return {
					status: 429,
					ok: false,
					text: async () => 'Rate limit exceeded',
				} as any;
			}

			if (key === 'key-1') {
				return {
					status: 200,
					ok: true,
					json: async () => ({
						choices: [
							{
								message: {
									content: 'Response from key-1',
								},
							},
						],
					}),
				} as any;
			}

			return {
				status: 500,
				ok: false,
				text: async () => 'Internal Server Error',
			} as any;
		};

		try {
			const result = await provider.chat('some-model', [{ role: 'user', content: 'test' }]);
			assert.strictEqual(result.content, 'Response from key-1');
			assert.deepStrictEqual(requestedKeys, ['key-0', 'key-1']);
			
			// Verify state is saved, next request should use key-1 directly
			requestedKeys.length = 0;
			const result2 = await provider.chat('some-model', [{ role: 'user', content: 'test2' }]);
			assert.strictEqual(result2.content, 'Response from key-1');
			assert.deepStrictEqual(requestedKeys, ['key-1']);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test('should wait for shortest key cooldown and retry if all keys are in cooldown', async () => {
		const originalFetch = global.fetch;
		const requestedKeys: string[] = [];
		let key0CallCount = 0;

		class TestProvider extends OpenAICompatibleProvider {
			readonly name = 'test-provider-cooldown';
			readonly baseUrl = 'https://api.example.com';
			constructor(readonly apiKeys: string[]) {
				super();
			}
			async listModels() {
				return [];
			}
		}

		const provider = new TestProvider(['key-0', 'key-1']);

		// Mock global.fetch
		// @ts-ignore
		global.fetch = async (url: string, init?: any) => {
			const authHeader = init?.headers?.['Authorization'] || '';
			const key = authHeader.replace('Bearer ', '').trim();
			requestedKeys.push(key);

			if (key === 'key-0') {
				key0CallCount++;
				if (key0CallCount === 1) {
					return {
						status: 429,
						ok: false,
						headers: {
							get: (name: string) => name.toLowerCase() === 'retry-after' ? '1' : null
						},
						text: async () => '{"error": {"retry_after_seconds": 1}}',
					} as any;
				}
				return {
					status: 200,
					ok: true,
					json: async () => ({
						choices: [{ message: { content: 'Success on key-0 after wait' } }],
					}),
				} as any;
			}

			if (key === 'key-1') {
				return {
					status: 429,
					ok: false,
					headers: {
						get: (name: string) => name.toLowerCase() === 'retry-after' ? '2' : null
					},
					text: async () => '{"error": {"retry_after_seconds": 2}}',
				} as any;
			}

			return {
				status: 500,
				ok: false,
				text: async () => 'Internal Error',
			} as any;
		};

		try {
			const startTime = Date.now();
			const result = await provider.chat('some-model', [{ role: 'user', content: 'test' }]);
			const duration = Date.now() - startTime;

			assert.strictEqual(result.content, 'Success on key-0 after wait');
			assert.deepStrictEqual(requestedKeys, ['key-0', 'key-1', 'key-0']);
			assert.ok(duration >= 1000, `Should have waited at least 1s (got ${duration}ms)`);
		} finally {
			global.fetch = originalFetch;
		}
	});

	test('should parse retry-after from headers and text body formats correctly', () => {
		const { parseRetryAfter } = require('../providers/OpenAICompatibleProvider');

		// 1. retry-after header as integer
		const headers1 = new Map<string, string>([['retry-after', '15']]);
		assert.strictEqual(parseRetryAfter('', headers1), 15);

		// 2. retry-after header as HTTP-date
		const futureDate = new Date(Date.now() + 25000).toUTCString();
		const headers2 = new Map<string, string>([['retry-after', futureDate]]);
		const parsed2 = parseRetryAfter('', headers2);
		assert.ok(parsed2 >= 24 && parsed2 <= 26, `Should parse HTTP-date as ~25s (got ${parsed2})`);

		// 3. x-ratelimit-reset header
		const headers3 = new Map<string, string>([['x-ratelimit-reset', '12.34']]);
		assert.strictEqual(parseRetryAfter('', headers3), 13);

		// 4. x-ratelimit-reset-requests header
		const headers4 = new Map<string, string>([['x-ratelimit-reset-requests', '2m15s']]);
		assert.strictEqual(parseRetryAfter('', headers4), 135);

		// 5. JSON body
		const errJson = JSON.stringify({ error: { retry_after_seconds: 5.5 } });
		assert.strictEqual(parseRetryAfter(errJson), 6);

		// 6. Text message: please try again in X.Xs
		assert.strictEqual(parseRetryAfter('please try again in 5.3s'), 6);

		// 7. Text message: retry in XmXs
		assert.strictEqual(parseRetryAfter('Rate limit reached. retry in 1m15s'), 75);

		// 8. Default fallback
		assert.strictEqual(parseRetryAfter('unknown error'), 10);
	});

	test('should sort candidate recommendations so that providers in cooldown are tried last', async () => {
		const originalRouteMethod = Router.prototype.route;
		Router.prototype.route = originalRoute;

		try {
			const { healthMonitor } = require('../engine/HealthMonitor');
			healthMonitor.clear();

			// Create two mock providers
			class MockProviderA extends OpenAICompatibleProvider {
				readonly name = 'provider-a';
				readonly baseUrl = 'https://a.com';
				constructor(readonly apiKeys: string[]) {
					super();
				}
				async listModels() { return []; }
			}

			class MockProviderB extends OpenAICompatibleProvider {
				readonly name = 'provider-b';
				readonly baseUrl = 'https://b.com';
				constructor(readonly apiKeys: string[]) {
					super();
				}
				async listModels() { return []; }
			}

			const providerA = new MockProviderA(['key-a']);
			const providerB = new MockProviderB(['key-b']);

			// Put providerA in cooldown by setting cooldown on its key
			// @ts-ignore
			providerA.keyCooldowns.set('key-a', Date.now() + 10000); // 10s cooldown

			// Mock their chat functions
			let providerAChatCalled = false;
			let providerBChatCalled = false;

			providerA.chat = async () => {
				providerAChatCalled = true;
				return { content: 'response A' };
			};

			providerB.chat = async () => {
				providerBChatCalled = true;
				return { content: 'response B' };
			};

			const router = new Router([providerA, providerB]);

			const recommendations = [
				{
					model: {
						id: 'model-a',
						displayName: 'Model A',
						provider: 'provider-a',
						contextLength: 4096,
					}
				},
				{
					model: {
						id: 'model-b',
						displayName: 'Model B',
						provider: 'provider-b',
						contextLength: 4096,
					}
				}
			] as any;

			// Route query
			const result = await router.route(recommendations, [{ role: 'user', content: 'hello' }]);

			// Since providerA is in cooldown, the router should have reordered candidateRecs
			// and called providerB first.
			assert.strictEqual(result.content, 'response B');
			assert.strictEqual(providerBChatCalled, true);
			assert.strictEqual(providerAChatCalled, false);
		} finally {
			Router.prototype.route = originalRouteMethod;
		}
	});

	test('should block superuser / privilege elevation commands in AgentExecutor', async () => {
		const resultSudo = await AgentExecutor.execute('run_terminal_command', { command: 'sudo apt-get update' }, '.');
		assert.ok(resultSudo.result.includes('superuser privileges'), 'Should block sudo command');

		const resultSu = await AgentExecutor.execute('run_terminal_command', { command: 'su -' }, '.');
		assert.ok(resultSu.result.includes('superuser privileges'), 'Should block su command');

		const resultPkexec = await AgentExecutor.execute('run_terminal_command', { command: 'pkexec systemctl restart' }, '.');
		assert.ok(resultPkexec.result.includes('superuser privileges'), 'Should block pkexec command');

		const resultRunas = await AgentExecutor.execute('run_terminal_command', { command: 'runas /user:administrator cmd' }, '.');
		assert.ok(resultRunas.result.includes('superuser privileges'), 'Should block runas command');

		// Normal command should NOT be blocked (it should run normally, e.g., print hello)
		const resultNormal = await AgentExecutor.execute('run_terminal_command', { command: 'echo hello_world_test' }, '.');
		assert.ok(!resultNormal.result.includes('superuser privileges'), 'Should not block normal command');
		assert.ok(resultNormal.result.includes('hello_world_test'), 'Should execute normal command and return output');
	});
});
