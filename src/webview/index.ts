import { EXPERT_PROFILES, ExpertProfile, DEFAULT_EXPERT_ID } from '../data/expertProfiles';
import { MODEL_PROFILES, ModelProfile } from '../data/modelProfiles';

declare function acquireVsCodeApi(): {
	postMessage(msg: WebviewMessage): void;
	getState(): WebviewState | undefined;
	setState(state: WebviewState): void;
};

interface SavedSession {
	id: string;
	title: string;
	expertId: string;
	createdAt: number;
	messages: DisplayMessage[];
}

interface WebviewState {
	expertId: string;
	messages: DisplayMessage[];
	sessionId: string | null;
}

interface DisplayMessage {
	id: string;
	role: 'user' | 'assistant' | 'tool-confirm' | 'tool-log';
	content: string;
	model?: string;
	provider?: string;
	timestamp: number;
	toolName?: string;
	toolArgs?: any;
	toolDiff?: { oldContent: string; newContent: string };
	toolSuccess?: boolean;
	toolStatus?: 'completed' | 'failed' | 'rejected' | 'pending';
	isOutOfWorkspace?: boolean;
	standalone?: boolean;
}

type WebviewMessage =
	| { type: 'sendMessage'; text: string; expertId: string }
	| { type: 'changeExpert'; expertId: string }
	| { type: 'newChat' }
	| { type: 'refreshModels' }
	| { type: 'selectSession'; sessionId: string }
	| { type: 'deleteSession'; sessionId: string }
	| { type: 'approveTool'; id: string }
	| { type: 'rejectTool'; id: string }
	| { type: 'stopGeneration'; sessionId?: string | null }
	| { type: 'openFile'; path: string }
	| { type: 'insertCode'; text: string }
	| { type: 'runCommand'; command: string }
	| { type: 'approveAllReads' };

type ExtensionMessage =
	| { type: 'thinking'; id: string; sessionId?: string }
	| { type: 'chunk'; id: string; text: string; sessionId?: string }
	| { type: 'messageComplete'; id: string; model: string; provider: string; sessionId?: string }
	| { type: 'messageError'; id: string; error: string; sessionId?: string }
	| { type: 'fallback'; from: string; to: string; reason: string; sessionId?: string }
	| { type: 'modelsRefreshed'; count: number }
	| { type: 'setExpert'; expertId: string }
	| { type: 'sessionsUpdated'; sessions: SavedSession[] }
	| { type: 'loadSession'; session: SavedSession; isGenerating?: boolean }
	| { type: 'toolConfirm'; id: string; name: string; args: any; diff?: { oldContent: string; newContent: string }; sessionId?: string; isOutOfWorkspace?: boolean }
	| { type: 'toolStart'; id: string; name: string; args: any; sessionId?: string }
	| { type: 'toolEnd'; id: string; name: string; success: boolean; result: string; status: 'completed' | 'failed' | 'rejected'; sessionId?: string };

const vscode = acquireVsCodeApi();
let currentExpertId: string = DEFAULT_EXPERT_ID;
let currentSessionId: string | null = null;
let messages: DisplayMessage[] = [];
let savedSessions: SavedSession[] = [];
let pendingId: string | null = null;
let rawChunks: Record<string, string> = {};

function decodeHtmlEntities(str: string): string {
	const txt = document.createElement('textarea');
	txt.innerHTML = str;
	return txt.value;
}

function renderMarkdown(text: string): string {
	// Strip out raw tool blocks so the user doesn't see them as raw text in chat bubbles
	const cleanedText = text.replace(/(?:<use_tool>|<_tool>|<tool>|use_tool>|_tool>|tool>|\buse_tool\b|\b_tool\b)\s*[\s\S]*?\s*(?:<\/use_tool>|<\/_tool>|<\/tool>|\/use_tool>|\/_tool>|\/tool>|\/arguments|<\/arguments>|\buse_tool\b|\b_tool\b|$)/gi, '').trim();

	let html = cleanedText
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
			const cleanLang = lang ? lang.trim().toLowerCase() : '';
			const trimmedCode = code.trim();
			const encodedCode = encodeURIComponent(trimmedCode);

			let actionsHtml = `<button class="code-action-btn code-action-copy" data-code="${encodedCode}">Copy</button>`;

			const terminalLangs = ['bash', 'sh', 'shell', 'zsh', 'powershell', 'cmd'];
			if (terminalLangs.includes(cleanLang)) {
				actionsHtml += `<button class="code-action-btn code-action-run" data-code="${encodedCode}">Run Command</button>`;
			} else {
				actionsHtml += `<button class="code-action-btn code-action-insert" data-code="${encodedCode}">Insert at Cursor</button>`;
			}

			return `<div class="code-block-container">
				<div class="code-block-header">
					<span class="code-block-lang">${cleanLang || 'code'}</span>
					<div class="code-block-actions">${actionsHtml}</div>
				</div>
				<pre><code>${trimmedCode}</code></pre>
			</div>`;
		})
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>')
		.replace(/^### (.+)$/gm, '<h3>$1</h3>')
		.replace(/^## (.+)$/gm, '<h2>$1</h2>')
		.replace(/^# (.+)$/gm, '<h1>$1</h1>')
		.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
		.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
		.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
		.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
		.replace(/\n\n/g, '</p><p>')
		.replace(/\n/g, '<br>');
	if (!html.startsWith('<')) { html = `<p>${html}</p>`; }
	return html;
}

function autoResize(el: HTMLTextAreaElement): void {
	el.style.height = 'auto';
	el.style.height = Math.min(el.scrollHeight, 240) + 'px';
}

function setActiveExpert(expertId: string): void {
	currentExpertId = expertId;
	document.querySelectorAll<HTMLDivElement>('.expert-menu-item').forEach(item => {
		item.classList.toggle('active', item.dataset.id === expertId);
	});

	const expert = EXPERT_PROFILES.find(e => e.id === expertId);
	const input = document.getElementById('input') as HTMLTextAreaElement;
	const pill = document.getElementById('active-expert-pill');
	if (input) {
		input.placeholder = 'Ask anything…';
	}
	if (pill) {
		if (expert && expertId !== 'general') {
			pill.innerHTML = `<span>${expert.label}</span><span class="expert-pill-close" id="expert-pill-close" title="Revert to General Chat">×</span>`;
			pill.style.display = 'inline-flex';

			const closeBtn = document.getElementById('expert-pill-close');
			if (closeBtn) {
				closeBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					setActiveExpert('general');
					vscode.postMessage({ type: 'changeExpert', expertId: 'general' });
					saveState();
				});
			}
		} else {
			pill.style.display = 'none';
		}
	}
}

function renderExpertPicker(): void {
	const menu = document.getElementById('expert-menu')!;
	menu.innerHTML = '';

	EXPERT_PROFILES.forEach(expert => {
		const item = document.createElement('div');
		item.className = `expert-menu-item ${expert.id === currentExpertId ? 'active' : ''}`;
		item.dataset.id = expert.id;

		const label = document.createElement('span');
		label.className = 'expert-menu-label';
		label.textContent = expert.label;

		const desc = document.createElement('span');
		desc.className = 'expert-menu-desc';
		desc.textContent = expert.description;

		item.appendChild(label);
		item.appendChild(desc);

		item.addEventListener('click', () => {
			setActiveExpert(expert.id);
			saveState();
			vscode.postMessage({ type: 'changeExpert', expertId: expert.id });
			toggleExpertMenu(false);
		});

		menu.appendChild(item);
	});
}

function toggleExpertMenu(force?: boolean): void {
	const menu = document.getElementById('expert-menu')!;
	const btn = document.getElementById('expert-select-btn')!;
	const isVisible = force !== undefined ? force : !menu.classList.contains('visible');

	menu.classList.toggle('visible', isVisible);
	btn.classList.toggle('active', isVisible);
}

function toggleHistoryDrawer(force?: boolean): void {
	const drawer = document.getElementById('history-drawer')!;
	const btn = document.getElementById('history-btn')!;
	const isVisible = force !== undefined ? force : !drawer.classList.contains('visible');

	drawer.classList.toggle('visible', isVisible);
	btn.classList.toggle('active', isVisible);
}

function renderHistoryDrawer(): void {
	const drawer = document.getElementById('history-drawer')!;
	drawer.innerHTML = '';

	// Render the header first
	const header = document.createElement('div');
	header.className = 'history-header';

	const headerTitle = document.createElement('span');
	headerTitle.className = 'history-header-title';
	headerTitle.textContent = 'sessions';

	const divider = document.createElement('div');
	divider.className = 'history-header-divider';

	header.appendChild(headerTitle);
	header.appendChild(divider);
	drawer.appendChild(header);

	if (savedSessions.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'history-empty';
		empty.textContent = 'No saved conversations';
		drawer.appendChild(empty);
		return;
	}

	const sorted = [...savedSessions].sort((a, b) => b.createdAt - a.createdAt);

	sorted.forEach(session => {
		const item = document.createElement('div');
		item.className = `history-item ${session.id === currentSessionId ? 'active' : ''}`;
		item.dataset.id = session.id;

		const left = document.createElement('div');
		left.className = 'history-item-left';

		const title = document.createElement('span');
		title.className = 'history-item-title';
		title.textContent = session.title || 'New Conversation';

		const meta = document.createElement('span');
		meta.className = 'history-item-meta';
		const dateStr = new Date(session.createdAt).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
		const expert = EXPERT_PROFILES.find(e => e.id === session.expertId);
		meta.textContent = `${dateStr} · ${expert ? expert.label : 'General'}`;

		left.appendChild(title);
		left.appendChild(meta);

		// Delete button
		const delBtn = document.createElement('button');
		delBtn.className = 'history-item-delete';
		delBtn.title = 'Delete chat';
		delBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2l1-1h3l1 1v1zM9 3V2H6v1h3zM4 13h7V4H4v9zm2-8H5v6h1V5zm3 0H8v6h1V5z"/></svg>`;

		delBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
		});

		item.appendChild(left);
		item.appendChild(delBtn);

		item.addEventListener('click', () => {
			vscode.postMessage({ type: 'selectSession', sessionId: session.id });
			toggleHistoryDrawer(false);
		});

		drawer.appendChild(item);
	});
}

function hideWelcome(): void {
	document.getElementById('welcome')?.remove();
}

function restoreState(): void {
	const state = vscode.getState();
	if (state) {
		currentExpertId = state.expertId || DEFAULT_EXPERT_ID;
		messages = state.messages;
		currentSessionId = state.sessionId || null;
		setActiveExpert(currentExpertId);
		renderMessages();
	} else {
		setActiveExpert(currentExpertId);
	}
}

function saveState(): void {
	vscode.setState({ expertId: currentExpertId, messages, sessionId: currentSessionId });
}

function renderMessages(): void {
	const container = document.getElementById('messages')!;
	container.innerHTML = '';
	if (messages.length === 0) {
		container.innerHTML = `<div class="welcome" id="welcome">
			<div class="welcome-icon" style="font-weight: 700; color: var(--vscode-button-background); margin-bottom: 8px;">MODELPILOT</div>
			<div class="welcome-title">Workspace-Aware AI Assistant</div>
			<div class="welcome-sub">Because everyone needs AI.</div>
		</div>`;
		return;
	}
	messages.forEach(m => container.appendChild(buildMessageEl(m)));
	scrollToBottom();
}

function createRoutingBadge(modelId: string, providerName: string): HTMLElement {
	const wrapper = document.createElement('div');
	wrapper.className = 'meta-wrapper';

	const badge = document.createElement('div');
	badge.className = 'routing-badge';
	badge.innerHTML = `✦ ${modelId.split('/').pop() ?? modelId} (${providerName})`;

	const tooltip = document.createElement('div');
	tooltip.className = 'explanation-tooltip';

	const profile = MODEL_PROFILES.find(p => p.id === modelId && p.provider === providerName);
	if (profile) {
		const title = document.createElement('div');
		title.className = 'explanation-title';
		title.textContent = profile.displayName;
		tooltip.appendChild(title);

		const dimensions = ['coding', 'reasoning', 'security', 'speed', 'writing', 'learning'] as const;
		dimensions.forEach(dim => {
			const row = document.createElement('div');
			row.className = 'explanation-row';

			const dimName = document.createElement('span');
			dimName.className = 'explanation-dim';
			dimName.textContent = dim === 'security' ? 'Security' : dim;

			const barWrap = document.createElement('div');
			barWrap.className = 'explanation-bar-wrap';

			const bar = document.createElement('div');
			bar.className = 'explanation-bar';
			const fill = document.createElement('div');
			fill.className = 'explanation-bar-fill';
			const score = profile.capabilities[dim] ?? 5;
			fill.style.width = `${score * 10}%`;
			bar.appendChild(fill);

			const val = document.createElement('span');
			val.textContent = `${score}/10`;
			val.style.minWidth = '28px';
			val.style.textAlign = 'right';

			barWrap.appendChild(bar);
			barWrap.appendChild(val);

			row.appendChild(dimName);
			row.appendChild(barWrap);
			tooltip.appendChild(row);
		});

		const desc = document.createElement('div');
		desc.className = 'explanation-desc';
		desc.textContent = profile.description;
		tooltip.appendChild(desc);
	} else {
		tooltip.textContent = `No local profile for ${modelId}`;
	}

	badge.addEventListener('click', (e) => {
		e.stopPropagation();
		tooltip.classList.toggle('visible');
	});

	document.addEventListener('click', (e) => {
		if (!badge.contains(e.target as Node) && !tooltip.contains(e.target as Node)) {
			tooltip.classList.remove('visible');
		}
	});

	wrapper.appendChild(badge);
	wrapper.appendChild(tooltip);
	return wrapper;
}

function renderInlineDiff(container: HTMLElement, oldContent: string, newContent: string) {
	const oldLines = oldContent.split(/\r?\n/);
	const newLines = newContent.split(/\r?\n/);

	function appendLine(type: 'addition' | 'deletion' | 'context', line: string, oldNum?: number, newNum?: number) {
		const lineDiv = document.createElement('div');
		lineDiv.className = `diff-line ${type}`;

		const numSpan = document.createElement('span');
		numSpan.className = 'diff-line-number';
		if (type === 'addition') {
			numSpan.textContent = `+${newNum}`;
		} else if (type === 'deletion') {
			numSpan.textContent = `-${oldNum}`;
		} else {
			numSpan.textContent = `${newNum}`;
		}
		lineDiv.appendChild(numSpan);

		const textSpan = document.createElement('span');
		textSpan.textContent = line;
		lineDiv.appendChild(textSpan);

		container.appendChild(lineDiv);
	}

	if (oldLines.length > 300 || newLines.length > 300) {
		let i = 0;
		while (i < oldLines.length || i < newLines.length) {
			if (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
				appendLine('context', oldLines[i], i + 1, i + 1);
			} else {
				if (i < oldLines.length) {
					appendLine('deletion', oldLines[i], i + 1, undefined);
				}
				if (i < newLines.length) {
					appendLine('addition', newLines[i], undefined, i + 1);
				}
			}
			i++;
		}
		return;
	}

	const dp: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
		Array(newLines.length + 1).fill(0)
	);

	for (let i = 1; i <= oldLines.length; i++) {
		for (let j = 1; j <= newLines.length; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	let idxOld = oldLines.length;
	let idxNew = newLines.length;
	const diffOps: { type: 'addition' | 'deletion' | 'context'; line: string; oldNum?: number; newNum?: number }[] = [];

	while (idxOld > 0 || idxNew > 0) {
		if (idxOld > 0 && idxNew > 0 && oldLines[idxOld - 1] === newLines[idxNew - 1]) {
			diffOps.push({ type: 'context', line: oldLines[idxOld - 1], oldNum: idxOld, newNum: idxNew });
			idxOld--;
			idxNew--;
		} else if (idxNew > 0 && (idxOld === 0 || dp[idxOld][idxNew - 1] >= dp[idxOld - 1][idxNew])) {
			diffOps.push({ type: 'addition', line: newLines[idxNew - 1], newNum: idxNew });
			idxNew--;
		} else {
			diffOps.push({ type: 'deletion', line: oldLines[idxOld - 1], oldNum: idxOld });
			idxOld--;
		}
	}

	diffOps.reverse();
	diffOps.forEach(op => appendLine(op.type, op.line, op.oldNum, op.newNum));
}

function buildMessageEl(msg: DisplayMessage): HTMLElement {
	const wrapper = document.createElement('div');
	wrapper.className = `message ${msg.role}`;
	wrapper.dataset.id = msg.id;

	if (msg.role === 'user') {
		const bubble = document.createElement('div');
		bubble.className = 'user-bubble';
		bubble.textContent = msg.content;
		wrapper.appendChild(bubble);
		return wrapper;
	}

	if (msg.role === 'tool-confirm') {
		const card = document.createElement('div');
		card.className = 'tool-confirm-card';
		card.id = `tool-confirm-${msg.id}`;

		const header = document.createElement('div');
		header.className = 'tool-confirm-header';
		const title = document.createElement('span');
		title.className = 'tool-confirm-title';
		title.textContent = 'Requesting Permission';
		const subtitle = document.createElement('span');
		subtitle.className = 'tool-confirm-subtitle';
		subtitle.textContent = 'The agent wants to run a tool:';
		header.appendChild(title);
		header.appendChild(subtitle);
		card.appendChild(header);

		const body = document.createElement('div');
		body.className = 'tool-confirm-body';

		if (msg.isOutOfWorkspace) {
			const warnDiv = document.createElement('div');
			warnDiv.className = 'tool-confirm-warning';
			warnDiv.style.backgroundColor = 'rgba(235, 137, 52, 0.15)';
			warnDiv.style.borderLeft = '3px solid #eb8934';
			warnDiv.style.color = '#eb8934';
			warnDiv.style.padding = '6px 10px';
			warnDiv.style.marginBottom = '10px';
			warnDiv.style.fontSize = '11px';
			warnDiv.style.borderRadius = '2px';
			warnDiv.style.fontWeight = '500';
			warnDiv.textContent = '⚠️ Warning: This command accesses files or paths outside your workspace root.';
			body.appendChild(warnDiv);
		}

		const toolInfo = document.createElement('div');
		toolInfo.innerHTML = `<strong>Tool:</strong> <code>${msg.toolName}</code>`;
		body.appendChild(toolInfo);

		if (msg.toolArgs) {
			const argsDiv = document.createElement('div');
			if (msg.toolName === 'run_terminal_command') {
				argsDiv.innerHTML = `<strong>Command:</strong>`;
				const preview = document.createElement('div');
				preview.className = 'command-preview-wrapper';
				preview.innerHTML = `<div class="command-preview-header">Command</div><pre class="command-preview-content"><code>${msg.toolArgs.command || ''}</code></pre>`;
				argsDiv.appendChild(preview);
			} else if (msg.toolName === 'write_file' || msg.toolName === 'create_file') {
				argsDiv.innerHTML = `<strong>Path:</strong> <code>${msg.toolArgs.path || ''}</code>`;
				if (msg.toolDiff) {
					const diffWrapper = document.createElement('div');
					diffWrapper.className = 'diff-wrapper';
					diffWrapper.innerHTML = `<div class="diff-header">Diff Preview</div>`;
					const diffContainer = document.createElement('div');
					diffContainer.className = 'diff-container';
					renderInlineDiff(diffContainer, msg.toolDiff.oldContent, msg.toolDiff.newContent);
					diffWrapper.appendChild(diffContainer);
					argsDiv.appendChild(diffWrapper);
				}
			} else if (msg.toolName === 'delete_file') {
				argsDiv.innerHTML = `<strong>Path:</strong> <code>${msg.toolArgs.path || ''}</code>`;
			} else {
				argsDiv.innerHTML = `<strong>Arguments:</strong> <code>${JSON.stringify(msg.toolArgs)}</code>`;
			}
			body.appendChild(argsDiv);
		}
		card.appendChild(body);

		const actions = document.createElement('div');
		actions.className = 'tool-confirm-actions';

		const rejectBtn = document.createElement('button');
		rejectBtn.className = 'tool-confirm-btn reject';
		rejectBtn.textContent = 'Reject';
		rejectBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'rejectTool', id: msg.id });
			msg.role = 'tool-log';
			msg.toolStatus = 'rejected';
			renderMessages();
			if (msg.standalone) {
				setLoading(false);
			}
		});

		const approveBtn = document.createElement('button');
		approveBtn.className = 'tool-confirm-btn approve';
		approveBtn.textContent = 'Approve';
		approveBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'approveTool', id: msg.id });
			msg.role = 'tool-log';
			msg.toolStatus = 'pending';
			renderMessages();
		});

		actions.appendChild(rejectBtn);
		if (msg.toolName === 'read_file') {
			const approveAllBtn = document.createElement('button');
			approveAllBtn.className = 'tool-confirm-btn approve-all';
			approveAllBtn.textContent = 'Approve All Reads';
			approveAllBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'approveAllReads' });
				vscode.postMessage({ type: 'approveTool', id: msg.id });
				msg.role = 'tool-log';
				msg.toolStatus = 'pending';
				renderMessages();
			});
			actions.appendChild(approveAllBtn);
		}
		actions.appendChild(approveBtn);
		card.appendChild(actions);

		return card;
	}

	if (msg.role === 'tool-log') {
		const item = document.createElement('div');
		item.className = 'tool-log-item';

		const header = document.createElement('div');
		header.className = 'tool-log-header';

		const statusBadge = document.createElement('span');
		statusBadge.className = `tool-log-status status-${msg.toolStatus || 'pending'}`;
		statusBadge.textContent = msg.toolStatus || 'pending';

		const nameSpan = document.createElement('span');
		nameSpan.className = 'tool-log-name';
		nameSpan.textContent = msg.toolName || '';

		const targetSpan = document.createElement('span');
		targetSpan.className = 'tool-log-target';
		if (msg.toolArgs) {
			targetSpan.textContent = msg.toolArgs.path || msg.toolArgs.command || msg.toolArgs.query || '';
		}

		header.appendChild(statusBadge);
		header.appendChild(nameSpan);
		header.appendChild(targetSpan);
		item.appendChild(header);

		const details = document.createElement('div');
		details.className = 'tool-log-details';
		details.style.display = 'block';

		if (msg.content) {
			if (msg.toolName === 'run_terminal_command' && msg.toolArgs?.command) {
				details.textContent = `$ ${msg.toolArgs.command}\n${msg.content}`;
			} else {
				details.textContent = msg.content;
			}
		} else if (msg.toolStatus === 'pending') {
			if (msg.toolName === 'run_terminal_command' && msg.toolArgs?.command) {
				details.textContent = `$ ${msg.toolArgs.command}\nRunning...`;
			} else {
				details.textContent = 'Running...';
			}
		} else if (msg.toolStatus === 'rejected') {
			if (msg.toolName === 'run_terminal_command' && msg.toolArgs?.command) {
				details.textContent = `$ ${msg.toolArgs.command}\nRejected by user.`;
			} else {
				details.textContent = 'Rejected by user.';
			}
		} else {
			if (msg.toolName === 'run_terminal_command' && msg.toolArgs?.command) {
				details.textContent = `$ ${msg.toolArgs.command}\nNo output.`;
			} else {
				details.textContent = 'No output.';
			}
		}
		item.appendChild(details);

		header.addEventListener('click', () => {
			details.style.display = details.style.display === 'none' ? 'block' : 'none';
		});

		return item;
	}

	// Assistant
	const header = document.createElement('div');
	header.className = 'message-header';
	const avatar = document.createElement('div');
	avatar.className = 'avatar assistant';
	avatar.textContent = 'AI';
	const name = document.createElement('span');
	name.textContent = 'ModelPilot';
	header.appendChild(avatar);
	header.appendChild(name);
	wrapper.appendChild(header);

	const bubble = document.createElement('div');
	bubble.className = 'bubble';
	if (msg.content) { bubble.innerHTML = renderMarkdown(msg.content); }
	wrapper.appendChild(bubble);

	if (!msg.model) {
		const cursor = document.createElement('span');
		cursor.className = 'cursor';
		cursor.id = `cursor-${msg.id}`;
		wrapper.appendChild(cursor);
	}

	if (msg.model && msg.provider) {
		const metaEl = createRoutingBadge(msg.model, msg.provider);
		wrapper.appendChild(metaEl);
	}

	return wrapper;
}

function createAssistantBubble(id: string): void {
	hideWelcome();
	const msg: DisplayMessage = { id, role: 'assistant', content: '', timestamp: Date.now() };
	messages.push(msg);
	rawChunks[id] = '';
	document.getElementById('messages')!.appendChild(buildMessageEl(msg));
	scrollToBottom();
}

function appendChunk(id: string, text: string): void {
	document.getElementById('thinking-row')?.remove();
	clearFallbackNotices();
	if (rawChunks[id] === undefined) {
		const msg = messages.find(m => m.id === id);
		rawChunks[id] = msg ? msg.content : '';
	}
	rawChunks[id] += text;
	const msg = messages.find(m => m.id === id);
	if (msg) { msg.content = rawChunks[id]; }
	const bubble = document.querySelector(`[data-id="${id}"] .bubble`) as HTMLElement;
	if (bubble) {
		bubble.innerHTML = renderMarkdown(rawChunks[id]);
	}
	scrollToBottom();
}

function finalizeMessage(id: string, model: string, provider: string): void {
	// Always remove cursor first
	document.getElementById(`cursor-${id}`)?.remove();
	document.getElementById('thinking-row')?.remove();
	clearFallbackNotices();

	const msg = messages.find(m => m.id === id);
	if (msg) { msg.model = model; msg.provider = provider; }

	const wrapper = document.querySelector(`[data-id="${id}"]`);
	if (wrapper && !wrapper.querySelector('.meta-wrapper')) {
		const metaEl = createRoutingBadge(model, provider);
		wrapper.appendChild(metaEl);
	}

	delete rawChunks[id];
	pendingId = null;
	setLoading(false);
	setInputEnabled(true);
	saveState();
}

function showError(id: string, error: string): void {
	document.getElementById(`cursor-${id}`)?.remove();
	document.getElementById('thinking-row')?.remove();
	clearFallbackNotices();
	const bubble = document.querySelector(`[data-id="${id}"] .bubble`) as HTMLElement;
	if (bubble) { bubble.textContent = error; bubble.classList.add('error'); }
	delete rawChunks[id];
	pendingId = null;
	setLoading(false);
	setInputEnabled(true);
}

function clearFallbackNotices(): void {
	document.querySelectorAll('.fallback-notice').forEach(el => el.remove());
}

function showFallbackNotice(from: string, to: string, reason?: string): void {
	const notice = document.createElement('div');
	notice.className = 'fallback-notice';
	notice.textContent = `Switching: ${from} → ${to}${reason ? ` (${reason})` : ''}`;

	const thinking = document.getElementById('thinking-row');
	if (thinking) {
		thinking.parentNode?.insertBefore(notice, thinking);
	} else {
		document.getElementById('messages')!.appendChild(notice);
	}
	scrollToBottom();
}

function detectExpert(text: string): string | null {
	for (const expert of EXPERT_PROFILES) {
		const matched = expert.autoDetectKeywords.some(kw =>
			text.toLowerCase().includes(kw)
		);
		if (matched) { return expert.id; }
	}
	return null;
}

function showAutoDetectNotice(expertId: string): void {
	const expert = EXPERT_PROFILES.find(e => e.id === expertId);
	if (!expert) { return; }
	const notice = document.createElement('div');
	notice.className = 'notice';
	notice.textContent = `Auto-detected: ${expert.label}`;
	document.getElementById('messages')!.appendChild(notice);
	scrollToBottom();
}

function scrollToBottom(): void {
	const c = document.getElementById('messages')!;
	c.scrollTop = c.scrollHeight;
}

function setLoading(active: boolean): void {
	const bar = document.getElementById('loading-bar')!;
	bar.classList.toggle('active', active);
	const input = document.getElementById('input') as HTMLTextAreaElement;
	input.parentElement!.classList.toggle('input-loading', active);

	const stopBtn = document.getElementById('stop-btn');
	const sendBtn = document.getElementById('send-btn');
	if (stopBtn && sendBtn) {
		stopBtn.style.display = active ? 'flex' : 'none';
		sendBtn.style.display = active ? 'none' : 'flex';
	}

	const hasActiveStream = messages.length > 0 &&
		messages[messages.length - 1].role === 'assistant' &&
		messages[messages.length - 1].content !== '';

	const existing = document.getElementById('thinking-row');
	if (active && !existing && !hasActiveStream) {
		const row = document.createElement('div');
		row.className = 'thinking-row';
		row.id = 'thinking-row';
		row.innerHTML = '<span>Thinking</span><span class="thinking-dots"><span></span><span></span><span></span></span>';
		document.getElementById('messages')!.appendChild(row);
		scrollToBottom();
	} else if (!active && existing) {
		existing.remove();
	}
}
function setInputEnabled(enabled: boolean): void {
	const input = document.getElementById('input') as HTMLTextAreaElement;
	const btn = document.getElementById('send-btn') as HTMLButtonElement;
	input.disabled = !enabled;
	btn.disabled = !enabled;
	if (enabled) { input.focus(); }
}

function appendUserMessage(text: string): void {
	hideWelcome();
	const msg: DisplayMessage = { id: crypto.randomUUID(), role: 'user', content: text, timestamp: Date.now() };
	messages.push(msg);
	document.getElementById('messages')!.appendChild(buildMessageEl(msg));
	scrollToBottom();
	saveState();
}

function sendMessage(): void {
	const input = document.getElementById('input') as HTMLTextAreaElement;
	const text = input.value.trim();
	if (!text || pendingId) { return; }
	input.value = '';
	autoResize(input);
	appendUserMessage(text);

	// Check auto-detection on first user message in session
	if (messages.filter(m => m.role === 'user').length === 1) {
		const detectedId = detectExpert(text);
		if (detectedId && detectedId !== currentExpertId) {
			setActiveExpert(detectedId);
			vscode.postMessage({ type: 'changeExpert', expertId: detectedId });
			showAutoDetectNotice(detectedId);
		}
	}

	setInputEnabled(false);
	vscode.postMessage({ type: 'sendMessage', text, expertId: currentExpertId });
}

function init(): void {
	renderExpertPicker();
	restoreState();
	const input = document.getElementById('input') as HTMLTextAreaElement;
	input.addEventListener('input', () => autoResize(input));

	const selectBtn = document.getElementById('expert-select-btn')!;
	selectBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		toggleExpertMenu();
		toggleHistoryDrawer(false);
	});

	const activeExpertPill = document.getElementById('active-expert-pill');
	if (activeExpertPill) {
		activeExpertPill.addEventListener('click', (e) => {
			e.stopPropagation();
			toggleExpertMenu();
			toggleHistoryDrawer(false);
		});
	}

	const historyBtn = document.getElementById('history-btn')!;
	historyBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		toggleHistoryDrawer();
		toggleExpertMenu(false);
	});

	document.addEventListener('click', (e) => {
		const menu = document.getElementById('expert-menu')!;
		const btn = document.getElementById('expert-select-btn')!;
		const pill = document.getElementById('active-expert-pill');
		const drawer = document.getElementById('history-drawer')!;
		const histBtn = document.getElementById('history-btn')!;

		if (!menu.contains(e.target as Node) && !btn.contains(e.target as Node) && (!pill || !pill.contains(e.target as Node))) {
			toggleExpertMenu(false);
		}
		if (!drawer.contains(e.target as Node) && !histBtn.contains(e.target as Node)) {
			toggleHistoryDrawer(false);
		}
	});

	document.getElementById('send-btn')!.addEventListener('click', sendMessage);

	const stopBtn = document.getElementById('stop-btn');
	if (stopBtn) {
		stopBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'stopGeneration', sessionId: currentSessionId });
			setLoading(false);
			setInputEnabled(true);
		});
	}

	input.addEventListener('keydown', (e: KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
	});

	document.getElementById('new-chat-btn')!.addEventListener('click', () => {
		messages = []; rawChunks = {}; pendingId = null;
		currentSessionId = null;
		renderMessages(); setInputEnabled(true); saveState();
		vscode.postMessage({ type: 'newChat' });
	});

	document.getElementById('refresh-btn')!.addEventListener('click', () => {
		vscode.postMessage({ type: 'refreshModels' });
	});

	const messagesEl = document.getElementById('messages');
	if (messagesEl) {
		messagesEl.addEventListener('click', (e) => {
			const target = e.target as HTMLElement;

			// Handle Copy
			if (target.classList.contains('code-action-copy')) {
				const rawCode = decodeURIComponent(target.dataset.code || '');
				const decodedCode = decodeHtmlEntities(rawCode);
				navigator.clipboard.writeText(decodedCode);
				const originalText = target.textContent;
				target.textContent = 'Copied!';
				setTimeout(() => { target.textContent = originalText; }, 2000);
				return;
			}

			// Handle Run Command
			if (target.classList.contains('code-action-run')) {
				const rawCode = decodeURIComponent(target.dataset.code || '');
				const decodedCode = decodeHtmlEntities(rawCode);
				setLoading(true);
				vscode.postMessage({ type: 'runCommand', command: decodedCode });
				return;
			}

			// Handle Insert Code
			if (target.classList.contains('code-action-insert')) {
				const rawCode = decodeURIComponent(target.dataset.code || '');
				const decodedCode = decodeHtmlEntities(rawCode);
				vscode.postMessage({ type: 'insertCode', text: decodedCode });
				return;
			}

			// Handle Anchor tags for files
			if (target.tagName === 'A') {
				const href = target.getAttribute('href');
				if (href && (href.startsWith('file://') || !href.includes(':'))) {
					e.preventDefault();
					vscode.postMessage({ type: 'openFile', path: href });
					return;
				}
			}
		});
	}

	window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
		const msg = event.data;

		// If message is bound to a different session, we ignore visual rendering, but keep list updates
		const sessionBoundTypes = ['thinking', 'chunk', 'messageComplete', 'messageError', 'fallback', 'toolConfirm', 'toolStart', 'toolEnd'];
		if (sessionBoundTypes.includes(msg.type) && (msg as any).sessionId && (msg as any).sessionId !== currentSessionId) {
			return;
		}

		switch (msg.type) {
			case 'thinking':
				pendingId = msg.id;
				setLoading(true);
				createAssistantBubble(msg.id);
				break;
			case 'chunk':
				appendChunk(msg.id, msg.text);
				break;
			case 'messageComplete':
				finalizeMessage(msg.id, msg.model, msg.provider);
				break;
			case 'messageError':
				showError(msg.id, msg.error);
				break;
			case 'fallback':
				showFallbackNotice(msg.from, msg.to, (msg as any).reason);
				break;
			case 'modelsRefreshed':
				const el = document.getElementById('model-count');
				if (el) { el.textContent = `${msg.count} models`; }
				break;
			case 'setExpert':
				setActiveExpert(msg.expertId);
				saveState();
				break;
			case 'sessionsUpdated':
				savedSessions = msg.sessions;
				renderHistoryDrawer();
				break;
			case 'loadSession':
				currentSessionId = msg.session.id;
				messages = msg.session.messages;
				setActiveExpert(msg.session.expertId);
				renderMessages();
				setLoading(!!(msg as any).isGenerating);
				saveState();
				break;
			case 'toolConfirm':
				hideWelcome();
				document.getElementById('thinking-row')?.remove();
				messages.push({
					id: msg.id,
					role: 'tool-confirm',
					content: '',
					timestamp: Date.now(),
					toolName: msg.name,
					toolArgs: msg.args,
					toolDiff: msg.diff,
					isOutOfWorkspace: msg.isOutOfWorkspace,
					standalone: (msg as any).standalone
				});
				renderMessages();
				if ((msg as any).standalone) {
					setLoading(true);
				}
				break;
			case 'toolStart':
				hideWelcome();
				document.getElementById('thinking-row')?.remove();
				{
					let startMsg = messages.find(m => m.id === msg.id);
					if (!startMsg) {
						startMsg = {
							id: msg.id,
							role: 'tool-log',
							content: '',
							timestamp: Date.now(),
							toolName: msg.name,
							toolArgs: msg.args,
							toolStatus: 'pending',
							standalone: (msg as any).standalone
						};
						messages.push(startMsg);
					} else {
						startMsg.role = 'tool-log';
						startMsg.toolStatus = 'pending';
					}
				}
				renderMessages();
				if ((msg as any).standalone) {
					setLoading(true);
				}
				break;
			case 'toolEnd':
				{
					let endMsg = messages.find(m => m.id === msg.id);
					if (!endMsg) {
						endMsg = {
							id: msg.id,
							role: 'tool-log',
							content: msg.result,
							timestamp: Date.now(),
							toolName: msg.name,
							toolSuccess: msg.success,
							toolStatus: msg.status,
							standalone: (msg as any).standalone
						};
						messages.push(endMsg);
					} else {
						endMsg.role = 'tool-log';
						endMsg.content = msg.result;
						endMsg.toolSuccess = msg.success;
						endMsg.toolStatus = msg.status;
					}
					if (endMsg.standalone) {
						setLoading(false);
					}
				}
				renderMessages();
				break;
		}
	});
}

document.addEventListener('DOMContentLoaded', init);
