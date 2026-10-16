import { imageDataParts, WEB_IMAGE_MAX_COUNT } from "../../shared/protocol/image_input";
import { describeActivity } from "../../shared/protocol/activity";
import type { WebBridgeEvent, WebHistoryItem, WebHistoryTurn, WebImage } from "../../shared/protocol/web";
import type { HistoryItem, HistoryTurn } from "../../shared/protocol/requests";
import { appendOutput, streamedItem, type StreamedItem } from "../../shared/protocol/item_stream";

/** A progress row: a tool call, or a plan or reasoning summary shown like one. */
export type ActivityStep = Pick<Extract<HistoryItem, { type: "activity" }>, "status" | "activity">;

export type ChatMessage = { optimistic?: boolean; anonymous?: boolean; anonymousBaseline?: string[]; localBaseline?: string[]; id: string; turnId: string; role: "user" | "assistant"; text: string; complete: boolean; attachments?: string[]; image?: WebImage; activity?: ActivityStep; phase?: "interim" | "final";
  /** The delegation step whose subagent produced this row; such rows render inside that step. */
  parentId?: string; streamText?: string; snapshotText?: string;
  /** A plan or reasoning item as streamed so far, until its canonical item completes. */
  streamed?: StreamedItem;
  /** The latest output of a running step. History records no output, so it shows only while the step runs. */
  output?: string };
export type TurnSummary = Pick<HistoryTurn, "status" | "durationMs">;
export type ChatState = { endedTurns: string[]; turns: Record<string, TurnSummary>; messages: ChatMessage[]; activeTurnId: string | null; activity: string | null; error: string | null; seen: string[] };
export const emptyChat = (): ChatState => ({ endedTurns: [], turns: {}, messages: [], activeTurnId: null, activity: null, error: null, seen: [] });
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const phase = (value: unknown) => value === "interim" || value === "final" ? value : undefined;
const text = (value: unknown) => typeof value === "string" ? value : "";

export function historyMessages(turns: WebHistoryTurn[]): ChatMessage[] {
  // API pages are newest first; display each page chronologically.
  return [...turns].reverse().flatMap((turn) => turn.items.flatMap((item): ChatMessage[] => {
    const message = itemMessage(item, turn.id, turn.status === "in_progress" ? "started" : "completed");
    return message ? [message] : [];
  }));
}

/** One timeline row for an item, shared by history and live delivery. `stage` is whether the
 * item is still in progress, which decides the status of plans and reasoning. */
function itemMessage(item: WebHistoryItem, turnId: string, stage: "started" | "completed"): ChatMessage | null {
  const message = ownItemMessage(item, turnId, stage);
  // A subagent's text is its progress inside the delegation, never the conversation's answer.
  return message && item.parentItemId ? { ...message, parentId: item.parentItemId, ...(message.activity || message.image ? {} : { phase: "interim" as const, complete: true }) } : message;
}

function ownItemMessage(item: WebHistoryItem, turnId: string, stage: "started" | "completed"): ChatMessage | null {
  const complete = stage === "completed";
  switch (item.type) {
    case "user_message": {
      const attachments = item.content.flatMap((part) => part.type === "image" && imageDataParts(part.url) ? [part.url as string] : []).slice(0, WEB_IMAGE_MAX_COUNT);
      const content = item.content.map((part) => part.type === "text" ? part.text : part.type === "image" ? (attachments.includes(text(part.url)) ? "" : "[Image attachment unavailable]") : part.type === "image_file" ? "[Image attachment]" : part.type === "audio" || part.type === "audio_file" ? "[Audio attachment]" : part.type === "skill" ? `[Skill: ${part.name}]` : part.type === "attachment" ? `[Attachment: ${part.name || part.path || "unavailable"}]` : "").filter(Boolean).join("\n");
      return { id: item.id, turnId, role: "user", text: content, attachments, complete: true };
    }
    case "assistant_message": return { id: item.id, turnId, role: "assistant", text: item.text, attachments: [], phase: phase(item.phase), complete };
    case "plan": case "reasoning": {
      if (item.type === "reasoning" && !item.summary.some(part => part.trim())) return null;
      return { id: item.id, turnId, role: "assistant", text: "", complete, activity: {
        status: stage, activity: { kind: "other", title: item.type === "plan" ? "Plan" : "Reasoning summary", detail: item.type === "plan" ? item.text : item.summary.join("\n\n") },
      } };
    }
    case "image": return { id: item.id, turnId, role: "assistant", text: "", complete: true, image: item.webImage };
    case "activity": return { id: item.id, turnId, role: "assistant", text: "", complete: item.status !== "started", activity: { status: item.status, activity: item.activity } };
    case "other": return null;
  }
}

const sameAttachments = (left: string[] | undefined, right: string[] | undefined) => {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
};
export const messageKey = (message: Pick<ChatMessage, "turnId" | "id" | "anonymous" | "optimistic">) => JSON.stringify([message.turnId, message.id, message.anonymous === true, message.optimistic === true]);
const compatiblePhase = (left: ChatMessage["phase"], right: ChatMessage["phase"]) => !left || !right || left === right;
function lastMessageIndex(messages: ChatMessage[], matches: (message: ChatMessage) => boolean): number {
  for (let index = messages.length - 1; index >= 0; index--) if (matches(messages[index]!)) return index;
  return -1;
}
function anonymousIndex(messages: ChatMessage[], turnId: string, reportedPhase: ChatMessage["phase"]): number {
  return lastMessageIndex(messages, message => message.anonymous === true && message.turnId === turnId && compatiblePhase(message.phase, reportedPhase));
}
const sameUserMessage = (a: ChatMessage, b: ChatMessage) => a.role === "user" && b.role === "user" && a.turnId === b.turnId && a.text === b.text && sameAttachments(a.attachments, b.attachments);

// Keep an occurrence baseline, rather than deduplicating by text alone: users
// can intentionally send the same follow-up more than once within one turn.
export function acceptUserMessage(state: ChatState, message: ChatMessage, beforeSend: ChatMessage[]): ChatState {
  const baseline = beforeSend.filter((item) => sameUserMessage(item, message)).map((item) => item.id);
  const canonical = state.messages.filter((item) => !item.optimistic && sameUserMessage(item, message));
  const received = canonical.some((item, index) => index >= baseline.length && !baseline.includes(item.id));
  return { ...state, messages: received ? state.messages : [...state.messages, { ...message, optimistic: true, localBaseline: baseline }] };
}

export function mergeHistory(state: ChatState, turns: WebHistoryTurn[], older = false): ChatState {
  const incoming = historyMessages(turns);
  const claimed = new Set<string>();
  const retained = state.messages.filter((message) => {
    if (!message.optimistic) return true;
    const baseline = message.localBaseline ?? [];
    const match = incoming.filter((item) => sameUserMessage(item, message)).find((item, index) => index >= baseline.length && !baseline.includes(item.id) && !claimed.has(messageKey(item)));
    if (!match) return true;
    claimed.add(messageKey(match));
    return false;
  });
  // A history snapshot may identify an anonymous stream before its completion event arrives.
  // Claim only an unambiguous text match, preserving repeated messages as separate occurrences.
  const established = new Set(retained.filter(message => !message.anonymous && !message.optimistic).map(messageKey));
  const matchesStream = (message: ChatMessage, streamed: ChatMessage) => message.role === "assistant" && !message.activity && !message.image && !message.parentId &&
    message.turnId === streamed.turnId && compatiblePhase(message.phase, streamed.phase) &&
    !!message.text && (message.text.startsWith(streamed.text) || streamed.text.startsWith(message.text));
  for (let index = 0; index < retained.length; index++) {
    const streamed = retained[index]!;
    if (!streamed.anonymous || !streamed.text) continue;
    const matches = incoming.filter(message => !established.has(messageKey(message)) && matchesStream(message, streamed));
    if (matches.length === 1 && !claimed.has(messageKey(matches[0]!)) &&
      retained.filter(other => other.anonymous && other.text && matchesStream(matches[0]!, other)).length === 1) {
      const canonical = matches[0]!;
      claimed.add(messageKey(canonical));
      retained[index] = { ...streamed, id: canonical.id, anonymous: false };
    }
  }
  const existing = new Map(retained.map((message) => [messageKey(message), message]));
  for (const message of incoming) {
    const previous = existing.get(messageKey(message));
    message.phase ??= previous?.phase;
    // A snapshot begun before a lifecycle event must not regress a finished
    // tool to Running or replace an already delivered image with its activity.
    if (previous?.image && message.activity) { existing.set(messageKey(message), previous); continue; }
    if (previous?.activity && previous.activity.status !== "started" && message.activity?.status === "started") {
      existing.set(messageKey(message), previous); continue;
    }
    // A running step keeps what streamed live: a snapshot has no output and may trail the stream.
    if (message.activity?.status === "started" && (previous?.streamed || previous?.output)) { existing.set(messageKey(message), previous); continue; }
    // History may be ahead of a queued delta. Keep its text separate from the
    // accumulated stream so reconnect replay cannot append the same text twice.
    existing.set(messageKey(message), message.complete ? message : {
      ...message, complete: previous?.complete ?? message.complete,
      streamText: previous?.streamText,
      snapshotText: message.text,
      text: previous?.complete ? previous.text : reconcileText(message.text, previous?.streamText ?? ""),
    });
  }
  const incomingIds = new Set(incoming.map(messageKey));
  const overlap = retained.findIndex((message) => incomingIds.has(messageKey(message)));
  // Keep previously loaded older pages in front of refreshed recent history.
  const prefix = older ? [] : overlap >= 0 ? retained.slice(0, overlap) : retained.filter((message) => message.complete && !message.optimistic);
  const prefixIds = new Set(prefix.map(messageKey));
  const order = [...prefix, ...incoming, ...retained.filter((message) => !incomingIds.has(messageKey(message)) && !prefixIds.has(messageKey(message)))];
  const ids = [...new Set(order.map(messageKey))];
  return { ...state, turns: { ...state.turns, ...Object.fromEntries(turns.map((turn) => [turn.id, { status: turn.status, durationMs: turn.durationMs }])) }, messages: ids.map((id) => existing.get(id)!) };
}

function reconcileText(snapshot: string, stream: string): string {
  if (!stream || snapshot.includes(stream)) return snapshot;
  if (stream.startsWith(snapshot)) return stream;
  for (let overlap = Math.min(snapshot.length, stream.length); overlap > 0; overlap--) {
    if (snapshot.endsWith(stream.slice(0, overlap))) return snapshot + stream.slice(overlap);
  }
  return snapshot + stream;
}

export function reduceBridge(state: ChatState, event: WebBridgeEvent): ChatState {
  if (state.seen.includes(event.id)) return state;
  const payload = record(event.payload);
  const next = { ...state, seen: [...state.seen.slice(-1023), event.id] };
  const turnId = text(payload.turnId) || state.activeTurnId || "";
  const known = Object.hasOwn(state.turns, turnId) ? state.turns[turnId] : undefined;
  const ended = state.endedTurns.includes(turnId) || (known && known.status !== "in_progress");
  // A superseded turn may still deliver queued events. They must not change the current turn,
  // append post-completion deltas or replace its progress. Late answers and images still land.
  const item = event.type === "item.started" || event.type === "item.completed" ? event.payload.item : null;
  const progress = event.type === "item.started" || event.type === "item.delta" || (item !== null && item.type !== "assistant_message" && item.type !== "image");
  // A background subagent keeps working after its turn ends; its items still belong to their delegation.
  const subagent = !!item?.parentItemId;
  if (!subagent && (event.type.startsWith("turn.") || event.type.startsWith("item.")) && ((state.activeTurnId && (turnId !== state.activeTurnId) && event.type !== "turn.started") ||
    (ended && (progress || ["turn.started", "turn.completed", "turn.failed"].includes(event.type))))) return next;
  if (event.type === "turn.started") return { ...next, endedTurns: state.activeTurnId && state.activeTurnId !== turnId ? [...new Set([...state.endedTurns, state.activeTurnId])] : state.endedTurns, turns: { ...state.turns, ...(turnId ? { [turnId]: { status: "in_progress", durationMs: null } } : {}) }, activeTurnId: turnId || state.activeTurnId, activity: "Thinking", error: null };
  if (["turn.completed", "turn.failed"].includes(event.type)) return { ...next, endedTurns: turnId ? [...new Set([...state.endedTurns, turnId])] : state.endedTurns, messages: next.messages.map((message) => message.turnId === turnId ? { ...message, complete: true } : message), activeTurnId: null, activity: null, error: event.type === "turn.failed" ? text(payload.message) || "The turn failed." : state.error };
  if (event.type === "session.error" || event.type === "session.limit.context") return { ...next, error: text(payload.message) || "The session needs attention." };
  // Users' own messages arrive through submission and history; deltas extend the messages below.
  if (item && (subagent || (item.type !== "assistant_message" && item.type !== "user_message"))) {
    const message = itemMessage(item, turnId, event.type === "item.started" ? "started" : "completed");
    if (!message) return next;
    const previous = state.messages.find((m) => m.id === message.id && m.turnId === turnId);
    // A finished step never regresses to running, and a delivered image is not replaced by its activity.
    if (previous?.image && !message.image) return next;
    if (previous?.activity && previous.activity.status !== "started" && message.activity?.status === "started") return next;
    const messages = previous ? state.messages.map((m) => m === previous ? message : m) : [...state.messages, message];
    return message.activity && !message.parentId ? { ...next, messages, activity: message.activity.status === "started" ? describeActivity(message.activity.activity).title : "Thinking" } : { ...next, messages };
  }
  if (event.type === "item.delta" && event.payload.channel !== "message") {
    const { itemId } = event.payload;
    // Plans, reasoning and output extend a known item; without an ID there is nothing to extend.
    if (!itemId) return next;
    const previous = state.messages.find((m) => m.id === itemId && m.turnId === turnId);
    if (previous?.complete) return next;
    if (event.payload.channel === "output") {
      if (previous?.activity?.status !== "started") return next;
      return { ...next, messages: state.messages.map((m) => m === previous ? { ...m, output: appendOutput(m.output, event.payload.delta) } : m) };
    }
    const streamed = streamedItem(previous?.streamed, itemId, event.payload);
    const message = streamed && itemMessage(streamed, turnId, "started");
    if (!message) return next;
    const row = { ...message, streamed, ...(previous?.parentId ? { parentId: previous.parentId } : {}) };
    return { ...next, messages: previous ? state.messages.map((m) => m === previous ? row : m) : [...state.messages, row] };
  }
  const assistant = item?.type === "assistant_message" && event.type === "item.completed" ? item : null;
  const delta = event.type === "item.delta" && event.payload.channel === "message" ? event.payload : null;
  if (!assistant && !delta) return next;
  const reportedId = assistant ? assistant.id : text(delta!.itemId);
  const reportedPhase = phase(assistant ? assistant.phase : delta!.phase);
  let messages = state.messages;
  let index = reportedId ? messages.findIndex((message) => message.id === reportedId && message.turnId === turnId && !message.anonymous) : -1;
  const canonical = messages[index];
  const pending = anonymousIndex(messages, turnId, reportedPhase ?? canonical?.phase);
  let previous = canonical;
  // Ambiguous snapshots can create a canonical row while retaining the anonymous stream.
  // An identified event resolves that ambiguity without leaving a second message behind.
  if (canonical && pending >= 0 && !messages[pending]!.anonymousBaseline?.includes(messageKey(canonical)) && (!canonical.complete || (assistant?.text && assistant.text.startsWith(messages[pending]!.text)))) {
    previous = { ...canonical, streamText: canonical.streamText ?? messages[pending]!.streamText };
    messages = messages.filter((_, position) => position !== pending);
    index = messages.findIndex(message => messageKey(message) === messageKey(canonical));
  }
  if (index < 0) index = anonymousIndex(messages, turnId, reportedPhase);
  if (index < 0 && !reportedId) index = lastMessageIndex(messages, message => message.turnId === turnId && message.role === "assistant" &&
    !message.complete && !message.activity && !message.image && compatiblePhase(message.phase, reportedPhase));
  previous ??= messages[index];
  if (delta && previous?.complete) return { ...next, messages };
  const id = reportedId || previous?.id || `anonymous:${event.id}`;
  const message: ChatMessage = {
    anonymous: !reportedId && (previous?.anonymous ?? true),
    anonymousBaseline: previous?.anonymousBaseline ?? (!reportedId ? state.messages.filter(message => message.turnId === turnId && !message.anonymous).map(messageKey) : undefined),
    id, turnId, role: "assistant", phase: reportedPhase ?? previous?.phase,
    text: assistant ? assistant.text : reconcileText(previous?.snapshotText ?? "", (previous?.streamText ?? "") + delta!.delta),
    streamText: delta ? (previous?.streamText ?? "") + delta.delta : undefined,
    snapshotText: previous?.snapshotText,
    complete: assistant !== null,
  };
  const updated = [...messages];
  if (index < 0) updated.push(message); else updated[index] = message;
  return { ...next, messages: updated };
}
