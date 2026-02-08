import { config, getSystemPrompt } from "../core/config.js";
import type { ChatCompletionResponse, CompletionMessage, Message } from "../core/types.js";

async function safeReadError(response: Response): Promise<string | null> {
  try {
    const data = await response.json();
    if (data?.error?.message) return data.error.message;
    if (typeof data === "string") return data;
    return JSON.stringify(data);
  } catch {
    return response.statusText || null;
  }
}

export async function sendChatCompletion(
  messages: Message[],
  signal: AbortSignal,
  conversationId: string,
): Promise<string> {
  const requestMessages: CompletionMessage[] = [];
  const systemPrompt = getSystemPrompt();

  if (systemPrompt) {
    requestMessages.push({ role: "system", content: systemPrompt });
  }

  for (const { role, content } of messages) {
    requestMessages.push({ role, content });
  }

  const requestBody = {
    model: config.model,
    messages: requestMessages,
    conversation_id: conversationId,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.headers ?? {}),
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(`${config.apiBaseUrl}${config.apiPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const detail = await safeReadError(response);
    throw new Error(detail ?? `Request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No assistant content returned.");
  }
  return content.trim();
}
