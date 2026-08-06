import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class SearchPanel {
	public static currentPanel: SearchPanel | undefined;
	private static readonly viewType = 'modelpilot.search';

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (SearchPanel.currentPanel) {
			SearchPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			SearchPanel.viewType,
			'ModelPilot: Code Search & Indexer',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
				retainContextWhenHidden: true,
			}
		);

		SearchPanel.currentPanel = new SearchPanel(panel, extensionUri);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this.panel = panel;
		this.extensionUri = extensionUri;

		this.updateHtml();

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case 'search':
						await this.executeSearch(message.query, message.extension);
						break;
					case 'openFile':
						await this.openFileAtLine(message.filePath, message.line);
						break;
				}
			},
			null,
			this.disposables
		);
	}

	private async executeSearch(query: string, extensionFilter: string) {
		if (!query || query.trim() === '') {
			this.panel.webview.postMessage({ command: 'results', results: [] });
			return;
		}

		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			this.panel.webview.postMessage({
				command: 'results',
				results: [],
				error: 'No active workspace folders open.'
			});
			return;
		}

		const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const globPattern = extensionFilter && extensionFilter !== '*' ? `**/*${extensionFilter}` : '**/*';
		
		try {
			const files = await vscode.workspace.findFiles(
				globPattern,
				'{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/.git/**,**/.vscode-test/**,**/.next/**,**/coverage/**}'
			);

			const results: any[] = [];
			const lowercaseQuery = query.toLowerCase();

			for (const file of files) {
				try {
					const stat = await fs.promises.stat(file.fsPath);
					if (stat.size > 1024 * 1024) {
						continue; // skip large files (>1MB)
					}

					const content = await fs.promises.readFile(file.fsPath, 'utf8');
					if (content.toLowerCase().includes(lowercaseQuery)) {
						const lines = content.split(/\r?\n/);
						const fileMatches: any[] = [];

						lines.forEach((line, index) => {
							if (line.toLowerCase().includes(lowercaseQuery)) {
								fileMatches.push({
									line: index + 1,
									text: line.trim()
								});
							}
						});

						if (fileMatches.length > 0) {
							results.push({
								filename: path.basename(file.fsPath),
								relativepath: path.relative(root, file.fsPath),
								filepath: file.fsPath,
								matches: fileMatches
							});
						}
					}
				} catch {
					// Ignore binary or unreadable files
				}

				if (results.length >= 100) {
					break; // limit to 100 files to prevent lag
				}
			}

			this.panel.webview.postMessage({ command: 'results', results });
		} catch (err: any) {
			this.panel.webview.postMessage({
				command: 'results',
				results: [],
				error: err.message || String(err)
			});
		}
	}

	private async openFileAtLine(filePath: string, lineNumber: number) {
		try {
			const doc = await vscode.workspace.openTextDocument(filePath);
			const editor = await vscode.window.showTextDocument(doc);
			const pos = new vscode.Position(lineNumber - 1, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
		} catch (err: any) {
			vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
		}
	}

	private updateHtml() {
		this.panel.webview.html = this.getHtmlForWebview();
	}

	private getHtmlForWebview(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>ModelPilot Code Search & Indexer</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
	<style>
		:root {
			--bg-primary: #0b0f19;
			--bg-card: rgba(17, 24, 39, 0.7);
			--border-color: rgba(255, 255, 255, 0.08);
			--text-primary: #f3f4f6;
			--text-secondary: #9ca3af;
			--accent-primary: #06b6d4;
			--accent-secondary: #3b82f6;
			--success: #10b981;
			--danger: #ef4444;
		}

		body {
			background-color: var(--bg-primary);
			color: var(--text-primary);
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			margin: 0;
			padding: 24px;
			display: flex;
			flex-direction: column;
			align-items: center;
			min-height: 100vh;
			box-sizing: border-box;
		}

		.container {
			max-width: 1000px;
			width: 100%;
			display: flex;
			flex-direction: column;
			gap: 24px;
		}

		.header-card {
			background: radial-gradient(circle at 10% 20%, rgba(6, 182, 212, 0.1) 0%, rgba(59, 130, 246, 0.05) 90%), var(--bg-card);
			border: 1px solid var(--border-color);
			backdrop-filter: blur(12px);
			border-radius: 20px;
			padding: 28px;
			text-align: center;
			box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
		}

		.header-title {
			font-size: 1.75rem;
			font-weight: 700;
			margin: 0 0 8px 0;
			background: linear-gradient(135deg, #06b6d4, #3b82f6);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
		}

		.header-subtitle {
			color: var(--text-secondary);
			font-size: 0.95rem;
			margin: 0;
		}

		.search-box {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 16px;
			padding: 24px;
			display: flex;
			flex-direction: column;
			gap: 16px;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
		}

		.inputs-row {
			display: grid;
			grid-template-columns: 3fr 1fr;
			gap: 16px;
		}

		@media (max-width: 600px) {
			.inputs-row {
				grid-template-columns: 1fr;
			}
		}

		.input-group {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		label {
			font-size: 0.85rem;
			font-weight: 500;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		input, select {
			background: rgba(15, 23, 42, 0.6);
			border: 1px solid var(--border-color);
			border-radius: 8px;
			color: var(--text-primary);
			padding: 10px 14px;
			font-family: inherit;
			font-size: 0.95rem;
			outline: none;
			transition: border-color 0.2s, box-shadow 0.2s;
		}

		input:focus, select:focus {
			border-color: var(--accent-primary);
			box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.15);
		}

		.btn-search {
			background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
			color: white;
			border: none;
			padding: 12px 24px;
			border-radius: 8px;
			font-weight: 600;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 8px;
			box-shadow: 0 4px 12px rgba(6, 182, 212, 0.3);
			transition: all 0.2s;
		}

		.btn-search:hover {
			filter: brightness(1.1);
			transform: translateY(-1px);
		}

		.btn-search:active {
			transform: translateY(0);
		}

		.btn-search:disabled {
			background: #4b5563;
			cursor: not-allowed;
			box-shadow: none;
			transform: none;
		}

		.results-container {
			display: flex;
			flex-direction: column;
			gap: 16px;
		}

		.result-card {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 12px;
			padding: 16px;
			display: flex;
			flex-direction: column;
			gap: 12px;
			box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
		}

		.result-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			border-bottom: 1px solid var(--border-color);
			padding-bottom: 8px;
		}

		.file-info {
			display: flex;
			flex-direction: column;
			gap: 2px;
		}

		.filename {
			font-weight: 600;
			font-size: 1.05rem;
			color: var(--accent-primary);
		}

		.filepath {
			font-size: 0.8rem;
			color: var(--text-secondary);
		}

		.matches-list {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.match-item {
			background: rgba(0, 0, 0, 0.2);
			border: 1px solid var(--border-color);
			border-radius: 6px;
			padding: 8px 12px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 16px;
			cursor: pointer;
			transition: background-color 0.2s;
		}

		.match-item:hover {
			background: rgba(255, 255, 255, 0.03);
		}

		.match-content {
			font-family: 'Consolas', 'Courier New', monospace;
			font-size: 0.85rem;
			color: var(--text-primary);
			white-space: pre-wrap;
			word-break: break-all;
			flex-grow: 1;
		}

		.match-line {
			color: var(--text-secondary);
			font-size: 0.75rem;
			font-weight: 600;
			min-width: 60px;
		}

		.btn-open {
			background: transparent;
			border: 1px solid var(--accent-primary);
			color: var(--accent-primary);
			padding: 4px 10px;
			border-radius: 4px;
			font-size: 0.75rem;
			cursor: pointer;
			font-weight: 500;
			transition: all 0.2s;
		}

		.btn-open:hover {
			background: var(--accent-primary);
			color: #ffffff;
		}

		.no-results {
			text-align: center;
			padding: 40px;
			color: var(--text-secondary);
		}

		.highlight {
			background-color: rgba(6, 182, 212, 0.3);
			border-radius: 2px;
			padding: 0 2px;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header-card">
			<h2 class="header-title">Code Search & Indexer</h2>
			<p class="header-subtitle">Find occurrences of functions, variables, or patterns instantly across your workspace.</p>
		</div>

		<div class="search-box">
			<div class="inputs-row">
				<div class="input-group">
					<label for="search-input">Search Query</label>
					<input type="text" id="search-input" placeholder="Type function name, variable name, or imports..." onkeydown="handleKey(event)">
				</div>
				<div class="input-group">
					<label for="extension-select">File Filter</label>
					<select id="extension-select">
						<option value="*">All Files</option>
						<option value=".ts">TypeScript (.ts)</option>
						<option value=".js">JavaScript (.js)</option>
						<option value=".py">Python (.py)</option>
						<option value=".json">JSON (.json)</option>
						<option value=".css">CSS (.css)</option>
					</select>
				</div>
			</div>

			<button class="btn-search" id="btn-search" onclick="runSearch()">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
				Search Workspace
			</button>
		</div>

		<div class="results-container" id="results-list">
			<div class="no-results">Enter a query above to start searching.</div>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		function escapeHtml(s) {
			return String(s).replace(/[&<>"']/g, function (c) {
				return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
			});
		}

		function attrJsString(s) {
			return String(s)
				.replace(/&/g, '&amp;')
				.replace(/"/g, '&quot;')
				.replace(/[\\r\\n]+/g, ' ')
				.replace(/\\\\/g, '\\\\\\\\')
				.replace(/'/g, "\\\\'");
		}

		function handleKey(e) {
			if (e.key === 'Enter') {
				runSearch();
			}
		}

		function runSearch() {
			const query = document.getElementById('search-input').value.trim();
			const ext = document.getElementById('extension-select').value;

			if (!query) {
				return;
			}

			document.getElementById('btn-search').disabled = true;
			document.getElementById('results-list').innerHTML = '<div class="no-results">Searching workspace...</div>';

			vscode.postMessage({
				command: 'search',
				query,
				extension: ext
			});
		}

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.command === 'results') {
				document.getElementById('btn-search').disabled = false;
				const list = document.getElementById('results-list');

				if (message.error) {
					list.innerHTML = '<div class="no-results" style="color: var(--danger)">Error: ' + escapeHtml(message.error) + '</div>';
					return;
				}

				if (message.results.length === 0) {
					list.innerHTML = '<div class="no-results">No matching query results found.</div>';
					return;
				}

				const query = document.getElementById('search-input').value.trim();
				const escapedQuery = escapeHtml(query).replace(/[-\\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
				const regex = new RegExp('(' + escapedQuery + ')', 'gi');

				let html = '';
				message.results.forEach(file => {
					html += '<div class="result-card">';
					html += '  <div class="result-header">';
					html += '    <div class="file-info">';
					html += '      <span class="filename">' + escapeHtml(file.filename) + '</span>';
					html += '      <span class="filepath">' + escapeHtml(file.relativepath) + '</span>';
					html += '    </div>';
					html += '  </div>';
					html += '  <div class="matches-list">';

					file.matches.forEach(m => {
						const highlighted = escapeHtml(m.text).replace(regex, '<span class="highlight">$1</span>');
						html += '    <div class="match-item" onclick="openFile(\\'' + attrJsString(file.filepath) + '\\', ' + m.line + ')">';
						html += '      <span class="match-line">Line ' + m.line + '</span>';
						html += '      <span class="match-content">' + highlighted + '</span>';
						html += '      <button class="btn-open">Open</button>';
						html += '    </div>';
					});

					html += '  </div>';
					html += '</div>';
				});

				list.innerHTML = html;
			}
		});

		function openFile(filePath, line) {
			vscode.postMessage({
				command: 'openFile',
				filePath,
				line
			});
		}
	</script>
</body>
</html>
`;
	}

	public dispose() {
		SearchPanel.currentPanel = undefined;

		this.panel.dispose();

		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}
}
