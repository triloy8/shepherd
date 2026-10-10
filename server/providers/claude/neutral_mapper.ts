import type { ConversationItem, ItemStatus } from "../../../shared/protocol/v2/conversation_items.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assistantItem, displayText, fallbackItem, phase, record, status, string, validItem } from "../neutral_items.js";
import { userItem } from "../neutral_inputs.js";
import type { NativeConversationSource } from "../neutral_source.js";
import { TextProjection } from "../text_projection.js";

export function claudeTextItemId(messageId: string, index: number): string { return index === 0 ? messageId : `${messageId}:${index}`; }

/** Native SDK text and legacy snapshot decoding both remain adapter-local. */
export class ClaudeNeutralMapper {
  private readonly text: TextProjection;
  private streamMessageId: string | null = null;
  private streamItemId: string | null = null;
  private streamTextBlocks = 0;
  constructor(private readonly source: NativeConversationSource) { this.text = new TextProjection(source); }
  historyItem(threadId: string, turnId: string, value: unknown, terminal?: boolean | ItemStatus): ConversationItem {
    const item = record(value), id = string(item.id);
    if (!id) throw new Error("Snapshot item identity is missing.");
    const state = status(item.status, terminal);
    if (item.type === "agentMessage") {
      const mapped = assistantItem(this.source, threadId, turnId, id, string(item.text) ?? "", phase(item.phase), state);
      if (item.status === undefined && (state === "interrupted" || state === "failed" || state === "unknown")) mapped.recovery = "partial";
      return validItem(mapped);
    }
    if (item.type === "userMessage") return validItem(userItem(this.source, threadId, turnId, id, item.content, "completed"));
    const result = fallbackItem(threadId, turnId, id, string(item.tool) ?? string(item.type) ?? "Tool",
      item.arguments === undefined ? null : JSON.stringify(item.arguments), displayText(item.result), status(item.status));
    // Legacy snapshots may already contain shortened tool results. Their native size is unknown.
    if (result.type === "tool" && result.output) {
      result.output.totalBytes = null;
      result.output.truncated ||= /\n\[\d+ characters omitted\](?:\n|$)/.test(result.output.text);
    }
    return validItem(result);
  }
  message(threadId: string, turnId: string | null, message: SDKMessage): void {
    if (!turnId || ("parent_tool_use_id" in message && message.parent_tool_use_id)) return;
    try {
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "message_start") { this.streamMessageId = this.streamItemId = event.message.id; this.streamTextBlocks = 0; }
        if (event.type === "content_block_start" && event.content_block.type === "text" && this.streamMessageId) {
          this.streamItemId = claudeTextItemId(this.streamMessageId, this.streamTextBlocks++);
          this.text.start(threadId, turnId, this.streamItemId);
          if (event.content_block.text) this.text.append(threadId, turnId, this.streamItemId, event.content_block.text);
        }
        if (event.type === "content_block_delta" && event.delta.type === "text_delta" && this.streamItemId) this.text.append(threadId, turnId, this.streamItemId, event.delta.text);
      }
    } catch { this.source.warn(); }
  }
  completeText(threadId: string, turnId: string, id: string, text: string, confirmedPhase: "commentary" | "final_answer", state: ItemStatus): void {
    this.text.completed(threadId, id, assistantItem(this.source, threadId, turnId, id, text, confirmedPhase, state));
  }
  finish(threadId: string, turnId: string, state: ItemStatus): void { this.text.finish(threadId, turnId, state); }
}
