import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('ModelPilot: New Chat command should be registered', async () => {
		const ext = vscode.extensions.getExtension('A-man-Sharma-04.modelpilot');
		if (ext) {
			await ext.activate();
		}
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('modelpilot.newChat'), 'newChat command must be registered');
	});

	test('ModelPilot: Inline action commands should be registered', async () => {
		const ext = vscode.extensions.getExtension('A-man-Sharma-04.modelpilot');
		if (ext) {
			await ext.activate();
		}
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('modelpilot.explainCode'), 'explainCode command must be registered');
		assert.ok(commands.includes('modelpilot.fixCode'), 'fixCode command must be registered');
		assert.ok(commands.includes('modelpilot.reviewCode'), 'reviewCode command must be registered');
		assert.ok(commands.includes('modelpilot.generateTests'), 'generateTests command must be registered');
	});
});
