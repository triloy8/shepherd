import type { ChatState, StoredTranscript } from "../core/types.js";

const STORAGE_KEY = "minimal-chat:transcript";

export function persistTranscript(state: ChatState): void {
  if (state.messages.length === 0) {
    sessionStorage.removeItem(STORAGE_KEY);
    return;
  }

  const payload: StoredTranscript = {
    conversationId: state.conversationId,
    messages: state.messages,
    savedAt: new Date().toISOString(),
  };

  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function loadTranscript(): StoredTranscript | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as StoredTranscript;
  } catch (error) {
    console.warn("Failed to parse transcript from storage", error);
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearTranscript(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
