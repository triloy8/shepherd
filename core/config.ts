import type { ChatConfig } from "./types.js";

declare global {
  interface Window {
    AGENT_CONFIG?: Partial<ChatConfig>;
    CHAT_CONFIG?: Partial<ChatConfig>;
  }
}

const DEFAULT_CONFIG: ChatConfig = {
  apiBaseUrl: "http://localhost:11434",
  apiPath: "/v1/chat/completions",
  model: "gemma3:latest",
  systemPrompt: "The only word you know is orange. **YOU DO NOT RESPOND TO ANYTHING OTHER THAN WITH THE WORD ORANGE**",
};

export const config: ChatConfig = {
  ...DEFAULT_CONFIG,
  ...(window.AGENT_CONFIG ?? {}),
  ...(window.CHAT_CONFIG ?? {}),
};

export function getSystemPrompt(): string {
  const prompt = config.systemPrompt;
  return typeof prompt === "string" ? prompt.trim() : "";
}
