export type AiMessage = { role: "system" | "user" | "assistant"; content: unknown };
export type AiChatOptions = { maxTokens?: number; temperature?: number; stream?: boolean };
export type AiChatInput = { connectorId: string; messages: AiMessage[]; options?: AiChatOptions; requestId?: string; generation?: number; ownerId?: string };
export type AiChatResponse = { text: string; usage: unknown; requestId: string };
export type AiTokenEvent = { connectorId: string; requestId: string; generation: number; text: string };
