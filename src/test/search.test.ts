import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { SearchPanel } from '../webview/SearchPanel';

suite('ModelPilot Workspace Search Panel & Indexer Tests', () => {

	test('SearchPanel createOrShow should instantiate panel successfully', async () => {
		const mockWebview = {
			html: '',
			onDidReceiveMessage: new vscode.EventEmitter<any>().event,
			postMessage: async (msg: any) => {}
		};

		const mockPanel: any = {
			webview: mockWebview,
			onDidDispose: new vscode.EventEmitter<void>().event,
			reveal: () => {},
			dispose: () => {}
		};

		const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
		(vscode.window as any).createWebviewPanel = () => mockPanel;

		try {
			SearchPanel.createOrShow(vscode.Uri.file('/mock'));
			assert.ok(SearchPanel.currentPanel);
		} finally {
			vscode.window.createWebviewPanel = originalCreateWebviewPanel;
			if (SearchPanel.currentPanel) {
				SearchPanel.currentPanel.dispose();
			}
		}
	});

	test('executeSearch searches files and posts results back to webview', async () => {
		// Mock findFiles
		const originalFindFiles = vscode.workspace.findFiles;
		(vscode.workspace as any).findFiles = async () => {
			return [
				vscode.Uri.file('/workspace/test1.ts'),
				vscode.Uri.file('/workspace/test2.ts')
			];
		};

		// Mock stat and readFile
		const originalStat = fs.promises.stat;
		(fs.promises as any).stat = async (path: string) => {
			return { size: 100 } as any;
		};

		const originalReadFile = fs.promises.readFile;
		(fs.promises as any).readFile = async (path: string) => {
			if (path.includes('test1.ts')) {
				return 'export function foo() {\n\tconst a = 1;\n}';
			}
			return 'const b = 2;';
		};

		// Mock workspaceFolders safely using Object.defineProperty
		const originalWorkspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders')
			|| Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vscode.workspace), 'workspaceFolders');

		Object.defineProperty(vscode.workspace, 'workspaceFolders', {
			get: () => [
				{ uri: vscode.Uri.file('/workspace'), name: 'workspace', index: 0 }
			],
			configurable: true
		});

		let postedMessage: any = null;
		const mockWebview = {
			html: '',
			onDidReceiveMessage: new vscode.EventEmitter<any>().event,
			postMessage: async (msg: any) => {
				postedMessage = msg;
			}
		};

		const mockPanel: any = {
			webview: mockWebview,
			onDidDispose: new vscode.EventEmitter<void>().event,
			reveal: () => {},
			dispose: () => {}
		};

		const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
		(vscode.window as any).createWebviewPanel = () => mockPanel;

		try {
			SearchPanel.createOrShow(vscode.Uri.file('/mock'));
			const panelInstance = SearchPanel.currentPanel as any;
			await panelInstance.executeSearch('foo', '*');

			assert.ok(postedMessage);
			assert.strictEqual(postedMessage.command, 'results');
			assert.strictEqual(postedMessage.results.length, 1);
			assert.strictEqual(postedMessage.results[0].filename, 'test1.ts');
			assert.strictEqual(postedMessage.results[0].matches.length, 1);
			assert.strictEqual(postedMessage.results[0].matches[0].line, 1);
			assert.strictEqual(postedMessage.results[0].matches[0].text, 'export function foo() {');
		} finally {
			vscode.window.createWebviewPanel = originalCreateWebviewPanel;
			(vscode.workspace as any).findFiles = originalFindFiles;
			fs.promises.stat = originalStat;
			fs.promises.readFile = originalReadFile;
			if (originalWorkspaceFoldersDescriptor) {
				Object.defineProperty(vscode.workspace, 'workspaceFolders', originalWorkspaceFoldersDescriptor);
			}
			if (SearchPanel.currentPanel) {
				SearchPanel.currentPanel.dispose();
			}
		}
	});
});
