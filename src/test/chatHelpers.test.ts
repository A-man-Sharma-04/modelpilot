import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import {
	isGreetingOrChitchat,
	checkIfCommandIsOutOfWorkspace,
	cleanJsonString,
	extractJsonObjects,
	cleanToolCallTags,
	parseTextToolCalls,
	getSafeStreamLength
} from '../engine/chatHelpers';

suite('ModelPilot Chat Helpers Unit Tests', () => {

	suite('isGreetingOrChitchat', () => {
		test('should identify exact greetings and friendly expressions', () => {
			assert.strictEqual(isGreetingOrChitchat('hi'), true);
			assert.strictEqual(isGreetingOrChitchat('hello'), true);
			assert.strictEqual(isGreetingOrChitchat('yo there'), true);
			assert.strictEqual(isGreetingOrChitchat('how are you doing today buddy'), true);
			assert.strictEqual(isGreetingOrChitchat('hooray!!! great work'), true);
			assert.strictEqual(isGreetingOrChitchat('thanks'), true);
			assert.strictEqual(isGreetingOrChitchat('thank you'), true);
			assert.strictEqual(isGreetingOrChitchat('great job'), true);
			assert.strictEqual(isGreetingOrChitchat('awesome work'), true);
			assert.strictEqual(isGreetingOrChitchat('congrats!'), true);
			assert.strictEqual(isGreetingOrChitchat('nice'), true);
			assert.strictEqual(isGreetingOrChitchat('amazing!'), true);
			assert.strictEqual(isGreetingOrChitchat('perfect'), true);
		});

		test('should identify general questions that do not mention workspace/coding terms', () => {
			assert.strictEqual(isGreetingOrChitchat('what is the speed of light'), true);
			assert.strictEqual(isGreetingOrChitchat('explain photosynthesis in simple terms'), true);
			assert.strictEqual(isGreetingOrChitchat('who is isaac newton'), true);
		});

		test('should reject coding or workspace-related queries', () => {
			assert.strictEqual(isGreetingOrChitchat('write a python prime checker function'), false);
			assert.strictEqual(isGreetingOrChitchat('how to debug an error in extension.ts'), false);
			assert.strictEqual(isGreetingOrChitchat('list files in the current folder'), false);
			assert.strictEqual(isGreetingOrChitchat('run terminal build command'), false);
		});
	});

	suite('checkIfCommandIsOutOfWorkspace', () => {
		test('should allow safe commands within the workspace context', () => {
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('npm install', '.'), false);
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('git commit -m "fix tests"', '.'), false);
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('node src/index.js', '.'), false);
		});

		test('should flag commands accessing absolute paths outside workspace', () => {
			// In test context, getWorkspaceRoot() resolves to either a workspace folder or os.homedir().
			// Absolute paths pointing to system folders (/etc, /var, etc.) should traverse outside it.
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cat /etc/passwd', '.'), true);
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('ls /var/log', '.'), true);
		});

		test('should flag commands using relative upward traversals', () => {
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cat ../../outside.txt', '.'), true);
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cd subfolder/../../', '.'), true);
		});

		test('should allow safe traversals from subfolders', () => {
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cd ..', 'subfolder'), false);
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cd ../', 'subfolder/src'), false);
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cat ../package.json', 'subfolder'), false);
		});

		test('should flag relative traversals from subfolders that escape workspace root', () => {
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cd ../..', 'subfolder'), true);
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cat ../../outside.txt', 'subfolder'), true);
		});

		test('should flag commands using home directory shortcuts or env variables', () => {
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('cat ~/Downloads/notes.txt', '.'), true);
			assert.strictEqual(checkIfCommandIsOutOfWorkspace('ls $HOME/somefile', '.'), true);
		});
	});

	suite('cleanJsonString', () => {
		test('should strip markdown code block formatting wrappers', () => {
			const rawJson = '```json\n{"foo": "bar"}\n```';
			assert.strictEqual(cleanJsonString(rawJson), '{"foo": "bar"}');
		});

		test('should return trimmed raw JSON directly when not wrapped', () => {
			assert.strictEqual(cleanJsonString('  {"a": 1}  '), '{"a": 1}');
		});
	});

	suite('extractJsonObjects', () => {
		test('should extract valid JSON objects from conversational text blocks', () => {
			const text = 'Here is the configuration: {"host": "localhost", "port": 80} and some extra text.';
			const extracted = extractJsonObjects(text);
			assert.strictEqual(extracted.length, 1);
			assert.strictEqual(extracted[0].host, 'localhost');
			assert.strictEqual(extracted[0].port, 80);
		});

		test('should skip malformed JSON blocks and extract other valid ones', () => {
			const text = 'Invalid: {"a": 1,} Valid: {"b": 2}';
			const extracted = extractJsonObjects(text);
			assert.strictEqual(extracted.length, 1);
			assert.strictEqual(extracted[0].b, 2);
		});
	});

	suite('cleanToolCallTags', () => {
		test('should strip XML tool tags completely from response text', () => {
			const input = 'I have read the file.\n<use_tool><name>read_file</name><arguments>{"path": "package.json"}</arguments></use_tool>\nHope this helps!';
			const expected = 'I have read the file.\n\nHope this helps!';
			assert.strictEqual(cleanToolCallTags(input), expected);
		});

		test('should strip unclosed XML tool tags at the end of text', () => {
			const input = 'Let me modify this file.<use_tool><name>write_file</name>';
			assert.strictEqual(cleanToolCallTags(input), 'Let me modify this file.');
		});

		test('should preserve conversational references to the word "tool"', () => {
			const input = 'I will use the read_file tool to read this code.';
			assert.strictEqual(cleanToolCallTags(input), input);
		});
	});

	suite('parseTextToolCalls', () => {
		test('should parse XML use_tool tags into ToolCall objects', () => {
			const input = '<use_tool><name>read_file</name><arguments>{"path": "src/extension.ts"}</arguments></use_tool>';
			const calls = parseTextToolCalls(input);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].function.name, 'read_file');
			const parsedArgs = JSON.parse(calls[0].function.arguments);
			assert.strictEqual(parsedArgs.path, 'src/extension.ts');
		});

		test('should fall back to known tool names if name tag is missing', () => {
			const input = '<use_tool>using read_file with <arguments>{"path": "src/extension.ts"}</arguments></use_tool>';
			const calls = parseTextToolCalls(input);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].function.name, 'read_file');
		});

		test('should fall back to raw args parsing if JSON in arguments is malformed', () => {
			const input = '<use_tool><name>run_terminal_command</name><arguments>ls -la && echo "hello"</arguments></use_tool>';
			const calls = parseTextToolCalls(input);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].function.name, 'run_terminal_command');
			const parsedArgs = JSON.parse(calls[0].function.arguments);
			assert.strictEqual(parsedArgs.command, 'ls -la && echo "hello"');
		});

		test('should parse raw JSON-based tool calls in messages', () => {
			const input = 'I will execute: {"name": "list_directory", "arguments": {"path": "src"}}';
			const calls = parseTextToolCalls(input);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].function.name, 'list_directory');
			const parsedArgs = JSON.parse(calls[0].function.arguments);
			assert.strictEqual(parsedArgs.path, 'src');
		});

		test('should fallback and parse malformed/truncated create_file arguments smartly', () => {
			const input = '<use_tool><name>create_file</name><arguments>{"path": "pink-theme.json", "content": "{\\n  \\"colors\\": {\\n    \\"editor.background\\": \\"#2d0a1a\\"\\n  }\\n"</arguments></use_tool>';
			const calls = parseTextToolCalls(input);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].function.name, 'create_file');
			const parsedArgs = JSON.parse(calls[0].function.arguments);
			assert.strictEqual(parsedArgs.path, 'pink-theme.json');
			assert.ok(parsedArgs.content.includes('#2d0a1a'), 'Should successfully extract content containing background hex');
		});

		test('should correctly parse write_file arguments containing nested JSON object with escaped and unescaped curly braces without truncation', () => {
			const input = '<use_tool><name>write_file</name><arguments>{"path": "theme.json", "content": "{\\n  \\"colors\\": {\\n    \\"editor.background\\": \\"#2d0a1a\\"\\n  }\\n}"}</arguments></use_tool>';
			const calls = parseTextToolCalls(input);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].function.name, 'write_file');
			const parsedArgs = JSON.parse(calls[0].function.arguments);
			assert.strictEqual(parsedArgs.path, 'theme.json');
			assert.strictEqual(parsedArgs.content, '{\n  "colors": {\n    "editor.background": "#2d0a1a"\n  }\n}');
		});

		test('should parse raw unquoted arguments for run_terminal_command', () => {
			const input = '<use_tool><name>run_terminal_command</name><arguments>{"command": last -a | grep ~/Music}</arguments></use_tool>';
			const calls = parseTextToolCalls(input);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].function.name, 'run_terminal_command');
			const parsedArgs = JSON.parse(calls[0].function.arguments);
			assert.strictEqual(parsedArgs.command, 'last -a | grep ~/Music');
		});

		test('should handle completely truncated JSON in create_file content gracefully', () => {
			const input = '<use_tool><name>create_file</name><arguments>{"path": "package.json", "content": "{\\n  \\"name\\": \\"pink-theme\\",\\n';
			const calls = parseTextToolCalls(input);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].function.name, 'create_file');
			const parsedArgs = JSON.parse(calls[0].function.arguments);
			assert.strictEqual(parsedArgs.path, 'package.json');
			assert.strictEqual(parsedArgs.content, '{\n  "name": "pink-theme",\n');
		});
	});

	suite('getSafeStreamLength', () => {
		test('should return full length when no tool tag start is present', () => {
			const input = 'Sure, here is the explanation for your Prime number checker...';
			assert.strictEqual(getSafeStreamLength(input), input.length);
		});

		test('should return length up to the start of a tool tag when present', () => {
			const input = 'Sure, I will read the file. <use_tool><name>read_file</name>';
			const expectedIndex = input.indexOf('<use_tool');
			assert.strictEqual(getSafeStreamLength(input), expectedIndex);
		});

		test('should halt streaming on partial tag prefix at the end of the chunk', () => {
			const input = 'Here is the command <use';
			const expectedIndex = input.indexOf('<use');
			assert.strictEqual(getSafeStreamLength(input), expectedIndex);
		});

		test('should not halt streaming on unrelated angle brackets', () => {
			const input = 'If the value of x < 10 then print it.';
			assert.strictEqual(getSafeStreamLength(input), input.length);
		});
	});

	suite('Token Budgeting & Semantic Chunking Tests', () => {
		const { estimateTokens, estimateMessagesTokens, semanticChunk, fitMessagesToContext } = require('../engine/TaskDecomposer');
		const { buildWorkspaceContext } = require('../participant/systemPrompt');

		test('should estimate tokens correctly (char count / 4)', () => {
			assert.strictEqual(estimateTokens('12345678'), 2);
			assert.strictEqual(estimateTokens(''), 0);
		});

		test('should estimate messages array tokens correctly', () => {
			const msgs = [
				{ role: 'system', content: 'system instructions' },
				{ role: 'user', content: 'hello world' }
			];
			// 'system instructions' is 19 chars -> 5 tokens + 4 = 9 tokens
			// 'hello world' is 11 chars -> 3 tokens + 4 = 7 tokens
			// total = 16 tokens
			assert.strictEqual(estimateMessagesTokens(msgs), 16);
		});

		test('should split text semantically at boundary markers', () => {
			const text = [
				'class TestClass {',
				'  constructor() {}',
				'}',
				'function testFunc() {',
				'  console.log("hello");',
				'}'
			].join('\n');

			// Split with tiny max token threshold (e.g. 5 tokens = 20 chars max)
			const chunks = semanticChunk(text, 5);
			assert.ok(chunks.length > 1);
			assert.ok(chunks.some((c: string) => c.includes('class TestClass')));
			assert.ok(chunks.some((c: string) => c.includes('function testFunc')));
		});

		test('should fit messages to provider context window limits', () => {
			const messages = [
				{ role: 'system', content: 'system prompt' },
				{ role: 'user', content: 'x'.repeat(25000) }, // ~6250 tokens, exceeds 6000 limit
				{ role: 'user', content: 'latest user question' }
			];

			// Small available limit (e.g. 10 tokens / 40 chars total budget)
			// system prompt = 13 chars (4 tokens)
			// latest user question = 20 chars (5 tokens)
			// total systemPromptTokens = 4
			const fitted = fitMessagesToContext(messages, 'groq', 4);
			assert.strictEqual(fitted.length, 2);
			assert.strictEqual(fitted[0].role, 'system');
			assert.strictEqual(fitted[1].content, 'latest user question');
		});

		test('should build workspace context string correctly', () => {
			const ctxStr = buildWorkspaceContext({
				os: 'Kali Linux',
				shell: '/bin/zsh',
				platform: 'linux',
				projectStack: ['Node.js', 'TypeScript'],
				activeFile: 'src/extension.ts',
				activeLanguage: 'typescript',
				workspaceName: 'modelpilot'
			});

			assert.ok(ctxStr.includes('OS: Kali Linux'));
			assert.ok(ctxStr.includes('Shell: /bin/zsh'));
			assert.ok(ctxStr.includes('Stack detected: Node.js, TypeScript'));
			assert.ok(ctxStr.includes('Active file: src/extension.ts'));
		});
	});
});
