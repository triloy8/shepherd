export type ChatRole = "system" | "user" | "assistant";

export interface Message {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  status?: "pending" | "error";
  error?: string;
}

export interface StoredTranscript {
  conversationId: string;
  messages: Message[];
  savedAt: string;
}

export interface ChatConfig {
  apiBaseUrl: string;
  apiPath: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  systemPrompt?: string;
}

export interface ChatState {
  conversationId: string;
  messages: Message[];
  isSending: boolean;
  abortController?: AbortController;
}

export type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export type CompletionMessage = { role: ChatRole; content: string };

export interface ChatCompletionChoice {
  index: number;
  message: CompletionMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  choices: ChatCompletionChoice[];
}
