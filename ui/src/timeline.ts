import type { ChatMessage, ChatState } from "./chat-state";

export type TimelineGroup = { id: string; messages: ChatMessage[]; finalIds: string[]; settled: boolean; label: string };

// Group contiguous assistant messages only: a user follow-up must never move
// inside a disclosure or out of its chronological position.
export function timelineGroups(chat: ChatState): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  const explicitFinals = new Map<string, Set<string>>();
  const implicitFinals = new Map<string, Set<string>>();
  for (const message of chat.messages) {
    if (message.role !== "assistant" || message.activity || message.image) continue;
    if (message.phase === "final") {
      const ids = explicitFinals.get(message.turnId) ?? new Set<string>();
      ids.add(message.id); explicitFinals.set(message.turnId, ids);
    } else if (!message.phase && !explicitFinals.has(message.turnId)) {
      // Legacy history has no phase metadata, so only its last assistant text
      // is the final response.
      implicitFinals.set(message.turnId, new Set([message.id]));
    }
  }
  for (const message of chat.messages) {
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
