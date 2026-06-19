import * as vscode from 'vscode';
import { AnalyticsManager } from '../engine/AnalyticsManager';
import { SecretsManager, ProviderName } from '../secrets';
import { OpenAICompatibleProvider } from '../providers/OpenAICompatibleProvider';

export class AnalyticsPanel {
	public static currentPanel: AnalyticsPanel | undefined;
	private static readonly viewType = 'modelpilot.analytics';

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly analyticsManager: AnalyticsManager;
	private readonly secretsManager: SecretsManager;
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(
		extensionUri: vscode.Uri,
		analyticsManager: AnalyticsManager,
		secretsManager: SecretsManager,
	) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (AnalyticsPanel.currentPanel) {
			AnalyticsPanel.currentPanel.panel.reveal(column);
			AnalyticsPanel.currentPanel.refresh();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			AnalyticsPanel.viewType,
			'ModelPilot: Token & Cost Analytics',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
				retainContextWhenHidden: true,
			}
		);

		AnalyticsPanel.currentPanel = new AnalyticsPanel(
			panel,
			extensionUri,
			analyticsManager,
			secretsManager
		);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		analyticsManager: AnalyticsManager,
		secretsManager: SecretsManager,
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.analyticsManager = analyticsManager;
		this.secretsManager = secretsManager;

		// Set initial HTML
		this.updateHtml();

		// Listen for panel closure
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		// Handle messages from the webview
		this.panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case 'reset':
						const choice = await vscode.window.showWarningMessage(
							'Are you sure you want to reset all token usage and cost analytics?',
							{ modal: true },
							'Reset',
							'Cancel'
						);
						if (choice === 'Reset') {
							await this.analyticsManager.reset();
							this.refresh();
							vscode.window.showInformationMessage('ModelPilot analytics reset successfully.');
						}
						break;
					case 'refresh':
						this.refresh();
						break;
					case 'exportFineTuning':
						try {
							const ftData = this.analyticsManager.getData();
							if (!ftData.fineTuningData || ftData.fineTuningData.length === 0) {
								vscode.window.showWarningMessage('No successful chats recorded yet to export for fine-tuning.');
								break;
							}

							const saveUri = await vscode.window.showSaveDialog({
								title: 'Export Fine-Tuning Data (JSONL)',
								defaultUri: vscode.Uri.file('modelpilot-finetuning.jsonl'),
								filters: {
									'JSON Lines': ['jsonl']
								}
							});

							if (saveUri) {
								const lines: string[] = [];
								for (const record of ftData.fineTuningData) {
									const formattedMsgs = record.messages.map(m => ({
										role: m.role,
										content: m.content
									}));
									
									formattedMsgs.push({
										role: 'assistant',
										content: record.response
									});

									lines.push(JSON.stringify({ messages: formattedMsgs }));
								}

								const fileContent = lines.join('\n') + '\n';
								await vscode.workspace.fs.writeFile(saveUri, Buffer.from(fileContent, 'utf8'));
								vscode.window.showInformationMessage(`Successfully exported ${ftData.fineTuningData.length} training examples.`);
							}
						} catch (err: any) {
							vscode.window.showErrorMessage(`Failed to export: ${err.message || String(err)}`);
						}
						break;
				}
			},
			null,
			this.disposables
		);

		// Listen to changes in analytics
		const sub = this.analyticsManager.onDidChange(() => {
			this.refresh();
		});
		this.disposables.push(sub);
	}

	public async refresh() {
		const data = this.analyticsManager.getData();
		const savings = this.analyticsManager.getSavingsString(data);
		const providerStatus = await this.getProviderStatus();

		this.panel.webview.postMessage({
			command: 'update',
			data,
			savings,
			providerStatus
		});
	}

	private async getProviderStatus() {
		const keys = await this.secretsManager.getAll();
		const providers = ['nvidia', 'groq', 'openrouter', 'cerebras', 'google'];
		const status: Record<
			string,
			{
				totalKeys: number;
				cooldowns: { keyMask: string; remainingMs: number }[];
			}
		> = {};

		for (const p of providers) {
			const activeKeys = keys[p as ProviderName] || [];
			const cooldownList = OpenAICompatibleProvider.getProviderCooldowns(p);

			const cooldownsMapped = cooldownList.map((c) => {
				const index = activeKeys.indexOf(c.key);
				const label = index !== -1 ? `Key ${index + 1}` : 'Key';
				const mask = c.key.length > 8 
					? `${c.key.slice(0, 4)}...${c.key.slice(-4)}`
					: '...';
				return {
					keyMask: `${label} (${mask})`,
					remainingMs: c.remainingMs,
				};
			});

			status[p] = {
				totalKeys: activeKeys.length,
				cooldowns: cooldownsMapped,
			};
		}
		return status;
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
	<title>ModelPilot Token & Cost Analytics</title>
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
			max-width: 1000px;
			width: 100%;
			display: flex;
			flex-direction: column;
			gap: 24px;
		}

		/* Header & Glassmorphism Card */
		.dashboard-header {
			background: radial-gradient(circle at 10% 20%, rgba(6, 182, 212, 0.1) 0%, rgba(59, 130, 246, 0.05) 90%), var(--bg-card);
			border: 1px solid var(--border-color);
			backdrop-filter: blur(12px);
			border-radius: 20px;
			padding: 32px;
			display: flex;
			flex-direction: column;
			align-items: center;
			text-align: center;
			position: relative;
			overflow: hidden;
			box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
		}

		.header-title {
			font-size: 1.5rem;
			font-weight: 500;
			color: var(--text-secondary);
			margin: 0 0 12px 0;
			letter-spacing: 0.05em;
			text-transform: uppercase;
		}

		.savings-value {
			font-size: 4rem;
			font-weight: 700;
			background: linear-gradient(135deg, #06b6d4, #3b82f6, #10b981);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
			margin: 8px 0;
			filter: drop-shadow(0 4px 12px rgba(6, 182, 212, 0.2));
		}

		.header-subtitle {
			color: var(--text-secondary);
			font-size: 1rem;
			margin: 8px 0 24px 0;
			max-width: 500px;
			line-height: 1.5;
		}

		.badge-row {
			display: flex;
			gap: 16px;
			flex-wrap: wrap;
			justify-content: center;
		}

		.badge {
			background: rgba(255, 255, 255, 0.05);
			border: 1px solid var(--border-color);
			padding: 8px 16px;
			border-radius: 50px;
			font-size: 0.875rem;
			font-weight: 500;
			color: var(--text-primary);
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.badge span {
			color: var(--accent-primary);
			font-weight: 700;
		}

		/* Grid Layout for Providers */
		.provider-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
			gap: 24px;
		}

		.provider-card {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 16px;
			padding: 24px;
			display: flex;
			flex-direction: column;
			gap: 20px;
			transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
		}

		.provider-card:hover {
			transform: translateY(-2px);
			border-color: rgba(6, 182, 212, 0.3);
			box-shadow: 0 6px 24px rgba(6, 182, 212, 0.1);
		}

		.provider-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
		}

		.provider-name {
			font-size: 1.25rem;
			font-weight: 600;
			text-transform: capitalize;
			margin: 0;
		}

		/* Safety Meter styles */
		.safety-meter-container {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.meter-label-row {
			display: flex;
			justify-content: space-between;
			align-items: center;
			font-size: 0.85rem;
		}

		.meter-status-text {
			color: var(--text-secondary);
		}

		.meter-badge {
			padding: 4px 10px;
			border-radius: 20px;
			font-size: 0.75rem;
			font-weight: 600;
			text-transform: uppercase;
		}

		.meter-badge.healthy {
			background: rgba(16, 185, 129, 0.15);
			color: var(--success);
			border: 1px solid rgba(16, 185, 129, 0.2);
		}

		.meter-badge.cooldown {
			background: rgba(245, 158, 11, 0.15);
			color: var(--warning);
			border: 1px solid rgba(245, 158, 11, 0.2);
		}

		.meter-badge.unconfigured {
			background: rgba(156, 163, 175, 0.1);
			color: var(--text-secondary);
			border: 1px solid rgba(156, 163, 175, 0.15);
		}

		.meter-bar {
			height: 8px;
			background: rgba(255, 255, 255, 0.05);
			border-radius: 4px;
			overflow: hidden;
			position: relative;
		}

		.meter-fill {
			height: 100%;
			border-radius: 4px;
			width: 0%;
			transition: width 0.3s ease, background-color 0.3s ease;
		}

		.meter-fill.healthy {
			background: linear-gradient(90deg, #10b981, #059669);
			width: 100%;
		}

		.meter-fill.cooldown {
			background: linear-gradient(90deg, #f59e0b, #d97706);
		}

		.meter-fill.unconfigured {
			background: #4b5563;
			width: 0%;
		}

		/* Cooldown countdowns */
		.cooldown-list {
			display: flex;
			flex-direction: column;
			gap: 6px;
			font-size: 0.8rem;
			background: rgba(0, 0, 0, 0.2);
			padding: 8px 12px;
			border-radius: 8px;
			border: 1px solid var(--border-color);
		}

		.cooldown-item {
			display: flex;
			justify-content: space-between;
			align-items: center;
		}

		.cooldown-timer {
			color: var(--warning);
			font-weight: 500;
		}

		/* Token stats breakdown */
		.stats-table {
			display: flex;
			flex-direction: column;
			gap: 12px;
			font-size: 0.9rem;
			border-top: 1px solid var(--border-color);
			padding-top: 16px;
		}

		.stats-row {
			display: flex;
			justify-content: space-between;
			align-items: center;
		}

		.stats-label {
			color: var(--text-secondary);
		}

		.stats-val {
			font-weight: 500;
		}

		/* Model Breakdown styles */
		.models-section {
			background: var(--bg-card);
			border: 1px solid var(--border-color);
			border-radius: 16px;
			padding: 24px;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
			display: flex;
			flex-direction: column;
			gap: 16px;
		}

		.models-title {
			font-size: 1.25rem;
			font-weight: 600;
			margin: 0;
		}

		.table-wrapper {
			overflow-x: auto;
		}

		table {
			width: 100%;
			border-collapse: collapse;
			text-align: left;
			font-size: 0.9rem;
		}

		th, td {
			padding: 12px 16px;
			border-bottom: 1px solid var(--border-color);
		}

		th {
			color: var(--text-secondary);
			font-weight: 500;
			font-size: 0.8rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		tr:last-child td {
			border-bottom: none;
		}

		.badge-provider {
			padding: 2px 6px;
			border-radius: 4px;
			font-size: 0.75rem;
			font-weight: 600;
			text-transform: uppercase;
		}

		.badge-provider.nvidia {
			background: rgba(118, 185, 0, 0.15);
			color: #76b900;
		}

		.badge-provider.groq {
			background: rgba(245, 93, 34, 0.15);
			color: #f55d22;
		}

		.badge-provider.openrouter {
			background: rgba(59, 130, 246, 0.15);
			color: var(--accent-secondary);
		}

		.badge-provider.cerebras {
			background: rgba(229, 28, 35, 0.15);
			color: #e51c23;
		}

		.badge-provider.google {
			background: rgba(66, 133, 244, 0.15);
			color: #4285f4;
		}

		.cost-saving {
			color: var(--success);
			font-weight: 600;
		}

		.cost-actual {
			color: var(--text-secondary);
		}

		/* Actions Row */
		.actions-row {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-top: 16px;
			flex-wrap: wrap;
			gap: 16px;
		}

		button {
			font-family: inherit;
			font-size: 0.9rem;
			font-weight: 500;
			padding: 10px 20px;
			border-radius: 10px;
			cursor: pointer;
			transition: all 0.2s;
			display: inline-flex;
			align-items: center;
			gap: 8px;
		}

		.btn-refresh {
			background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
			color: white;
			border: none;
			box-shadow: 0 4px 12px rgba(6, 182, 212, 0.3);
		}

		.btn-refresh:hover {
			filter: brightness(1.1);
			transform: translateY(-1px);
		}

		.btn-reset {
			background: transparent;
			color: var(--danger);
			border: 1px solid rgba(239, 68, 68, 0.3);
		}

		.btn-reset:hover {
			background: rgba(239, 68, 68, 0.05);
			border-color: var(--danger);
		}

		/* Animations */
		@keyframes pulse {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.5; }
		}

		.pulse-dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background-color: var(--success);
			display: inline-block;
			animation: pulse 2s infinite;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="dashboard-header">
			<div class="header-title">Estimated Cost Savings</div>
			<div class="savings-value" id="savings-display">$0.00</div>
			<div class="header-subtitle">
				By routing requests automatically to Groq and NVIDIA NIM free tiers, ModelPilot has cut your paid API token spend.
			</div>
			<div class="badge-row">
				<div class="badge">
					Total Requests: <span id="total-requests">0</span>
				</div>
				<div class="badge">
					Total Tokens Tracked: <span id="total-tokens">0</span>
				</div>
				<div class="badge">
					Total Fallbacks: <span id="total-fallbacks">0</span>
				</div>
			</div>
		</div>

		<div class="provider-grid">
			<!-- NVIDIA NIM Card -->
			<div class="provider-card" id="nvidia-card">
				<div class="provider-header">
					<h3 class="provider-name">NVIDIA NIM</h3>
					<div class="pulse-dot" id="nvidia-pulse"></div>
				</div>
				
				<div class="safety-meter-container">
					<div class="meter-label-row">
						<span class="meter-status-text">Safety Meter</span>
						<span class="meter-badge unconfigured" id="nvidia-badge">Unconfigured</span>
					</div>
					<div class="meter-bar">
						<div class="meter-fill unconfigured" id="nvidia-meter-fill"></div>
					</div>
				</div>

				<div class="cooldown-list" id="nvidia-cooldowns" style="display: none;">
					<!-- Dinamically filled -->
				</div>

				<div class="stats-table">
					<div class="stats-row">
						<span class="stats-label">Requests Sent</span>
						<span class="stats-val" id="nvidia-requests">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Input Tokens</span>
						<span class="stats-val" id="nvidia-input-tokens">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Output Tokens</span>
						<span class="stats-val" id="nvidia-output-tokens">0</span>
					</div>
					<div class="stats-row" style="font-weight: 600;">
						<span class="stats-label" style="color: var(--text-primary);">Total Tokens</span>
						<span class="stats-val" id="nvidia-total-tokens">0</span>
					</div>
				</div>
			</div>

			<!-- Groq Card -->
			<div class="provider-card" id="groq-card">
				<div class="provider-header">
					<h3 class="provider-name">Groq</h3>
					<div class="pulse-dot" id="groq-pulse"></div>
				</div>
				
				<div class="safety-meter-container">
					<div class="meter-label-row">
						<span class="meter-status-text">Safety Meter</span>
						<span class="meter-badge unconfigured" id="groq-badge">Unconfigured</span>
					</div>
					<div class="meter-bar">
						<div class="meter-fill unconfigured" id="groq-meter-fill"></div>
					</div>
				</div>

				<div class="cooldown-list" id="groq-cooldowns" style="display: none;">
					<!-- Dinamically filled -->
				</div>

				<div class="stats-table">
					<div class="stats-row">
						<span class="stats-label">Requests Sent</span>
						<span class="stats-val" id="groq-requests">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Input Tokens</span>
						<span class="stats-val" id="groq-input-tokens">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Output Tokens</span>
						<span class="stats-val" id="groq-output-tokens">0</span>
					</div>
					<div class="stats-row" style="font-weight: 600;">
						<span class="stats-label" style="color: var(--text-primary);">Total Tokens</span>
						<span class="stats-val" id="groq-total-tokens">0</span>
					</div>
				</div>
			</div>

			<!-- OpenRouter Card -->
			<div class="provider-card" id="openrouter-card">
				<div class="provider-header">
					<h3 class="provider-name">OpenRouter</h3>
					<div class="pulse-dot" id="openrouter-pulse"></div>
				</div>
				
				<div class="safety-meter-container">
					<div class="meter-label-row">
						<span class="meter-status-text">Safety Meter</span>
						<span class="meter-badge unconfigured" id="openrouter-badge">Unconfigured</span>
					</div>
					<div class="meter-bar">
						<div class="meter-fill unconfigured" id="openrouter-meter-fill"></div>
					</div>
				</div>

				<div class="cooldown-list" id="openrouter-cooldowns" style="display: none;">
					<!-- Dinamically filled -->
				</div>

				<div class="stats-table">
					<div class="stats-row">
						<span class="stats-label">Requests Sent</span>
						<span class="stats-val" id="openrouter-requests">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Input Tokens</span>
						<span class="stats-val" id="openrouter-input-tokens">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Output Tokens</span>
						<span class="stats-val" id="openrouter-output-tokens">0</span>
					</div>
					<div class="stats-row" style="font-weight: 600;">
						<span class="stats-label" style="color: var(--text-primary);">Total Tokens</span>
						<span class="stats-val" id="openrouter-total-tokens">0</span>
					</div>
				</div>
			</div>

			<!-- Cerebras Card -->
			<div class="provider-card" id="cerebras-card">
				<div class="provider-header">
					<h3 class="provider-name">Cerebras</h3>
					<div class="pulse-dot" id="cerebras-pulse"></div>
				</div>
				
				<div class="safety-meter-container">
					<div class="meter-label-row">
						<span class="meter-status-text">Safety Meter</span>
						<span class="meter-badge unconfigured" id="cerebras-badge">Unconfigured</span>
					</div>
					<div class="meter-bar">
						<div class="meter-fill unconfigured" id="cerebras-meter-fill"></div>
					</div>
				</div>

				<div class="cooldown-list" id="cerebras-cooldowns" style="display: none;">
					<!-- Dinamically filled -->
				</div>

				<div class="stats-table">
					<div class="stats-row">
						<span class="stats-label">Requests Sent</span>
						<span class="stats-val" id="cerebras-requests">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Input Tokens</span>
						<span class="stats-val" id="cerebras-input-tokens">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Output Tokens</span>
						<span class="stats-val" id="cerebras-output-tokens">0</span>
					</div>
					<div class="stats-row" style="font-weight: 600;">
						<span class="stats-label" style="color: var(--text-primary);">Total Tokens</span>
						<span class="stats-val" id="cerebras-total-tokens">0</span>
					</div>
				</div>
			</div>

			<!-- Google Card -->
			<div class="provider-card" id="google-card">
				<div class="provider-header">
					<h3 class="provider-name">Google AI Studio</h3>
					<div class="pulse-dot" id="google-pulse"></div>
				</div>
				
				<div class="safety-meter-container">
					<div class="meter-label-row">
						<span class="meter-status-text">Safety Meter</span>
						<span class="meter-badge unconfigured" id="google-badge">Unconfigured</span>
					</div>
					<div class="meter-bar">
						<div class="meter-fill unconfigured" id="google-meter-fill"></div>
					</div>
				</div>

				<div class="cooldown-list" id="google-cooldowns" style="display: none;">
					<!-- Dinamically filled -->
				</div>

				<div class="stats-table">
					<div class="stats-row">
						<span class="stats-label">Requests Sent</span>
						<span class="stats-val" id="google-requests">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Input Tokens</span>
						<span class="stats-val" id="google-input-tokens">0</span>
					</div>
					<div class="stats-row">
						<span class="stats-label">Output Tokens</span>
						<span class="stats-val" id="google-output-tokens">0</span>
					</div>
					<div class="stats-row" style="font-weight: 600;">
						<span class="stats-label" style="color: var(--text-primary);">Total Tokens</span>
						<span class="stats-val" id="google-total-tokens">0</span>
					</div>
				</div>
			</div>
		</div>

		<!-- Model Breakdown Section -->
		<div class="models-section" id="models-section" style="display: none;">
			<h3 class="models-title">Model-by-Model Breakdown</h3>
			<div class="table-wrapper">
				<table>
					<thead>
						<tr>
							<th>Model</th>
							<th>Provider</th>
							<th>Requests</th>
							<th>Total Tokens</th>
							<th>Avg Latency</th>
							<th>Commercial Cost (Paid APIs)</th>
							<th>Actual Cost</th>
							<th>Net Savings</th>
						</tr>
					</thead>
					<tbody id="models-table-body">
						<!-- Dinamically filled -->
					</tbody>
				</table>
			</div>
		</div>

		<div class="actions-row">
			<button class="btn-reset" onclick="resetData()">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
				Reset Statistics
			</button>
			<button class="btn-refresh" onclick="exportFineTuning()" style="background-color: var(--accent-secondary); color: white;">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
				Export Fine-Tuning Data (JSONL)
			</button>
			<button class="btn-refresh" onclick="refreshData()">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
				Refresh Panel
			</button>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();

		// Local copy of key states with countdown functions
		let activeCooldowns = {
			nvidia: [],
			groq: [],
			openrouter: [],
			cerebras: [],
			google: []
		};

		function resetData() {
			vscode.postMessage({ command: 'reset' });
		}

		function refreshData() {
			vscode.postMessage({ command: 'refresh' });
		}

		function exportFineTuning() {
			vscode.postMessage({ command: 'exportFineTuning' });
		}

		// Handle updates from extension
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.command === 'update') {
				const { data, savings, providerStatus } = message;
				
				// Update main stats
				document.getElementById('savings-display').innerText = savings;
				
				let totalReqs = 0;
				let totalTkn = 0;
				let totalFallbacks = 0;
				
				const providers = ['nvidia', 'groq', 'openrouter', 'cerebras', 'google'];
				providers.forEach(p => {
					const stats = data.providers[p] || { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalLatencyMs: 0, totalFallbacks: 0 };
					totalReqs += stats.requests;
					totalTkn += stats.totalTokens;
					totalFallbacks += stats.totalFallbacks || 0;
					
					document.getElementById(p + '-requests').innerText = stats.requests.toLocaleString();
					document.getElementById(p + '-input-tokens').innerText = stats.promptTokens.toLocaleString();
					document.getElementById(p + '-output-tokens').innerText = stats.completionTokens.toLocaleString();
					document.getElementById(p + '-total-tokens').innerText = stats.totalTokens.toLocaleString();

					// Safety Meter logic
					const statusInfo = providerStatus[p] || { totalKeys: 0, cooldowns: [] };
					const badgeEl = document.getElementById(p + '-badge');
					const fillEl = document.getElementById(p + '-meter-fill');
					const pulseEl = document.getElementById(p + '-pulse');

					// Save cooldowns for javascript countdown
					activeCooldowns[p] = statusInfo.cooldowns.map(c => ({
						keyMask: c.keyMask,
						endTime: Date.now() + c.remainingMs
					}));

					if (statusInfo.totalKeys === 0) {
						// Unconfigured
						badgeEl.innerText = 'Unconfigured';
						badgeEl.className = 'meter-badge unconfigured';
						fillEl.className = 'meter-fill unconfigured';
						fillEl.style.width = '0%';
						pulseEl.style.backgroundColor = '#4b5563';
					} else if (statusInfo.cooldowns.length === 0) {
						// Healthy
						badgeEl.innerText = 'Healthy';
						badgeEl.className = 'meter-badge healthy';
						fillEl.className = 'meter-fill healthy';
						fillEl.style.width = '100%';
						pulseEl.style.backgroundColor = 'var(--success)';
					} else {
						// Cooldown
						const activeCount = statusInfo.totalKeys - statusInfo.cooldowns.length;
						badgeEl.innerText = activeCount + '/' + statusInfo.totalKeys + ' Ready';
						badgeEl.className = 'meter-badge cooldown';
						fillEl.className = 'meter-fill cooldown';
						
						const percentage = (activeCount / statusInfo.totalKeys) * 100;
						fillEl.style.width = percentage + '%';
						pulseEl.style.backgroundColor = 'var(--warning)';
					}

					renderCooldowns(p);
				});

				document.getElementById('total-requests').innerText = totalReqs.toLocaleString();
				document.getElementById('total-tokens').innerText = totalTkn.toLocaleString();
				document.getElementById('total-fallbacks').innerText = totalFallbacks.toLocaleString();

				// Update models breakdown table
				const modelsSection = document.getElementById('models-section');
				const tableBody = document.getElementById('models-table-body');
				
				if (data.models && Object.keys(data.models).length > 0) {
					modelsSection.style.display = 'flex';
					let tableHtml = '';
					
					// Sort models by savings descending
					const sortedModels = Object.values(data.models).sort((a, b) => {
						const savingsA = a.commercialCost - a.actualCost;
						const savingsB = b.commercialCost - b.actualCost;
						return savingsB - savingsA;
					});
					
					sortedModels.forEach(m => {
						const savings = m.commercialCost - m.actualCost;
						const avgLatency = m.totalLatencyMs && m.requests ? (m.totalLatencyMs / m.requests / 1000).toFixed(2) + 's' : 'N/A';
						tableHtml += \`
							<tr>
								<td style="font-weight: 500;">\${m.displayName || m.modelId}</td>
								<td><span class="badge-provider \${m.provider.toLowerCase()}">\${m.provider}</span></td>
								<td>\${m.requests}</td>
								<td>\${m.totalTokens.toLocaleString()}</td>
								<td>\${avgLatency}</td>
								<td>$\${m.commercialCost.toFixed(4)}</td>
								<td class="cost-actual">\${m.actualCost > 0 ? '$' + m.actualCost.toFixed(4) : 'Free ($0.00)'}</td>
								<td class="cost-saving" style="font-weight: 600;">$\${savings.toFixed(4)}</td>
							</tr>
						\`;
					});
					
					tableBody.innerHTML = tableHtml;
				} else {
					modelsSection.style.display = 'none';
					tableBody.innerHTML = '';
				}
			}
		});

		function renderCooldowns(p) {
			const container = document.getElementById(p + '-cooldowns');
			const list = activeCooldowns[p];
			
			if (!list || list.length === 0) {
				container.style.display = 'none';
				container.innerHTML = '';
				return;
			}

			container.style.display = 'flex';
			let html = '<div style="font-weight: 600; margin-bottom: 4px; color: var(--warning);">Active Cooldowns:</div>';
			
			list.forEach(c => {
				const remaining = Math.max(0, Math.ceil((c.endTime - Date.now()) / 1000));
				html += \`
					<div class="cooldown-item">
						<span style="color: var(--text-secondary);">\${c.keyMask}</span>
						<span class="cooldown-timer">\${remaining}s remaining</span>
					</div>
				\`;
			});

			container.innerHTML = html;
		}

		// Run a fast timer to update remaining cooldown seconds in real-time
		setInterval(() => {
			const providers = ['nvidia', 'groq', 'openrouter', 'cerebras', 'google'];
			providers.forEach(p => {
				const list = activeCooldowns[p];
				if (list && list.length > 0) {
					// Check if any cooldown has expired
					const now = Date.now();
					const hasExpired = list.some(c => now >= c.endTime);
					
					if (hasExpired) {
						// Trigger a full refresh from the extension to update all statuses
						refreshData();
					} else {
						// Just update countdown numbers visually
						renderCooldowns(p);
					}
				}
			});
		}, 1000);

		// Initial load
		refreshData();
	</script>
</body>
</html>
`;
	}

	public dispose() {
		AnalyticsPanel.currentPanel = undefined;

		this.panel.dispose();

		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}
}
