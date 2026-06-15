import { Message, ToolCall } from '../providers/IProvider';
import { getExpertProfile, DEFAULT_EXPERT_ID } from '../data/expertProfiles';

export interface SessionMessage extends Message {
	id: string;
	timestamp: number;
	model?: string;
	provider?: string;
}

export class ChatSession {
	readonly id: string;
	readonly createdAt: number;
	private _messages: SessionMessage[] = [];
	public expertId: string;
	public activeModelId?: string;
	public activeProvider?: string;

	constructor(expertId: string = DEFAULT_EXPERT_ID) {
		this.id = crypto.randomUUID();
		this.createdAt = Date.now();
		this.expertId = expertId;
	}

	addMessage(
		role: Message['role'],
		content: string,
		model?: string,
		provider?: string,
		name?: string,
		tool_call_id?: string,
		tool_calls?: ToolCall[]
	): SessionMessage {
		const msg: SessionMessage = {
			id: crypto.randomUUID(),
			role,
			content,
			timestamp: Date.now(),
			model,
			provider,
			name,
			tool_call_id,
			tool_calls,
		};
		this._messages.push(msg);
		return msg;
	}

	getMessages(): SessionMessage[] {
		return [...this._messages];
	}

	// Returns role, content, name, tool_call_id, and tool_calls for API calls — injecting the expert's system prompt at the beginning
	toApiMessages(): Message[] {
		const apiMsgs = this._messages.map(m => {
			const msg: Message = { role: m.role, content: m.content };
			if (m.name !== undefined) { msg.name = m.name; }
			if (m.tool_call_id !== undefined) { msg.tool_call_id = m.tool_call_id; }
			if (m.tool_calls !== undefined) { msg.tool_calls = m.tool_calls; }
			return msg;
		});
		const expert = getExpertProfile(this.expertId);
		if (expert && expert.systemPrompt) {
			return [
				{ role: 'system', content: expert.systemPrompt },
				...apiMsgs,
			];
		}
		return apiMsgs;
	}

	clear(): void {
		this._messages = [];
	}

	load(id: string, createdAt: number, expertId: string, messages: SessionMessage[]): void {
		(this as any).id = id;
		(this as any).createdAt = createdAt;
		this.expertId = expertId;
		this._messages = [...messages];
	}
}
