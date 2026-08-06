/**
 * debug.ts
 *
 * Shared, safe debug logging for ModelPilot.
 *
 * - The log directory is parameterized (no hardcoded /home/... paths).
 *   By default it lives under os.tmpdir(); the extension calls
 *   initDebugLogger(context.logUri.fsPath) at activation so logs go to
 *   VS Code's per-extension log directory instead.
 * - Every entry is scrubbed: API keys, Bearer tokens and known secret
 *   fields are redacted before being written to disk.
 * - Payloads are size-limited so chat messages/responses never dump
 *   arbitrarily large (or sensitive) content to disk.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let logDirectory: string = path.join(os.tmpdir(), 'modelpilot');

export function initDebugLogger(directory?: string): void {
	if (directory && directory.trim().length > 0) {
		logDirectory = path.join(directory, 'modelpilot');
	} else {
		logDirectory = path.join(os.tmpdir(), 'modelpilot');
	}
	try {
		fs.mkdirSync(logDirectory, { recursive: true });
	} catch {
		// Ignore - debug logging must never break the extension.
	}
}

const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 6;

export function scrubSecrets(value: string): string {
	let out = value;

	// "Bearer <token>" style tokens (HTTP auth headers, URLs, payloads).
	out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+={0,2}\b/gi, '[REDACTED]');

	// OpenAI-style sk- API keys.
	out = out.replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, '[REDACTED]');

	// Generic "name: value" / "name=value" pairs for known secret fields.
	out = out.replace(
		/\b(api[_-]?key|apikey|auth(?:orization)?|x-api-key|access[_-]?token|secret|password|passwd|client[_-]?secret|token)\b\s*[:=]\s*["']?[A-Za-z0-9\-._~+/=]{8,}["']?/gi,
		(match: string, name: string) => `${name}: [REDACTED]`
	);

	return out;
}

function truncateString(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) {
		return value;
	}
	return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === 'string') {
		return truncateString(value);
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'bigint') {
		return String(value);
	}
	if (typeof value === 'function' || typeof value === 'symbol') {
		return `[${typeof value}]`;
	}
	if (depth >= MAX_DEPTH) {
		return '[MaxDepth]';
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			return '[Circular]';
		}
		seen.add(value);
		const out: unknown[] = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen));
		seen.delete(value);
		if (value.length > MAX_ARRAY_ITEMS) {
			out.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
		}
		return out;
	}
	if (typeof value === 'object') {
		if (seen.has(value)) {
			return '[Circular]';
		}
		seen.add(value);
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>)) {
			out[key] = sanitize((value as Record<string, unknown>)[key], depth + 1, seen);
		}
		seen.delete(value);
		return out;
	}
	return String(value);
}

export function safeSerialize(value: unknown): string {
	try {
		const clean = sanitize(value, 0, new WeakSet());
		return scrubSecrets(JSON.stringify(clean));
	} catch {
		return '[Serialization Error]';
	}
}

export function debugLog(logName: string, message: string): void {
	try {
		const safeName = logName.replace(/[^A-Za-z0-9_.-]/g, '_');
		const line = `[${new Date().toISOString()}] ${scrubSecrets(message)}\n`;
		fs.appendFileSync(path.join(logDirectory, `${safeName}.log`), line);
	} catch {
		// Ignore - debug logging must never break the extension.
	}
}
