import type { ChatMessage, ChatState } from "./chat-state";

export type TimelineGroup = { id: string; messages: ChatMessage[]; finalIds: string[]; settled: boolean; label: string };

// Group contiguous assistant messages only: a user follow-up must never move
// inside a disclosure or out of its chronological position.
export function timelineGroups(chat: ChatState): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  const finals = new Map<string, ChatMessage[]>();
  for (const message of chat.messages) {
    if (message.role !== "assistant" || message.activity) continue;
    if (message.phase === "final_answer") finals.set(message.turnId, [...(finals.get(message.turnId) ?? []).filter((m) => m.phase === "final_answer"), message]);
    else if (!message.phase && !finals.get(message.turnId)?.some((m) => m.phase === "final_answer")) finals.set(message.turnId, [message]);
  }
  for (const message of chat.messages) {
    const previous = groups.at(-1);
    if (message.role === "assistant" && previous?.messages[0]?.role === "assistant" &&
      message.turnId && previous.messages[0].turnId === message.turnId && !finals.get(message.turnId)?.some((m) => m.id === previous.messages.at(-1)?.id)) previous.messages.push(message);
    else groups.push({ id: message.id, messages: [message], settled: false, finalIds: [], label: "Progress" });
  }
  for (const group of groups) {
    const first = group.messages[0]!;
    if (first.role !== "assistant") continue;
    const turn = chat.turns[first.turnId];
    const active = chat.activeTurnId === first.turnId;
    // Message completion is not turn completion. Wait for canonical history
    // before folding, including on reconnect and when a turn was interrupted.
    group.settled = !active && turn?.status === "completed" && !group.messages.some((m) => m.activity?.status === "failed");
    group.finalIds = (finals.get(first.turnId) ?? []).filter((m) => (m.phase === "final_answer" || group.settled) && group.messages.includes(m)).map((m) => m.id);
    group.label = active ? "Working…" : turn?.status === "interrupted" ? "Interrupted work" : turn?.status === "failed" ? "Failed work" : group.settled ?
      (turn.durationMs != null ? `Worked for ${Math.max(1, Math.round(turn.durationMs / 1000))}s` : "Work completed") : "Progress";
  }
  return groups;
}
