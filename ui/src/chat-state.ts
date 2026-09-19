import type { BridgeEvent } from "../../shared/protocol/events";
import type { HistoryTurn } from "../../shared/protocol/requests";

export type ChatMessage = { id: string; turnId: string; role: "user" | "assistant"; text: string; complete: boolean; streamText?: string; snapshotText?: string };
export type ChatState = { messages: ChatMessage[]; activeTurnId: string | null; activity: string | null; error: string | null; seen: string[] };
export const emptyChat = (): ChatState => ({ messages: [], activeTurnId: null, activity: null, error: null, seen: [] });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

export function historyMessages(turns: HistoryTurn[]): ChatMessage[] {
  // API pages are newest first; display each page chronologically.
  return [...turns].reverse().flatMap((turn) => turn.items.flatMap((item): ChatMessage[] => {
    if (item.type !== "userMessage" && item.type !== "agentMessage") return [];
    const content = Array.isArray(item.content) ? item.content.map((part) => {
      const value = record(part);
      return value.type === "text" ? text(value.text) : value.type === "image" || value.type === "localImage" ? "[Image attachment]" : "";
    }).filter(Boolean).join("\n") : text(item.text);
    return [{ id: item.id, turnId: turn.id, role: item.type === "userMessage" ? "user" : "assistant", text: content, complete: item.type === "userMessage" || turn.status !== "inProgress" }];
  }));
}

export function mergeHistory(state: ChatState, turns: HistoryTurn[], older = false): ChatState {
  const incoming = historyMessages(turns);
  const retained = state.messages.filter((message) => !message.id.startsWith("local:") || !incoming.some((item) => item.role === "user" && item.turnId === message.turnId && item.text === message.text));
  const existing = new Map(retained.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = existing.get(message.id);
    // History may be ahead of a queued delta. Keep its text separate from the
    // accumulated stream so reconnect replay cannot append the same text twice.
    existing.set(message.id, message.complete ? message : {
      ...message, complete: previous?.complete ?? message.complete,
      streamText: previous?.streamText,
      snapshotText: message.text,
      text: previous?.complete ? previous.text : reconcileText(message.text, previous?.streamText ?? ""),
    });
  }
  const incomingIds = new Set(incoming.map((item) => item.id));
  const overlap = retained.findIndex((message) => incomingIds.has(message.id));
  // Keep previously loaded older pages in front of refreshed recent history.
  const prefix = older ? [] : overlap >= 0 ? retained.slice(0, overlap) : retained.filter((message) => message.complete && !message.id.startsWith("local:"));
  const prefixIds = new Set(prefix.map((message) => message.id));
  const order = [...prefix, ...incoming, ...retained.filter((message) => !incomingIds.has(message.id) && !prefixIds.has(message.id))];
  const ids = [...new Set(order.map((message) => message.id))];
  return { ...state, messages: ids.map((id) => existing.get(id)!) };
}

function reconcileText(snapshot: string, stream: string): string {
  if (!stream || snapshot.includes(stream)) return snapshot;
  if (stream.startsWith(snapshot)) return stream;
  for (let overlap = Math.min(snapshot.length, stream.length); overlap > 0; overlap--) {
    if (snapshot.endsWith(stream.slice(0, overlap))) return snapshot + stream.slice(overlap);
  }
  return snapshot + stream;
}

export function reduceBridge(state: ChatState, event: BridgeEvent): ChatState {
  if (state.seen.includes(event.id)) return state;
  const payload = record(event.payload);
  const next = { ...state, seen: [...state.seen.slice(-1023), event.id] };
  if (event.type === "turn.started") return { ...next, activeTurnId: text(payload.turnId) || state.activeTurnId, activity: "Thinking", error: null };
  if (["turn.completed", "turn.failed"].includes(event.type)) return { ...next, messages: next.messages.map((message) => message.turnId === payload.turnId ? { ...message, complete: true } : message), activeTurnId: null, activity: null, error: event.type === "turn.failed" ? text(payload.message) || "The turn failed." : state.error };
  if (event.type === "session.error" || event.type === "session.limit.context") return { ...next, error: text(payload.message) || "The session needs attention." };
  if (event.type === "turn.activity") return { ...next, activity: payload.status === "started" ? text(payload.label) || "Working" : "Thinking" };
  if (event.type !== "turn.stream.delta" && event.type !== "turn.message.completed") return next;
  // Reasoning/tool deltas are not agent message text.
  if (event.type === "turn.stream.delta" && payload.method !== "item/agentMessage/delta") return next;
  const id = text(payload.itemId);
  if (!id) return next;
  const index = state.messages.findIndex((message) => message.id === id);
  const previous = state.messages[index];
  if (event.type === "turn.stream.delta" && previous?.complete) return next;
  const message: ChatMessage = {
    id, turnId: text(payload.turnId), role: "assistant",
    text: event.type === "turn.message.completed" ? text(payload.text) : reconcileText(previous?.snapshotText ?? "", (previous?.streamText ?? "") + text(payload.textDelta)),
    streamText: event.type === "turn.stream.delta" ? (previous?.streamText ?? "") + text(payload.textDelta) : undefined,
    snapshotText: previous?.snapshotText,
    complete: event.type === "turn.message.completed",
  };
  const messages = [...state.messages];
  if (index < 0) messages.push(message); else messages[index] = message;
  return { ...next, messages };
}
