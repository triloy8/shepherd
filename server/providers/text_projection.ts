import type { ConversationItem, ItemStatus } from "../../shared/protocol/v2/conversation_items.js";
import { OutputAccumulator, splitTextDeltas, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";
import { assistantItem, itemBase, publicItemId } from "./neutral_items.js";
import type { NativeConversationSource } from "./neutral_source.js";

/** Adapter-side text normalization. Core alone assigns projection versions. */
export class TextProjection {
  private readonly messages = new Map<string, { turnId: string; accumulator: OutputAccumulator; phase: "commentary" | "final_answer" | null }>();
  constructor(private readonly source: NativeConversationSource) {}
  start(threadId: string, turnId: string, id: string, phase: "commentary" | "final_answer" | null = null): void {
    if (this.messages.has(id)) return;
    if (this.messages.size >= 100) throw new Error("Too many active text items.");
    this.messages.set(id, { turnId, accumulator: new OutputAccumulator(V2_BUDGETS.messageTextBytes), phase });
    this.source.emit({ type: "item.started", payload: assistantItem(this.source, threadId, turnId, id, "", phase, "in_progress") });
  }
  append(threadId: string, turnId: string, id: string, delta: string): void {
    this.start(threadId, turnId, id);
    const state = this.messages.get(id)!;
    if (state.turnId !== turnId) throw new Error("Text item changed its originating turn.");
    for (const chunk of splitTextDeltas(delta)) {
      const previous = state.accumulator.read();
      state.accumulator.append(chunk);
      const next = state.accumulator.read();
      if (!next.truncated) {
        this.source.emit({ type: "item.delta", payload: { itemId: publicItemId(threadId, id), turnId,
          field: "text", index: null, offset: previous.text.length, delta: chunk } });
      } else if (!previous.truncated) {
        const item: ConversationItem = { ...itemBase(threadId, turnId, id, "in_progress"), type: "assistant_message",
          text: next, phase: state.phase, recovery: "partial", detailAsset: this.source.asset(`${id}:pending-text`, "text", "text/plain", "answer.txt") };
        this.source.emit({ type: "item.updated", payload: item });
      }
    }
  }
  finish(threadId: string, turnId: string, status: ItemStatus): void {
    for (const [id, state] of this.messages) if (state.turnId === turnId) {
      const item: ConversationItem = { ...itemBase(threadId, turnId, id, status), type: "assistant_message",
        text: state.accumulator.read(), phase: state.phase, recovery: "partial" };
      this.messages.delete(id);
      this.source.emit({ type: "item.completed", payload: item });
    }
  }
  completed(threadId: string, nativeId: string, item: ConversationItem): void {
    const previous = this.messages.get(nativeId);
    if (previous && previous.turnId !== item.turnId) throw new Error("Stale text completion changed turn identity.");
    this.messages.delete(nativeId);
    this.source.emit({ type: "item.completed", payload: item });
  }
  clear(): void { this.messages.clear(); }
}
