import * as vscode from 'vscode';
import { ModelRegistry } from '../registry/ModelRegistry';
import { IProvider } from '../providers/IProvider';
import { getModelProfile } from '../data/modelProfiles';

export class ModelArenaPanel {
	public static currentPanel: ModelArenaPanel | undefined;
	private static readonly viewType = 'modelpilot.arena';

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly registry: ModelRegistry;
	private readonly providers: IProvider[];
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(
		extensionUri: vscode.Uri,
		registry: ModelRegistry,
		providers: IProvider[]
	) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (ModelArenaPanel.currentPanel) {
			ModelArenaPanel.currentPanel.panel.reveal(column);
			ModelArenaPanel.currentPanel.refreshModelsList();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			ModelArenaPanel.viewType,
			'ModelPilot: Model Comparison Arena',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
				retainContextWhenHidden: true,
			}
		);

		ModelArenaPanel.currentPanel = new ModelArenaPanel(
			panel,
			extensionUri,
			registry,
			providers
		);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		registry: ModelRegistry,
		providers: IProvider[]
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.registry = registry;
		this.providers = providers;

		this.updateHtml();

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case 'getModels':
						this.refreshModelsList();
						break;
					case 'compare':
						await this.runComparison(
							message.prompt,
							message.modelA,
							message.modelB
						);
						break;
				}
			},
			null,
			this.disposables
		);
	}

	private refreshModelsList() {
		const availableModels = this.registry.getAvailable().map(m => ({
			id: m.id,
			provider: m.provider,
			displayName: m.displayName || m.id
		}));

		this.panel.webview.postMessage({
			command: 'loadModels',
			models: availableModels
		});
	}

	private async runComparison(
		prompt: string,
		modelA: { id: string; provider: string },
		modelB: { id: string; provider: string }
	) {
		const runSide = async (
			side: 'A' | 'B',
			modelInfo: { id: string; provider: string }
		) => {
			const provider = this.providers.find(p => p.name === modelInfo.provider);
			if (!provider) {
				this.panel.webview.postMessage({
					command: 'error',
					side,
					error: `Provider "${modelInfo.provider}" not configured or found.`
				});
				return;
			}

			const startTime = Date.now();
			let textBuffer = '';

			try {
				const result = await provider.chat(
					modelInfo.id,
					[{ role: 'user', content: prompt }],
					undefined,
					undefined,
					{
						stream: true,
						onChunk: (chunk) => {
							textBuffer += chunk;
							this.panel.webview.postMessage({
								command: 'chunk',
								side,
								text: chunk
							});
						}
					}
				);

				const latencyMs = Date.now() - startTime;
				const promptTokens = result.usage?.promptTokens ?? Math.ceil(prompt.length / 4);
				const completionTokens = result.usage?.completionTokens ?? Math.ceil(textBuffer.length / 4);
				
				const profile = getModelProfile(modelInfo.provider, modelInfo.id);
				let inputRate = profile?.inputPricePerM;
				let outputRate = profile?.outputPricePerM;
				if (inputRate === undefined || outputRate === undefined) {
					if (modelInfo.provider === 'nvidia' || modelInfo.provider === 'groq' || modelInfo.provider === 'cerebras') {
						inputRate = 0.70;
						outputRate = 0.90;
					} else {
						inputRate = 1.00;
						outputRate = 2.00;
					}
				}

				const isFree = ['nvidia', 'groq', 'cerebras', 'google'].includes(modelInfo.provider) || modelInfo.id.endsWith(':free');
				const cost = isFree ? 0.0 : ((promptTokens * inputRate) / 1000000.0 + (completionTokens * outputRate) / 1000000.0);

				this.panel.webview.postMessage({
					command: 'done',
					side,
					metrics: {
						latencyMs,
						promptTokens,
						completionTokens,
						totalTokens: promptTokens + completionTokens,
						cost: cost
					}
				});
			} catch (err: any) {
				this.panel.webview.postMessage({
					command: 'error',
					side,
					error: err.message || String(err)
				});
			}
		};

		// Run both completions concurrently
		await Promise.all([
			runSide('A', modelA),
			runSide('B', modelB)
		]);
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
	<title>ModelPilot Model Comparison Arena</title>
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
			--warning: #f59e0b;
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
			max-width: 1200px;
			width: 100%;
			display: flex;
			flex-direction: column;
			gap: 24px;
		}

		.dashboard-header {
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

		/* Setup Controls Card */
		.setup-card {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 16px;
			padding: 24px;
			display: flex;
			flex-direction: column;
			gap: 16px;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
		}

		.selectors-row {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 20px;
		}

		@media (max-width: 768px) {
			.selectors-row {
				grid-template-columns: 1fr;
			}
		}

		.selector-group {
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

		select, textarea {
			background: rgba(15, 23, 42, 0.6);
			border: 1px solid var(--border-color);
			border-radius: 8px;
			color: var(--text-primary);
			padding: 10px 14px;
			font-family: inherit;
			font-size: 0.9rem;
			outline: none;
			transition: border-color 0.2s, box-shadow 0.2s;
		}

		select:focus, textarea:focus {
			border-color: var(--accent-primary);
			box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.15);
		}

		textarea {
			resize: vertical;
			min-height: 80px;
		}

		.btn-compare {
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
			align-self: flex-end;
			box-shadow: 0 4px 12px rgba(6, 182, 212, 0.3);
			transition: all 0.2s;
		}

		.btn-compare:hover {
			filter: brightness(1.1);
			transform: translateY(-1px);
		}

		.btn-compare:active {
			transform: translateY(0);
		}

		.btn-compare:disabled {
			background: #4b5563;
			cursor: not-allowed;
			box-shadow: none;
			transform: none;
		}

		/* Arena Output Columns */
		.arena-row {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 24px;
		}

		@media (max-width: 768px) {
			.arena-row {
				grid-template-columns: 1fr;
			}
		}

		.arena-column {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 16px;
			padding: 24px;
			display: flex;
			flex-direction: column;
			gap: 16px;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
			min-height: 350px;
		}

		.column-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			border-bottom: 1px solid var(--border-color);
			padding-bottom: 12px;
		}

		.column-title {
			font-size: 1.15rem;
			font-weight: 600;
			margin: 0;
		}

		.badge-side {
			background: rgba(6, 182, 212, 0.1);
			color: var(--accent-primary);
			border: 1px solid rgba(6, 182, 212, 0.2);
			padding: 2px 8px;
			border-radius: 4px;
			font-size: 0.75rem;
			font-weight: 600;
		}

		.badge-side.b {
			background: rgba(59, 130, 246, 0.1);
			color: var(--accent-secondary);
			border: 1px solid rgba(59, 130, 246, 0.2);
		}

		.output-box {
			flex-grow: 1;
			background: rgba(0, 0, 0, 0.2);
			border: 1px solid var(--border-color);
			border-radius: 8px;
			padding: 16px;
			font-size: 0.95rem;
			line-height: 1.6;
			overflow-y: auto;
			white-space: pre-wrap;
			max-height: 400px;
			min-height: 200px;
		}

		.output-box.error {
			color: var(--danger);
			border-color: rgba(239, 68, 68, 0.3);
			background: rgba(239, 68, 68, 0.05);
		}

		/* Metrics Dashboard */
		.metrics-grid {
			display: grid;
			grid-template-columns: repeat(4, 1fr);
			gap: 12px;
			font-size: 0.85rem;
		}

		@media (max-width: 900px) {
			.metrics-grid {
				grid-template-columns: repeat(2, 1fr);
			}
		}

		.metric-card {
			background: rgba(255, 255, 255, 0.02);
			border: 1px solid var(--border-color);
			border-radius: 8px;
			padding: 10px;
			display: flex;
			flex-direction: column;
			align-items: center;
			text-align: center;
		}

		.metric-label {
			color: var(--text-secondary);
			font-size: 0.75rem;
			margin-bottom: 4px;
			text-transform: uppercase;
		}

		.metric-value {
			font-weight: 600;
			font-size: 1.1rem;
		}

		.metric-value.highlight {
			color: var(--success);
		}

		/* Pulse loader */
		.pulse-dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background-color: var(--accent-primary);
			display: inline-block;
			animation: pulse 1.5s infinite ease-in-out;
		}

		@keyframes pulse {
			0%, 100% { transform: scale(0.8); opacity: 0.5; }
			50% { transform: scale(1.2); opacity: 1; }
		}

		/* Accessibility */
		*:focus-visible {
			outline: 2px solid var(--accent-primary);
			outline-offset: 2px;
		}
		button:focus-visible, select:focus-visible, textarea:focus-visible {
			box-shadow: 0 0 0 4px rgba(6, 182, 212, 0.25);
		}
		@media (forced-colors: active) {
			:root {
				--bg-primary: Canvas;
				--bg-card: Canvas;
				--border-color: CanvasText;
				--text-primary: CanvasText;
				--text-secondary: CanvasText;
				--accent-primary: Highlight;
			}
			.setup-card, .results-card, .container {
				border: 1px solid CanvasText !important;
			}
			button, select {
				border: 1px solid ButtonText !important;
			}
		}
		@media (prefers-reduced-motion: reduce) {
			*, *::before, *::after {
				animation-duration: 0.01ms !important;
				transition-duration: 0.01ms !important;
			}
		}
	</style>
</head>
<body>
	<div class="container" role="main" aria-label="ModelPilot Model Comparison Arena">
		<div class="dashboard-header">
			<h2 class="header-title">Model Comparison Arena</h2>
			<p class="header-subtitle">Evaluate latency, token metrics, and cost savings of different models side-by-side in real-time.</p>
		</div>

		<div class="setup-card">
			<div class="selectors-row">
				<div class="selector-group">
					<label for="select-model-a">Model A</label>
					<select id="select-model-a">
						<option value="">Loading models...</option>
					</select>
				</div>
				<div class="selector-group">
					<label for="select-model-b">Model B</label>
					<select id="select-model-b">
						<option value="">Loading models...</option>
					</select>
				</div>
			</div>

			<div class="selector-group">
				<label for="prompt-input">Test Prompt</label>
				<textarea id="prompt-input" placeholder="Type a prompt to run side-by-side completions... e.g. Write a quicksort implementation in Python."></textarea>
			</div>

			<button class="btn-compare" id="btn-compare" onclick="startComparison()">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>
				Run Comparison
			</button>
		</div>

		<div class="arena-row">
			<!-- Side A Column -->
			<div class="arena-column" id="column-a">
				<div class="column-header">
					<h3 class="column-title" id="title-model-a">Model A</h3>
					<span class="badge-side">Side A</span>
				</div>
				<div class="output-box" id="output-a">Ready. Select models, type a prompt, and click Run.</div>
				
				<div class="metrics-grid">
					<div class="metric-card">
						<span class="metric-label">Latency</span>
						<span class="metric-value" id="latency-a">-</span>
					</div>
					<div class="metric-card">
						<span class="metric-label">Speed</span>
						<span class="metric-value" id="speed-a">-</span>
					</div>
					<div class="metric-card">
						<span class="metric-label">Tokens</span>
						<span class="metric-value" id="tokens-a">-</span>
					</div>
					<div class="metric-card">
						<span class="metric-label">Cost</span>
						<span class="metric-value" id="cost-a">-</span>
					</div>
				</div>
			</div>

			<!-- Side B Column -->
			<div class="arena-column" id="column-b">
				<div class="column-header">
					<h3 class="column-title" id="title-model-b">Model B</h3>
					<span class="badge-side b">Side B</span>
				</div>
				<div class="output-box" id="output-b">Ready. Select models, type a prompt, and click Run.</div>

				<div class="metrics-grid">
					<div class="metric-card">
						<span class="metric-label">Latency</span>
						<span class="metric-value" id="latency-b">-</span>
					</div>
					<div class="metric-card">
						<span class="metric-label">Speed</span>
						<span class="metric-value" id="speed-b">-</span>
					</div>
					<div class="metric-card">
						<span class="metric-label">Tokens</span>
						<span class="metric-value" id="tokens-b">-</span>
					</div>
					<div class="metric-card">
						<span class="metric-label">Cost</span>
						<span class="metric-value" id="cost-b">-</span>
					</div>
				</div>
			</div>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		let modelsCached = [];

		function escapeHtml(s) {
			return String(s).replace(/[&<>"']/g, function (c) {
				return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
			});
		}

		function startComparison() {
			const prompt = document.getElementById('prompt-input').value.trim();
			const selectA = document.getElementById('select-model-a');
			const selectB = document.getElementById('select-model-b');

			if (!prompt) {
				return;
			}

			const modelA = modelsCached[selectA.selectedIndex];
			const modelB = modelsCached[selectB.selectedIndex];

			if (!modelA || !modelB) {
				return;
			}

			// Clear previous states
			resetSide('a', modelA.displayName);
			resetSide('b', modelB.displayName);

			document.getElementById('btn-compare').disabled = true;

			vscode.postMessage({
				command: 'compare',
				prompt,
				modelA: { id: modelA.id, provider: modelA.provider },
				modelB: { id: modelB.id, provider: modelB.provider }
			});
		}

		function resetSide(side, displayName) {
			document.getElementById('title-model-' + side).innerText = displayName;
			const out = document.getElementById('output-' + side);
			out.innerText = '';
			out.className = 'output-box';

			document.getElementById('latency-' + side).innerText = 'Waiting...';
			document.getElementById('speed-' + side).innerText = '-';
			document.getElementById('tokens-' + side).innerText = '-';
			document.getElementById('cost-' + side).innerText = '-';
		}

		let activeStreams = { a: false, b: false };

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.command === 'loadModels') {
				modelsCached = message.models;
				const selectA = document.getElementById('select-model-a');
				const selectB = document.getElementById('select-model-b');

				let html = '';
				message.models.forEach((m, idx) => {
					const label = '[' + escapeHtml(m.provider).toUpperCase() + '] ' + escapeHtml(m.displayName);
					html += '<option value="' + idx + '">' + label + '</option>';
				});

				selectA.innerHTML = html;
				selectB.innerHTML = html;

				// Pre-select second model for side B if available
				if (message.models.length > 1) {
					selectB.selectedIndex = 1;
				}
			} else if (message.command === 'chunk') {
				const side = message.side.toLowerCase();
				const out = document.getElementById('output-' + side);
				out.innerText += message.text;
				out.scrollTop = out.scrollHeight;

				if (!activeStreams[side]) {
					activeStreams[side] = true;
					document.getElementById('latency-' + side).innerHTML = '<span class="pulse-dot"></span> Streaming';
				}
			} else if (message.command === 'done') {
				const side = message.side.toLowerCase();
				activeStreams[side] = false;
				
				const m = message.metrics;
				document.getElementById('latency-' + side).innerText = (m.latencyMs / 1000).toFixed(2) + 's';
				
				const tokensPerSec = m.completionTokens && m.latencyMs ? ((m.completionTokens / m.latencyMs) * 1000).toFixed(1) : 'N/A';
				document.getElementById('speed-' + side).innerText = tokensPerSec + ' t/s';
				
				document.getElementById('tokens-' + side).innerText = m.totalTokens.toLocaleString() + ' (' + m.completionTokens + ' out)';
				
				const costVal = m.cost === 0 ? 'Free ($0.00)' : '$' + m.cost.toFixed(4);
				document.getElementById('cost-' + side).innerText = costVal;

				checkAllDone();
			} else if (message.command === 'error') {
				const side = message.side.toLowerCase();
				activeStreams[side] = false;

				const out = document.getElementById('output-' + side);
				out.innerText = 'Error: ' + message.error;
				out.className = 'output-box error';

				document.getElementById('latency-' + side).innerText = 'Error';
				document.getElementById('speed-' + side).innerText = '-';
				document.getElementById('tokens-' + side).innerText = '-';
				document.getElementById('cost-' + side).innerText = '-';

				checkAllDone();
			}
		});

		function checkAllDone() {
			if (!activeStreams.a && !activeStreams.b) {
				document.getElementById('btn-compare').disabled = false;
				
				// Optional: highlight the winner in speed/latency or cost
				highlightMetrics();
			}
		}

		function highlightMetrics() {
			// Compare latency
			const latA = parseFloat(document.getElementById('latency-a').innerText);
			const latB = parseFloat(document.getElementById('latency-b').innerText);
			if (!isNaN(latA) && !isNaN(latB)) {
				if (latA < latB) {
					document.getElementById('latency-a').className = 'metric-value highlight';
				} else if (latB < latA) {
					document.getElementById('latency-b').className = 'metric-value highlight';
				}
			}

			// Compare speed (t/s)
			const spA = parseFloat(document.getElementById('speed-a').innerText);
			const spB = parseFloat(document.getElementById('speed-b').innerText);
			if (!isNaN(spA) && !isNaN(spB)) {
				if (spA > spB) {
					document.getElementById('speed-a').className = 'metric-value highlight';
				} else if (spB > spA) {
					document.getElementById('speed-b').className = 'metric-value highlight';
				}
			}
		}

		// Initial load
		vscode.postMessage({ command: 'getModels' });
	</script>
</body>
</html>
`;
	}

	public dispose() {
		ModelArenaPanel.currentPanel = undefined;

		this.panel.dispose();

		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}
}
