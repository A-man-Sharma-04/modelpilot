import { ModelProfile } from '../data/modelProfiles';

export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string; // JSON string
	};
}

export interface Message {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	name?: string;
	tool_call_id?: string;
	tool_calls?: ToolCall[];
}

export interface LiveModel {
	id: string;
	available: boolean;
}

export interface Model extends ModelProfile {
	available: boolean;
}

export interface ChatOptions {
	stream?: boolean;
	onChunk?: (text: string) => void;
	maxTokens?: number;
	abortSignal?: AbortSignal;
	timeout?: number;
}

export interface Tool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: any;
	};
}

export interface ChatResult {
	content: string;
	toolCalls?: ToolCall[];
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	provider?: string;
	modelId?: string;
}

export interface IProvider {
	readonly name: string;
	isConfigured(): boolean;
	listModels(): Promise<LiveModel[]>;
	chat(
		modelId: string,
		messages: Message[],
		tools?: Tool[],
		context?: any,
		options?: ChatOptions,
	): Promise<ChatResult>;
	getCooldownRemainingMs(): number;
}
