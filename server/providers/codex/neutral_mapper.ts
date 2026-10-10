import type { ConversationItem, ItemStatus } from "../../../shared/protocol/v2/conversation_items.js";
import { boundText } from "../../../shared/protocol/v2/budgets.js";
import { assistantItem, displayText, errorText, fallbackItem, phase, record, status, string, validItem } from "../neutral_items.js";
import { userItem } from "../neutral_inputs.js";
import type { NativeConversationSource } from "../neutral_source.js";
import { TextProjection } from "../text_projection.js";

/** This mapper reads app-server records directly, never a v1 Shepherd event. */
export class CodexNeutralMapper {
  private readonly text: TextProjection;
  private activeTurn: string | null = null;
  private readonly endedTurns = new Set<string>();
  constructor(private readonly source: NativeConversationSource) { this.text = new TextProjection(source); }
  item(threadId: string, turnId: string, value: unknown, terminal?: boolean | ItemStatus): ConversationItem {
    const item = record(value);
    const id = string(item.id);
    if (!id || !turnId) throw new Error("Native item identity is missing.");
    const state = status(item.status, terminal);
    if (item.type === "agentMessage") {
      const mapped = assistantItem(this.source, threadId, turnId, id, string(item.text) ?? "", phase(item.phase), state);
      if (item.status === undefined && (state === "interrupted" || state === "failed" || state === "unknown")) mapped.recovery = "partial";
      return validItem(mapped);
    }
    if (item.type === "userMessage") return validItem(userItem(this.source, threadId, turnId, id, item.content, "completed"));
    // Structured command/file/media variants land in stage three. Preserve available output now.
    const output = (item.type === "reasoning" && Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === "string").join("\n") : null) ?? string(item.aggregatedOutput) ?? displayText(item.output) ?? displayText(item.result) ?? string(item.text);
    const input = string(item.command) ?? (item.arguments === undefined ? null : JSON.stringify(item.arguments));
    return validItem(fallbackItem(threadId, turnId, id, string(item.name) ?? string(item.tool) ?? string(item.type) ?? "Tool", input, output, state));
  }
  notification(method: string, value: unknown, fallbackThread: string | null, fallbackTurn: string | null): void {
    const params = record(value), turn = record(params.turn);
    const threadId = string(params.threadId) ?? fallbackThread;
    const turnId = string(params.turnId) ?? string(turn.id) ?? this.activeTurn ?? fallbackTurn;
    if (!threadId) return;
    try {
      if (method === "item/agentMessage/delta" && turnId && typeof params.delta === "string" && typeof params.itemId === "string") {
        this.text.append(threadId, turnId, params.itemId, params.delta);
      } else if ((method === "item/started" || method === "item/completed") && turnId) {
        const item = record(params.item);
        if (item.type === "agentMessage" && method === "item/started" && typeof item.id === "string") {
          this.text.start(threadId, turnId, item.id, phase(item.phase));
          if (typeof item.text === "string" && item.text) this.text.append(threadId, turnId, item.id, item.text);
        } else {
          const mapped = this.item(threadId, turnId, item, method === "item/completed");
          if (method === "item/completed" && typeof item.id === "string") this.text.completed(threadId, item.id, mapped);
          else this.source.emit({ type: "item.started", payload: mapped });
        }
      } else if (method === "turn/started" && turnId) this.turnStarted(turnId);
      else if (method === "turn/completed" && turnId) {
        const terminal: ItemStatus = turn.status === "failed" ? "failed" : turn.status === "interrupted" ? "interrupted" : "completed";
        this.markEnded(turnId);
        if (this.activeTurn === turnId) this.activeTurn = null;
        // Text without its native completed frame is explicitly partial, even on a successful turn.
        this.text.finish(threadId, turnId, terminal === "completed" ? "unknown" : terminal);
        if (terminal === "failed") this.source.emit({ type: "turn.failed", payload: { turnId, error: { code: "turn_failed", message: errorText(turn.error), retryable: false } } });
        else this.source.emit({ type: "turn.completed", payload: { turnId, status: terminal === "interrupted" ? "interrupted" : "completed" } });
      } else if (method === "thread/reverted") { this.text.clear(); this.activeTurn = null; this.source.invalidateHistory(); }
      else if (method === "thread/status/changed") {
        const native = record(params.status), flags = Array.isArray(native.activeFlags) ? native.activeFlags : [];
        const waitingFor = flags.includes("waitingOnUserInput") ? "user_input" : flags.includes("waitingOnApproval") ? "approval" : null;
        this.source.emit({ type: "thread.status.changed", payload: { activeTurnId: native.type === "active" ? turnId : null,
          backgroundTaskCount: 0, state: native.type === "systemError" ? "error" : waitingFor ? "waiting" : native.type === "active" ? "active" : "idle", waitingFor } });
      }
      else if (method === "thread/name/updated") this.source.emit({ type: "thread.name.updated", payload: { name: string(params.threadName) } });
      else if (method === "thread/archived" || method === "thread/unarchived") this.source.emit({ type: method === "thread/archived" ? "thread.archived" : "thread.unarchived", payload: {} });
      else if (method === "error") this.source.emit({ type: "session.warning", payload: { code: "provider_warning", message: boundText(string(record(params.error).message) ?? "The provider reported an error."), retryable: true } });
    } catch { this.source.warn(); }
  }
  disconnected(threadId: string | null): void {
    const turnId = this.activeTurn;
    this.activeTurn = null;
    if (!threadId || !turnId) return;
    this.markEnded(turnId);
    this.text.finish(threadId, turnId, "failed");
    this.source.emit({ type: "turn.failed", payload: { turnId, error: { code: "provider_disconnected", message: boundText("The provider disconnected before completing the turn."), retryable: true } } });
  }
  private markEnded(turnId: string): void {
    if (this.endedTurns.size >= 512) this.endedTurns.delete(this.endedTurns.values().next().value!);
    this.endedTurns.add(turnId);
  }
  turnStarted(turnId: string): void { if (this.endedTurns.has(turnId)) return; this.activeTurn = turnId; this.source.emit({ type: "turn.started", payload: { turnId } }); }
}
