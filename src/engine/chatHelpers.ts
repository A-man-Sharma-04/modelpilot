import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ToolCall } from '../providers/IProvider';
import { getWorkspaceRoot } from './AgentExecutor';

export const TOOLS_INSTRUCTION = `
[TOOL CALLING INSTRUCTIONS]

You are an autonomous agent operating inside a VS Code workspace. A [WORKSPACE CONTEXT] block is injected at the top of every system prompt — it contains the active OS, shell, stack, and open files. Read it before every action and adapt accordingly.

BEFORE ACTING:
- Always call 'list_directory' or 'read_file' before creating files, directories, or cloning repos to verify they don't already exist. Never create something that already exists.
- Before running any terminal command, check whether it depends on a previous step that was rejected or failed. If it does, skip it and explain why.
- Never assume a prior step succeeded. Verify outcomes before building on them.
- Before writing any file, call 'read_file' first if it might already exist — never overwrite blindly.

TOOL USAGE:
- When asked to write, create, build, implement, edit, or fix code: use 'create_file' or 'write_file' directly. Do not explain what you would write — write it.
- When editing existing files: use 'read_file' first to get current content, then 'write_file' with the full modified content. Never write partial files.
- For terminal commands: use non-interactive flags always (e.g. 'npm init -y', 'apt-get install -y', 'git clone --quiet'). Never run commands that prompt for input — stdin is unavailable.
- For 'search_workspace': use it to locate symbols, function names, or imports before assuming their location.

DEPENDENCY AWARENESS:
- Before each action, mentally verify: does this step depend on a previous step? Did that step succeed?
- If a tool call is rejected by the user ('Tool execution rejected by user.'): immediately stop ALL dependent steps. Identify which remaining steps are fully independent. Continue only those. Explicitly state what you are skipping and why.
- Never silently proceed with a dependent action after a rejection.
- Never retry a failed command without first diagnosing the failure.

REDUNDANCY PREVENTION:
- Directory or file already exists? Work with it directly. Never recreate it.
- Repository already cloned? Do not clone again. Work with the existing files.
- Package already installed? Verify with 'list_directory' or check lock files. Do not reinstall.

STEP SEQUENCING:
- Execute one tool call at a time. Wait for the result. Analyze it. Then decide the next step.
- Never batch multiple destructive or dependent actions in one turn.
- If a step fails unexpectedly, diagnose before retrying. Do not retry the same command blindly.

OS AND TERMINAL RULES — DERIVED FROM [WORKSPACE CONTEXT]:
- Linux/macOS: use bash/zsh syntax, forward slashes, use apt/brew/pip/npm/cargo as appropriate for the detected stack.
- Windows: use PowerShell syntax, backslashes, use winget/choco/pip/npm as appropriate.
- Never suggest a Windows command when the OS is Linux, or vice versa.
- Never suggest a package manager not appropriate for the detected stack.
- Always prefer the shell shown in [WORKSPACE CONTEXT] — do not assume bash if zsh or fish is active.

CONSTRAINTS:
- File tools are locked to the workspace root. Use 'run_terminal_command' for paths outside it.
- Never expose secrets, credentials, or API keys in commands or files.
- Never run rm -rf, format drives, or destructive operations without explicit user confirmation.
- Never commit, push, deploy, or publish without explicit user instruction.

ABSOLUTE RULE — NEVER PRINT CODE IN CHAT:
- When tools are available, you must NEVER output code inside fenced code blocks (\`\`\`).
- Instead, use 'create_file' or 'write_file' tools for EVERY piece of code, script, config, or file content.
- The ONLY acceptable chat output is explanatory text, plans, or brief summaries.
- If you are about to write a fenced code block — STOP and use a tool instead.
- Never tell the user to "create a file with this content" or "run this command manually". Use the tools.
- Violations of this rule force the user to manually copy-paste code, which defeats the purpose of an agent.

FORMAT TO CALL TOOLS:
To invoke a tool, output an XML block in the following format:
<use_tool>
<name>tool_name</name>
<arguments>
{
  "parameter_name": "value"
}
</arguments>
</use_tool>

Example to create a file:
<use_tool>
<name>create_file</name>
<arguments>
{ 
  "path": "src/index.js",
  "content": "console.log('hello');"
}
</arguments>
</use_tool>

Tools available:
1. read_file:            {"path": "rel/path"}
2. write_file:           {"path": "rel/path", "content": "full file content"}
3. create_file:          {"path": "rel/path", "content": "content"}
4. delete_file:          {"path": "rel/path"}
5. search_workspace:     {"query": "search term"}
6. list_directory:       {"path": "rel/path"}
7. get_open_files:       {}
8. run_terminal_command: {"command": "non-interactive shell command"}

SELF-CORRECTION PROTOCOL:
- When a terminal command fails (non-zero exit code), a [SELF-CORRECTION REQUIRED] block will be appended to the tool result.
- You MUST follow its instructions: analyze the error output, read the failing file(s), fix the code, write the corrected file(s), and re-run the exact same command.
- Do NOT skip the re-run step. The correction loop continues until the command succeeds or the retry limit is reached.
- If you cannot fix the error after the allowed retries, explain the root cause clearly and suggest a manual fix.
`;

export const MODEL_RELIABILITY_INSTRUCTIONS = `
[MODEL RELIABILITY INSTRUCTIONS]

Follow these instructions to ensure high-quality, reliable, and parseable output:

1. CHAIN-OF-THOUGHT FORCING FOR COMPLEX TASKS:
- For any task involving code changes, bugs, or architecture, you must first output a PLAN block outlining what you will do and why, followed by the IMPLEMENTATION.
- Never skip the plan for tasks touching more than one file.

2. EXPLICIT OUTPUT CONTRACTS:
- In Plan Mode or Ask Mode (where tools are NOT used): every code response in the chat must specify the exact file path as a comment on line 1 and always use fenced code blocks with language tags.
- In Agent Mode (where tools ARE used): do NOT output code in the chat using fenced code blocks. You must use the 'create_file' or 'write_file' tools to write or edit files. Never wrap code inside tool arguments (such as "content") in markdown fenced code blocks; write the raw code directly.
- Never truncate cod e with comments like "..." or "// rest of code here". Always output full file contents or fully complete blocks.
- If a change spans multiple files, address each file separately.

3. SELF-VERIFICATION STEP:
- Before finalizing any code output, silently verify:
  * Does this code compile/run given what you know about the project?
  * Does it introduce any new dependencies not already present?
  * Does it break any existing function signatures visible in context?
- If any check fails, fix it before responding.

4. CONTEXT WINDOW DISCIPLINE:
- When the user references "this", "it", "the function", or "the file", always resolve the reference explicitly before acting.
- If ambiguous, ask one clarifying question before proceeding. Never assume which file or function is meant.

5. FAILURE MODES DOCUMENTATION - NEVER DO THESE:
- Do not explain what you are about to do and then not do it.
- Do not write pseudocode when real code was requested.
- Do not add TODO comments as a substitute for implementation.
- Do not modify files outside the scope of the request.
- Do not introduce console.log or print debug statements in production code.
- Do not change function signatures unless explicitly asked.
- Do NOT print code in fenced code blocks when file tools are available. Use create_file or write_file instead. ALWAYS.
- Do NOT instruct the user to manually create files, run scripts, or copy-paste code. Use the tools to do it yourself.

6. ROLE ANCHORING WITH PERSONA REINFORCEMENT:
- Act as a senior engineer. Senior engineers:
  * Fix the root cause, not the symptom.
  * Consider downstream effects of every change.
  * Prefer explicit over implicit.
  * Leave code cleaner than they found it.
`;

export function isGreetingOrChitchat(text: string): boolean {
	const cleaned = text.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");

	const exactGreetings = new Set([
		'hi', 'hello', 'hey', 'hola', 'yo', 'sup', 'greetings', 'morning', 'afternoon', 'evening',
		'good morning', 'good afternoon', 'good evening', 'howdy',
		'how are you', 'how are you doing', 'hows it going', 'whats up', 'whats new',
		'who are you', 'what is your name', 'what are you', 'test', 'ping',
		'hi there', 'hello there', 'hey there', 'yo there'
	]);

	if (exactGreetings.has(cleaned)) {
		return true;
	}

	const conversationalWords = new Set([
		'hi', 'hello', 'hey', 'hola', 'yo', 'sup', 'greetings', 'morning', 'afternoon', 'evening',
		'good', 'howdy', 'how', 'are', 'you', 'doing', 'is', 'it', 'going', 'whats', 'up', 'new',
		'who', 'what', 'name', 'test', 'ping', 'there', 'this', 'a', 'the', 'to', 'your', 'today', 'buddy', 'friend',
		'great', 'work', 'job', 'awesome', 'hooray', 'thanks', 'thank', 'congrats', 'congratulations', 'cool', 'nice',
		'amazing', 'perfect', 'done', 'well', 'yay'
	]);

	const words = cleaned.split(/\s+/).filter(w => w.length > 0);
	if (words.length > 0 && words.every(w => conversationalWords.has(w))) {
		return true;
	}

	// Smart chitchat heuristic
	const isGeneralQuestion = /^(what is|who is|explain|tell me about|how do i|how does|why is|why do|what does)\b/i.test(cleaned);
	const mentionsWorkspace = /\b(file|folder|code|directory|project|workspace|repo|run|compile|test|build|error|debug|terminal|shell|command|function|class|method|variable|import|require)\b/i.test(cleaned);
	if (isGeneralQuestion && !mentionsWorkspace) {
		return true;
	}

	return false;
}

export function checkIfCommandIsOutOfWorkspace(command: string, agentCwd: string = '.'): boolean {
	try {
		const root = getWorkspaceRoot();
		const currentCwd = path.resolve(root, agentCwd);

		// Look for absolute paths (starting with / or C:\ or [letter]:\) preceded by space, start of line, or quotes
		const absPathRegex = /(?:^|\s|["'])(?:\/|[A-Za-z]:\\)[\w_.\-\/\\*]*/g;
		let match;
		while ((match = absPathRegex.exec(command)) !== null) {
			let matchedPath = match[0];
			// Clean leading/trailing spaces and quotes
			matchedPath = matchedPath.replace(/^[ \t"']*/, '').replace(/["']*$/, '');
			if (!matchedPath) {
				continue;
			}
			try {
				const resolved = path.resolve(currentCwd, matchedPath);
				const isInside = resolved === root || resolved.startsWith(root + path.sep);
				if (!isInside) {
					return true;
				}
			} catch {
				// Path resolution failed (invalid characters, etc.) — continue checking
			}
		}

		// Check if any relative upward path from currentCwd goes outside root
		if (command.includes('..')) {
			const tokens = command.split(/[\s|&;<>()"'`]+/);
			for (const t of tokens) {
				if (t.includes('..')) {
					try {
						const resolved = path.resolve(currentCwd, t);
						const isInside = resolved === root || resolved.startsWith(root + path.sep);
						if (!isInside) {
							return true;
						}
					} catch {
						return true;
					}
				}
			}
		}

		// Look for home directory shortcuts or environment variables pointing outside workspace
		if (command.includes('~/') || command.includes('$HOME') || command.includes('%USERPROFILE%')) {
			return true;
		}
	} catch (err) {
		// If no workspace is open, then any command is technically out of workspace
		return true;
	}
	return false;
}

export function cleanJsonString(str: string): string {
	let cleaned = str.trim();
	if (cleaned.startsWith('```')) {
		cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
	}
	return cleaned.trim();
}

export function extractJsonObjects(text: string): any[] {
	const objects: any[] = [];
	let openBraces = 0;
	let startIdx = -1;
	let inString = false;
	let escapeNext = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (escapeNext) {
			escapeNext = false;
			continue;
		}
		if (char === '\\') {
			escapeNext = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (!inString) {
			if (char === '{') {
				if (openBraces === 0) {
					startIdx = i;
				}
				openBraces++;
			} else if (char === '}') {
				if (openBraces > 0) {
					openBraces--;
					if (openBraces === 0 && startIdx !== -1) {
						const candidate = text.slice(startIdx, i + 1);
						try {
							const cleaned = cleanJsonString(candidate);
							const obj = JSON.parse(cleaned);
							if (obj && typeof obj === 'object') {
								objects.push(obj);
							}
						} catch {
							// Ignore invalid JSON
						}
						startIdx = -1;
					}
				}
			}
		}
	}
	return objects;
}

export function extractValueFromMalformedJson(jsonStr: string, key: string): string | null {
	const regex = new RegExp(`(?:"|')?${key}(?:"|')?\\s*:\\s*["']?([\\s\\S]*?)$`, 'i');
	const match = jsonStr.match(regex);
	if (match) {
		let val = match[1].trim();
		if (val.endsWith('}')) {
			val = val.slice(0, -1).trim();
		}
		if (val.endsWith('"') || val.endsWith("'")) {
			val = val.slice(0, -1).trim();
		}
		if (val.startsWith('"') || val.startsWith("'")) {
			val = val.slice(1).trim();
		}
		return val;
	}
	return null;
}

export function parseMalformedJson(jsonStr: string): Record<string, string> {
	const result: Record<string, string> = {};
	let i = 0;
	const len = jsonStr.length;

	function skipWhitespace() {
		while (i < len && /\s/.test(jsonStr[i])) {
			i++;
		}
	}

	function parseString(): string {
		let quote = '';
		if (jsonStr[i] === '"' || jsonStr[i] === "'") {
			quote = jsonStr[i];
			i++;
		}
		let str = '';
		while (i < len) {
			const char = jsonStr[i];
			if (quote) {
				if (char === quote) {
					i++;
					break;
				}
				if (char === '\\') {
					if (i + 1 < len) {
						const nextChar = jsonStr[i + 1];
						if (nextChar === '"' || nextChar === "'" || nextChar === '\\' || nextChar === 'n' || nextChar === 't' || nextChar === 'r') {
							if (nextChar === 'n') {
								str += '\n';
							} else if (nextChar === 't') {
								str += '\t';
							} else if (nextChar === 'r') {
								str += '\r';
							} else {
								str += nextChar;
							}
							i += 2;
							continue;
						}
					}
				}
				str += char;
				i++;
			} else {
				if (char === ',' || char === ':' || char === '}' || char === ']' || /\s/.test(char)) {
					break;
				}
				str += char;
				i++;
			}
		}
		return str;
	}

	skipWhitespace();
	if (jsonStr[i] === '{') {
		i++;
	}

	while (i < len) {
		skipWhitespace();
		if (jsonStr[i] === '}') {
			i++;
			break;
		}
		if (jsonStr[i] === ',') {
			i++;
			continue;
		}

		const key = parseString().trim();
		if (!key) {
			i++;
			continue;
		}

		skipWhitespace();
		if (jsonStr[i] === ':') {
			i++;
		}

		skipWhitespace();

		let value = '';
		if (jsonStr[i] === '"' || jsonStr[i] === "'") {
			value = parseString();
		} else if (jsonStr[i] === '{') {
			const start = i;
			let braceCount = 0;
			let inStr = false;
			let escape = false;
			let quoteChar = '';
			while (i < len) {
				const c = jsonStr[i];
				if (escape) {
					escape = false;
					i++;
					continue;
				}
				if (c === '\\') {
					escape = true;
					i++;
					continue;
				}
				if (inStr) {
					if (c === quoteChar) {
						inStr = false;
					}
				} else {
					if (c === '"' || c === "'") {
						inStr = true;
						quoteChar = c;
					} else if (c === '{') {
						braceCount++;
					} else if (c === '}') {
						braceCount--;
						if (braceCount === 0) {
							i++;
							break;
						}
					}
				}
				i++;
			}
			value = jsonStr.slice(start, i);
		} else if (jsonStr[i] === '[') {
			const start = i;
			let bracketCount = 0;
			let inStr = false;
			let escape = false;
			let quoteChar = '';
			while (i < len) {
				const c = jsonStr[i];
				if (escape) {
					escape = false;
					i++;
					continue;
				}
				if (c === '\\') {
					escape = true;
					i++;
					continue;
				}
				if (inStr) {
					if (c === quoteChar) {
						inStr = false;
					}
				} else {
					if (c === '"' || c === "'") {
						inStr = true;
						quoteChar = c;
					} else if (c === '[') {
						bracketCount++;
					} else if (c === ']') {
						bracketCount--;
						if (bracketCount === 0) {
							i++;
							break;
						}
					}
				}
				i++;
			}
			value = jsonStr.slice(start, i);
		} else {
			const start = i;
			while (i < len && jsonStr[i] !== ',' && jsonStr[i] !== '}') {
				i++;
			}
			value = jsonStr.slice(start, i).trim();
		}

		result[key] = value;
	}

	return result;
}

export function parseRawArgsFallback(name: string, rawArgs: string): string {
	const cleaned = rawArgs.trim();
	const parsed = parseMalformedJson(cleaned);
	if (name === 'run_terminal_command') {
		const extracted = parsed['command'];
		return JSON.stringify({ command: extracted !== undefined ? extracted : cleaned });
	} else if (name === 'read_file' || name === 'delete_file' || name === 'list_directory') {
		const extracted = parsed['path'];
		return JSON.stringify({ path: extracted !== undefined ? extracted : cleaned });
	} else if (name === 'search_workspace') {
		const extracted = parsed['query'];
		return JSON.stringify({ query: extracted !== undefined ? extracted : cleaned });
	} else if (name === 'create_file' || name === 'write_file') {
		return JSON.stringify({
			path: parsed['path'] || '',
			content: parsed['content'] || ''
		});
	}
	return '{}';
}

export function cleanToolCallTags(text: string): string {
	const blockRegex = /<(use_tool|_tool|tool)\b[^>]*>([\s\S]*?)(?:<\/\1>|$)/gi;
	let cleaned = text.replace(blockRegex, '');

	const tagRegex = /<\/?(use_tool|_tool|tool|name|arguments)\b[^>]*>/gi;
	cleaned = cleaned.replace(tagRegex, '');

	return cleaned.trim();
}

export function parseTextToolCalls(text: string): ToolCall[] {
	const toolCalls: ToolCall[] = [];
	let index = 0;

	// Scan for XML-based use_tool blocks: <use_tool>content</use_tool> or cut off at the end
	const blockRegex = /<(use_tool|_tool|tool)\b[^>]*>([\s\S]*?)(?:<\/\1>|$)/gi;
	let match;

	while ((match = blockRegex.exec(text)) !== null) {
		const content = match[2].trim();
		if (!content) { continue; }

		// Extract tool name from <name>...</name> or direct string match
		let name = '';
		const nameMatch = content.match(/<name>([\s\S]*?)<\/name>/i);
		if (nameMatch) {
			name = nameMatch[1].trim();
		} else {
			// Fallback: look for known tool names in the content
			const knownTools = [
				'read_file', 'write_file', 'create_file', 'delete_file',
				'search_workspace', 'list_directory', 'get_open_files', 'run_terminal_command'
			];
			for (const t of knownTools) {
				if (content.includes(t)) {
					name = t;
					break;
				}
			}
		}

		if (!name) { continue; }

		// Extract arguments from <arguments>...</arguments> or look for first JSON object
		let argsStr = '{}';
		const argsMatch = content.match(/<arguments>([\s\S]*?)(?:<\/arguments>|$)/i);
		if (argsMatch) {
			const rawArgs = argsMatch[1].trim();
			const jsonMatch = rawArgs.match(/(\{[\s\S]*?\})/);
			if (jsonMatch) {
				try {
					const cleanJson = cleanJsonString(jsonMatch[1]);
					JSON.parse(cleanJson); // validate
					argsStr = cleanJson;
				} catch {
					argsStr = parseRawArgsFallback(name, rawArgs);
				}
			} else {
				argsStr = parseRawArgsFallback(name, rawArgs);
			}
		} else {
			const jsonMatch = content.match(/(\{[\s\S]*?\})/);
			if (jsonMatch) {
				try {
					const cleanJson = cleanJsonString(jsonMatch[1]);
					JSON.parse(cleanJson); // validate
					argsStr = cleanJson;
				} catch {
					argsStr = parseRawArgsFallback(name, jsonMatch[1]);
				}
			} else {
				const braceIdx = content.indexOf('{');
				if (braceIdx !== -1) {
					argsStr = parseRawArgsFallback(name, content.slice(braceIdx));
				} else {
					argsStr = parseRawArgsFallback(name, content);
				}
			}
		}

		toolCalls.push({
			id: `call_${name}_${index++}_${crypto.randomBytes(4).toString('hex')}`,
			type: 'function',
			function: {
				name,
				arguments: argsStr
			}
		});
	}

	// 2. Strip XML matches from text to prevent duplicate parsing of JSON inside XML arguments
	let remainingText = text.replace(blockRegex, '');

	// 3. Scan remaining text for raw JSON tool calls
	const jsonObjects = extractJsonObjects(remainingText);
	const knownTools = [
		'read_file', 'write_file', 'create_file', 'delete_file',
		'search_workspace', 'list_directory', 'get_open_files', 'run_terminal_command'
	];

	for (const obj of jsonObjects) {
		let name = '';
		let args: any = {};

		if (obj.name && typeof obj.name === 'string' && knownTools.includes(obj.name)) {
			name = obj.name;
			args = obj.parameters || obj.arguments || obj.args || obj;
		} else if (obj.tool && typeof obj.tool === 'string' && knownTools.includes(obj.tool)) {
			name = obj.tool;
			args = obj.arguments || obj.parameters || obj.args || obj;
		} else if (obj.action && typeof obj.action === 'string' && knownTools.includes(obj.action)) {
			name = obj.action;
			args = obj.arguments || obj.parameters || obj.args || obj;
		} else if (obj.function && typeof obj.function === 'object' && obj.function.name && typeof obj.function.name === 'string' && knownTools.includes(obj.function.name)) {
			name = obj.function.name;
			args = obj.function.arguments || obj.function.args || obj.arguments || obj.parameters || {};
		}

		// Ensure we don't self-reference name/tool/action inside arguments if args is the object itself
		if (args === obj) {
			const { name: _n, tool: _t, action: _a, function: _f, ...rest } = obj;
			args = rest;
		}

		if (name) {
			let argsStr = '{}';
			if (typeof args === 'string') {
				argsStr = args;
			} else if (typeof args === 'object' && args !== null) {
				argsStr = JSON.stringify(args);
			}

			toolCalls.push({
				id: `call_${name}_${index++}_${crypto.randomBytes(4).toString('hex')}`,
				type: 'function',
				function: {
					name,
					arguments: argsStr
				}
			});
		}
	}

	return toolCalls;
}

export function findFirstToolTag(text: string): number {
	const tags = ['<use_tool', '<_tool', '<tool'];
	let firstIndex = -1;
	for (const tag of tags) {
		const idx = text.toLowerCase().indexOf(tag);
		if (idx !== -1) {
			if (firstIndex === -1 || idx < firstIndex) {
				firstIndex = idx;
			}
		}
	}
	return firstIndex;
}

export function getSafeStreamLength(text: string): number {
	const firstToolTagIdx = findFirstToolTag(text);
	if (firstToolTagIdx !== -1) {
		return firstToolTagIdx;
	}

	const lower = text.toLowerCase();
	const lastOpenBracket = lower.lastIndexOf('<');
	if (lastOpenBracket !== -1 && lastOpenBracket >= text.length - 10) {
		const suffix = lower.slice(lastOpenBracket);
		const possibleTags = ['<use_tool', '<_tool', '<tool'];
		for (const pt of possibleTags) {
			if (pt.startsWith(suffix)) {
				return lastOpenBracket;
			}
		}
	}

	return text.length;
}

export interface CodeBlockEntry {
	path: string;
	content: string;
	language: string;
}

/**
 * Extracts fenced code blocks from model output that contain file path indicators.
 * Used to intercept code that the model printed in chat instead of using create_file/write_file.
 *
 * Detects file paths from:
 * - Line 1 comment: `// path/to/file.ts`, `# path/to/file.py`, `/* path *\/`, `-- path`
 * - Preceding markdown: **`path`**: or `Create \`path\``:` or `File: path` patterns
 */
export function extractCodeBlocksWithPaths(text: string): CodeBlockEntry[] {
	const results: CodeBlockEntry[] = [];

	// Match fenced code blocks with optional language tag
	const codeBlockRegex = /```(\w*)\s*\n([\s\S]*?)```/g;
	let match;

	while ((match = codeBlockRegex.exec(text)) !== null) {
		const language = match[1] || '';
		const content = match[2];
		const blockStartIdx = match.index;

		let filePath = '';

		// Strategy 1: Check the first line of the code block for a file path comment
		const firstLine = content.split('\n')[0].trim();
		const commentPathPatterns = [
			// // path/to/file.ext or // File: path/to/file.ext
			/^\/\/\s*(?:File:\s*)?([\w.\-\/\\]+\.\w+)/,
			// # path/to/file.ext or # File: path/to/file.ext
			/^#\s*(?:File:\s*)?([\w.\-\/\\]+\.\w+)/,
			// /* path/to/file.ext */ or /* File: path */
			/^\/\*\s*(?:File:\s*)?([\w.\-\/\\]+\.\w+)\s*\*\//,
			// -- path/to/file.ext (SQL, Lua)
			/^--\s*(?:File:\s*)?([\w.\-\/\\]+\.\w+)/,
			// <!-- path/to/file.ext --> (HTML, XML)
			/^<!--\s*(?:File:\s*)?([\w.\-\/\\]+\.\w+)\s*-->/,
		];
		for (const pattern of commentPathPatterns) {
			const pathMatch = firstLine.match(pattern);
			if (pathMatch) {
				filePath = pathMatch[1];
				break;
			}
		}

		// Strategy 2: Check the text immediately preceding the code block
		if (!filePath) {
			// Look at the 200 chars before the code block
			const precedingText = text.slice(Math.max(0, blockStartIdx - 200), blockStartIdx);
			const precedingPatterns = [
				// **`path/to/file.ext`**: or **path/to/file.ext**:
				/\*\*`?([\w.\-\/\\]+\.\w+)`?\*\*\s*:?\s*$/,
				// `path/to/file.ext`: or `path/to/file.ext`
				/`([\w.\-\/\\]+\.\w+)`\s*:?\s*$/,
				// Create path/to/file.ext: or File: path/to/file.ext
				/(?:Create|File|Update|Modify|Edit|Write|Save|In)\s*:?\s*`?([\w.\-\/\\]+\.\w+)`?\s*:?\s*$/i,
				// path/to/file.ext: (standalone on last line)
				/(?:^|\n)\s*([\w.\-\/\\]+\.\w+)\s*:?\s*$/,
			];
			for (const pattern of precedingPatterns) {
				const pathMatch = precedingText.match(pattern);
				if (pathMatch) {
					filePath = pathMatch[1];
					break;
				}
			}
		}

		if (filePath) {
			// Clean up the content — remove the file path comment from line 1 if present
			let cleanedContent = content;
			for (const pattern of commentPathPatterns) {
				if (pattern.test(firstLine)) {
					const lines = cleanedContent.split('\n');
					lines.shift(); // Remove the file path comment line
					cleanedContent = lines.join('\n');
					break;
				}
			}

			// Normalize the path (remove leading ./ or /)
			filePath = filePath.replace(/^\.[\/\\]/, '').replace(/^[\/\\]/, '');

			results.push({
				path: filePath,
				content: cleanedContent.replace(/\n$/, ''), // trim trailing newline
				language,
			});
		}
	}

	return results;
}
