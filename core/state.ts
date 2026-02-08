import type { ChatRole, ChatState, Message } from "./types.js";

export const state: ChatState = {
  conversationId: createConversationId(),
  messages: [],
  isSending: false,
};

export function createConversationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMessage(role: ChatRole, content: string): Message {
  return {
    id: createConversationId(),
    role,
    content,
    createdAt: new Date().toISOString(),
  };
}
