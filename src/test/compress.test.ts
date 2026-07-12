import * as assert from 'assert';
import * as vscode from 'vscode';
import { compressCode } from '../engine/chatHelpers';

suite('ModelPilot Context Compression Engine Tests', () => {

	test('compressCode should strip C-style single and multi-line comments', () => {
		const originalCode = `
// This is a single line comment
function test() {
	/* Multi-line comment
	   goes here */
	console.log("hello"); // Inline comment
	const url = "http://example.com"; // Should keep URLs
}
`;
		const compressed = compressCode(originalCode);
		assert.ok(!compressed.includes('This is a single line comment'));
		assert.ok(!compressed.includes('Multi-line comment'));
		assert.ok(!compressed.includes('Inline comment'));
		assert.ok(compressed.includes('function test()'));
		assert.ok(compressed.includes('console.log("hello");'));
		assert.ok(compressed.includes('const url = "http://example.com";'));
	});

	test('compressCode should strip Python comments and triple-quoted docstrings', () => {
		const originalCode = `#!/usr/bin/env python
# Script shebang should be preserved above
"""
Module level docstring
"""
def add(a, b):
    # Add two numbers
    '''
    Function docstring
    '''
    return a + b # return value
`;
		const compressed = compressCode(originalCode, 'python');
		assert.ok(compressed.startsWith('#!/usr/bin/env python'));
		assert.ok(!compressed.includes('Module level docstring'));
		assert.ok(!compressed.includes('Add two numbers'));
		assert.ok(!compressed.includes('Function docstring'));
		assert.ok(!compressed.includes('return value'));
		assert.ok(compressed.includes('def add(a, b):'));
		assert.ok(compressed.includes('return a + b'));
	});

	test('compressCode should reduce consecutive empty lines and trailing spaces', () => {
		const originalCode = `
const a = 1;     



const b = 2;   
`;
		const compressed = compressCode(originalCode);
		const expected = `const a = 1;\n\nconst b = 2;`;
		assert.strictEqual(compressed, expected);
	});

	test('compressActiveFile command execution', async () => {
		const mockDocument = {
			getText: () => `// Test comment\nconst val = 123;`,
			languageId: 'typescript'
		};

		const mockEditor: any = {
			document: mockDocument
		};

		const originalWindowDescriptor = Object.getOwnPropertyDescriptor(vscode.window, 'activeTextEditor')
			|| Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vscode.window), 'activeTextEditor');

		Object.defineProperty(vscode.window, 'activeTextEditor', {
			get: () => mockEditor,
			configurable: true
		});

		let clipboardText = '';
		const originalClipboard = vscode.env.clipboard;
		const mockClipboard = {
			writeText: async (text: string) => {
				clipboardText = text;
			},
			readText: originalClipboard.readText
		};
		const originalEnvDescriptor = Object.getOwnPropertyDescriptor(vscode.env, 'clipboard')
			|| Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vscode.env), 'clipboard');

		Object.defineProperty(vscode.env, 'clipboard', {
			get: () => mockClipboard,
			configurable: true
		});

		let infoMessage = '';
		const originalShowInfo = vscode.window.showInformationMessage;
		(vscode.window as any).showInformationMessage = async (msg: string) => {
			infoMessage = msg;
			return undefined as any;
		};

		try {
			await vscode.commands.executeCommand('modelpilot.compressActiveFile');
			assert.strictEqual(clipboardText.trim(), 'const val = 123;');
			assert.ok(infoMessage.includes('Active file compressed'));
			assert.ok(infoMessage.includes('Copied to clipboard'));
		} finally {
			if (originalWindowDescriptor) {
				Object.defineProperty(vscode.window, 'activeTextEditor', originalWindowDescriptor);
			}
			if (originalEnvDescriptor) {
				Object.defineProperty(vscode.env, 'clipboard', originalEnvDescriptor);
			}
			vscode.window.showInformationMessage = originalShowInfo;
		}
	});
});
