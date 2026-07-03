import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { GoogleProvider } from '../providers/GoogleProvider';
import { GroqProvider } from '../providers/GroqProvider';
import { NvidiaProvider } from '../providers/NvidiaProvider';
import { OpenRouterProvider } from '../providers/OpenRouterProvider';
import { CerebrasProvider } from '../providers/CerebrasProvider';
import { MODEL_PROFILES } from '../data/modelProfiles';
import { Router } from '../engine/Router';
import { AgentExecutor } from '../engine/AgentExecutor';


suite('ModelPilot Providers Independent Verification Tests', () => {
	let originalFetch: typeof global.fetch;

	setup(() => {
		originalFetch = global.fetch;
	});

	teardown(() => {
		global.fetch = originalFetch;
	});

	suite('GoogleProvider', () => {
		test('isConfigured should return true when keys are present and false otherwise', () => {
			const unconfigured = new GoogleProvider([]);
			assert.strictEqual(unconfigured.isConfigured(), false);

			const configured = new GoogleProvider(['test-key']);
			assert.strictEqual(configured.isConfigured(), true);
		});

		test('listModels returns empty array when not configured', async () => {
			const provider = new GoogleProvider([]);
			const models = await provider.listModels();
			assert.deepStrictEqual(models, []);
		});

		test('listModels maps live models correctly on success', async () => {
			const provider = new GoogleProvider(['valid-key']);
			(global as any).fetch = async (url: string) => {
				assert.ok(url.includes('googleapis.com'));
				return {
					ok: true,
					json: async () => ({
						data: [
							{ id: 'gemini-2.5-pro' },
							{ id: 'gemini-2.5-flash' }
						]
					})
				} as any;
			};

			const models = await provider.listModels();
			const googleProfiles = MODEL_PROFILES.filter(m => m.provider === 'google');
			assert.strictEqual(models.length, googleProfiles.length);

			const proModel = models.find(m => m.id === 'gemini-2.5-pro');
			assert.ok(proModel);
			assert.strictEqual(proModel.available, true);

			const fakeModel = models.find(m => m.id === 'non-existent-model');
			assert.strictEqual(fakeModel, undefined);
		});

		test('listModels throws authentication error on 401/403 status', async () => {
			const provider = new GoogleProvider(['invalid-key']);
			(global as any).fetch = async () => {
				return {
					ok: false,
					status: 401,
					statusText: 'Unauthorized'
				} as any;
			};

			await assert.rejects(
				provider.listModels(),
				/Authentication failed \(401\/403\)\. Please verify your API key\./
			);
		});

		test('listModels falls back to static profiles on network exception', async () => {
			const provider = new GoogleProvider(['valid-key']);
			(global as any).fetch = async () => {
				throw new Error('Network error');
			};

			const models = await provider.listModels();
			const googleProfiles = MODEL_PROFILES.filter(m => m.provider === 'google');
			assert.strictEqual(models.length, googleProfiles.length);
			assert.ok(models.every(m => m.available === true));
		});
	});

	suite('GroqProvider', () => {
		test('isConfigured should return true when keys are present and false otherwise', () => {
			const unconfigured = new GroqProvider([]);
			assert.strictEqual(unconfigured.isConfigured(), false);

			const configured = new GroqProvider(['test-key']);
			assert.strictEqual(configured.isConfigured(), true);
		});

		test('listModels returns empty array when not configured', async () => {
			const provider = new GroqProvider([]);
			const models = await provider.listModels();
			assert.deepStrictEqual(models, []);
		});

		test('listModels maps live models correctly on success', async () => {
			const provider = new GroqProvider(['valid-key']);
			(global as any).fetch = async (url: string) => {
				assert.ok(url.includes('api.groq.com'));
				return {
					ok: true,
					json: async () => ({
						data: [
							{ id: 'llama-3.3-70b-versatile' }
						]
					})
				} as any;
			};

			const models = await provider.listModels();
			const groqProfiles = MODEL_PROFILES.filter(m => m.provider === 'groq');
			assert.strictEqual(models.length, groqProfiles.length);

			const model70b = models.find(m => m.id === 'llama-3.3-70b-versatile');
			assert.ok(model70b);
			assert.strictEqual(model70b.available, true);
		});

		test('listModels falls back to static profiles on non-ok response', async () => {
			const provider = new GroqProvider(['valid-key']);
			(global as any).fetch = async () => {
				return {
					ok: false,
					status: 500,
					statusText: 'Internal Server Error'
				} as any;
			};

			const models = await provider.listModels();
			const groqProfiles = MODEL_PROFILES.filter(m => m.provider === 'groq');
			assert.strictEqual(models.length, groqProfiles.length);
			assert.ok(models.every(m => m.available === true));
		});
	});

	suite('NvidiaProvider', () => {
		test('isConfigured should return true when keys are present and false otherwise', () => {
			const unconfigured = new NvidiaProvider([]);
			assert.strictEqual(unconfigured.isConfigured(), false);

			const configured = new NvidiaProvider(['test-key']);
			assert.strictEqual(configured.isConfigured(), true);
		});

		test('listModels returns empty array when not configured', async () => {
			const provider = new NvidiaProvider([]);
			const models = await provider.listModels();
			assert.deepStrictEqual(models, []);
		});

		test('listModels maps live models correctly on success', async () => {
			const provider = new NvidiaProvider(['valid-key']);
			(global as any).fetch = async (url: string) => {
				assert.ok(url.includes('nvidia.com'));
				return {
					ok: true,
					json: async () => ({
						data: [
							{ id: 'deepseek-ai/deepseek-r1' }
						]
					})
				} as any;
			};

			const models = await provider.listModels();
			const nvidiaProfiles = MODEL_PROFILES.filter(m => m.provider === 'nvidia');
			assert.strictEqual(models.length, nvidiaProfiles.length);

			const r1Model = models.find(m => m.id === 'deepseek-ai/deepseek-r1');
			assert.ok(r1Model);
			assert.strictEqual(r1Model.available, true);
		});

		test('listModels falls back to static profiles on failure', async () => {
			const provider = new NvidiaProvider(['valid-key']);
			(global as any).fetch = async () => {
				return {
					ok: false,
					status: 503,
					statusText: 'Service Unavailable'
				} as any;
			};

			const models = await provider.listModels();
			const nvidiaProfiles = MODEL_PROFILES.filter(m => m.provider === 'nvidia');
			assert.strictEqual(models.length, nvidiaProfiles.length);
			assert.ok(models.every(m => m.available === true));
		});
	});

	suite('OpenRouterProvider', () => {
		test('isConfigured should return true when keys are present and false otherwise', () => {
			const unconfigured = new OpenRouterProvider([]);
			assert.strictEqual(unconfigured.isConfigured(), false);

			const configured = new OpenRouterProvider(['test-key']);
			assert.strictEqual(configured.isConfigured(), true);
		});

		test('listModels returns empty array when not configured', async () => {
			const provider = new OpenRouterProvider([]);
			const models = await provider.listModels();
			assert.deepStrictEqual(models, []);
		});

		test('listModels maps live models correctly on success and includes headers', async () => {
			const provider = new OpenRouterProvider(['valid-key']);
			let headersChecked = false;
			(global as any).fetch = async (url: string, init?: any) => {
				assert.ok(url.includes('openrouter.ai'));
				assert.strictEqual(init?.headers?.['HTTP-Referer'], 'https://github.com/modelpilot/modelpilot');
				assert.strictEqual(init?.headers?.['X-Title'], 'ModelPilot');
				headersChecked = true;
				return {
					ok: true,
					json: async () => ({
						data: [
							{ id: 'meta-llama/llama-3.3-70b-instruct:free' }
						]
					})
				} as any;
			};

			const models = await provider.listModels();
			assert.ok(headersChecked);
			const openrouterProfiles = MODEL_PROFILES.filter(m => m.provider === 'openrouter');
			assert.strictEqual(models.length, openrouterProfiles.length);

			const llama3Model = models.find(m => m.id === 'meta-llama/llama-3.3-70b-instruct:free');
			assert.ok(llama3Model);
			assert.strictEqual(llama3Model.available, true);
		});

		test('listModels throws authentication error on 401/403 status', async () => {
			const provider = new OpenRouterProvider(['invalid-key']);
			(global as any).fetch = async () => {
				return {
					ok: false,
					status: 403,
					statusText: 'Forbidden'
				} as any;
			};

			await assert.rejects(
				provider.listModels(),
				/Authentication failed \(401\/403\)\. Please verify your API key\./
			);
		});

		test('listModels falls back to static profiles on other failures', async () => {
			const provider = new OpenRouterProvider(['valid-key']);
			(global as any).fetch = async () => {
				return {
					ok: false,
					status: 500,
					statusText: 'Internal Server Error'
				} as any;
			};

			const models = await provider.listModels();
			const openrouterProfiles = MODEL_PROFILES.filter(m => m.provider === 'openrouter');
			assert.strictEqual(models.length, openrouterProfiles.length);
			assert.ok(models.every(m => m.available === true));
		});
	});

	suite('CerebrasProvider', () => {
		test('isConfigured should return true when keys are present and false otherwise', () => {
			const unconfigured = new CerebrasProvider([]);
			assert.strictEqual(unconfigured.isConfigured(), false);

			const configured = new CerebrasProvider(['test-key']);
			assert.strictEqual(configured.isConfigured(), true);
		});

		test('listModels returns empty array when not configured', async () => {
			const provider = new CerebrasProvider([]);
			const models = await provider.listModels();
			assert.deepStrictEqual(models, []);
		});

		test('listModels maps live models correctly and appends extra models returned by API', async () => {
			const provider = new CerebrasProvider(['valid-key']);
			(global as any).fetch = async (url: string) => {
				assert.ok(url.includes('cerebras.ai'));
				return {
					ok: true,
					json: async () => ({
						data: [
							{ id: 'llama3.1-8b' },
							{ id: 'newly-released-cerebras-model' }
						]
					})
				} as any;
			};

			const models = await provider.listModels();
			// should have all profiles in MODEL_PROFILES for cerebras + the one extra model
			const cerebrasProfiles = MODEL_PROFILES.filter(m => m.provider === 'cerebras');
			assert.strictEqual(models.length, cerebrasProfiles.length + 1);

			const normalModel = models.find(m => m.id === 'llama3.1-8b');
			assert.ok(normalModel);
			assert.strictEqual(normalModel.available, true);

			const extraModel = models.find(m => m.id === 'newly-released-cerebras-model');
			assert.ok(extraModel);
			assert.strictEqual(extraModel.available, true);
		});

		test('chat method logs correctly and forwards to base chat', async () => {
			const provider = new CerebrasProvider(['valid-key']);
			let chatInternalCalled = false;
			provider.chatInternal = async (modelId: string, messages: any, tools: any, context: any, options: any) => {
				chatInternalCalled = true;
				return { content: 'Cerebras custom reply' };
			};

			const result = await provider.chat('llama3.1-8b', [{ role: 'user', content: 'test' }]);
			assert.ok(chatInternalCalled);
			assert.strictEqual(result.content, 'Cerebras custom reply');
		});
	});

	suite('Router with only Nvidia configured', () => {
		test('should route to Nvidia when no Tier 1 providers are configured', async () => {
			const mockNvidiaProvider: any = {
				name: 'nvidia',
				isConfigured: () => true,
				getCooldownRemainingMs: () => 0,
				chat: async (modelId: string, messages: any, tools: any, context: any, options: any) => {
					return { content: 'Nvidia response!' };
				}
			};

			const mockGroqProvider: any = {
				name: 'groq',
				isConfigured: () => false,
				getCooldownRemainingMs: () => 0,
			};

			const router = new Router([mockGroqProvider, mockNvidiaProvider]);

			const recommendations: any[] = [
				{
					model: {
						id: 'llama-3.3-70b-versatile',
						provider: 'groq',
						contextLength: 128000,
					},
					rank: 1,
					reason: 'Tier 1'
				},
				{
					model: {
						id: 'nvidia/llama-3.1-405b',
						provider: 'nvidia',
						contextLength: 128000,
					},
					rank: 2,
					reason: 'Tier 2'
				}
			];

			const messages: any[] = [{ role: 'user', content: 'hello' }];

			const result = await router.route(recommendations, messages);
			assert.strictEqual(result.content, 'Nvidia response!');
		});
	});

	suite('AgentExecutor workspace search size check', () => {
		let originalFindFiles: any;
		let originalStat: any;
		let originalReadFile: any;

		setup(() => {
			originalFindFiles = vscode.workspace.findFiles;
			originalStat = fs.promises.stat;
			originalReadFile = fs.promises.readFile;
		});

		teardown(() => {
			vscode.workspace.findFiles = originalFindFiles;
			fs.promises.stat = originalStat;
			fs.promises.readFile = originalReadFile;
		});

		test('searchWorkspace should skip files larger than 1MB', async () => {
			// Mock finding two files: small.txt (500 bytes) and large.txt (2MB)
			vscode.workspace.findFiles = async () => {
				return [
					vscode.Uri.file('/mock/workspace/small.txt'),
					vscode.Uri.file('/mock/workspace/large.txt')
				];
			};

			// Mock fs.promises.stat
			fs.promises.stat = (async (filePath: any) => {
				const p = filePath.toString();
				if (p.includes('small.txt')) {
					return { size: 500 } as any;
				} else if (p.includes('large.txt')) {
					return { size: 2 * 1024 * 1024 } as any;
				}
				throw new Error('File not found');
			}) as any;

			// Mock fs.promises.readFile
			const readFiles: string[] = [];
			fs.promises.readFile = (async (filePath: any) => {
				const p = filePath.toString();
				readFiles.push(p);
				if (p.includes('small.txt')) {
					return 'This is matching_secret content in small file';
				} else if (p.includes('large.txt')) {
					return 'This is matching_secret content in large file';
				}
				throw new Error('File not found');
			}) as any;

			// Invoke the tool via AgentExecutor.execute
			const result = await AgentExecutor.execute('search_workspace', { query: 'matching_secret' }, '.');

			// Assertions
			// 1. It should only read the small file
			assert.ok(readFiles.some(f => f.includes('small.txt')));
			assert.ok(!readFiles.some(f => f.includes('large.txt')));

			// 2. The result content should contain the line match from the small file
			assert.ok(result.result.includes('small.txt'));
			assert.ok(!result.result.includes('large.txt'));
		});
	});
});

