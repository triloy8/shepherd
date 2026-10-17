import type { ChatMessage, ChatState } from "./chat-state";
import { answerMessages } from "../../shared/protocol/item_stream";

export type TimelineGroup = { id: string; messages: ChatMessage[]; finalIds: string[]; settled: boolean; label: string };

// Group contiguous assistant messages only: a user follow-up must never move
// inside a disclosure or out of its chronological position.
export function timelineGroups(chat: ChatState): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  // A subagent's rows render inside their delegation step, not as the turn's own progress.
  const own = chat.messages.filter(message => !message.parentId);
  const texts = new Map<string, ChatMessage[]>();
  for (const message of own) if (message.role === "assistant" && !message.activity && !message.image) texts.set(message.turnId, [...texts.get(message.turnId) ?? [], message]);
  // Messages marked final answer their turn. Without phase metadata the last text is the answer,
  // which is known only once the turn has settled.
  const explicitFinals = new Map<string, Set<string>>();
  const implicitFinals = new Map<string, Set<string>>();
  for (const [turnId, messages] of texts) {
    const answers = answerMessages(messages);
    if (answers.length) (answers[0]!.phase === "final" ? explicitFinals : implicitFinals).set(turnId, new Set(answers.map(message => message.id)));
  }
  for (const message of own) {
    const previous = groups.at(-1);
    const finalTexts = explicitFinals.get(message.turnId) ?? implicitFinals.get(message.turnId);
    const followsFinal = !!previous?.messages.at(-1) && !!finalTexts?.has(previous.messages.at(-1)!.id);
    const output = (message.image && message.image.kind !== "viewed") || !!finalTexts?.has(message.id);
    if (message.role === "assistant" && previous?.messages[0]?.role === "assistant" &&
      message.turnId && previous.messages[0].turnId === message.turnId && (!followsFinal || output)) previous.messages.push(message);
    else groups.push({ id: message.id, messages: [message], settled: false, finalIds: [], label: "Progress" });
  }
  for (const group of groups) {
    const first = group.messages[0]!;
    if (first.role !== "assistant") continue;
    const turn = chat.turns[first.turnId];
    const active = chat.activeTurnId === first.turnId;
    // Message completion is not turn completion. Wait for canonical history
    // before folding, including on reconnect and when a turn was interrupted.
    group.settled = !active && turn?.status === "completed";
    const finalTextIds = explicitFinals.get(first.turnId) ?? (group.settled ? implicitFinals.get(first.turnId) : undefined);
    group.finalIds = group.messages.filter((message) => (message.image && message.image.kind !== "viewed") || !!finalTextIds?.has(message.id)).map((message) => message.id);
    group.label = active ? "Working…" : turn?.status === "interrupted" ? "Interrupted work" : turn?.status === "failed" ? "Failed work" : group.settled ?
      (turn.durationMs != null ? `Worked for ${Math.max(1, Math.round(turn.durationMs / 1000))}s` : "Work completed") : "Progress";
  }
  return groups;
}
