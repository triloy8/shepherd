import { randomUUID } from "node:crypto";
import type { InteractionRecord, InteractionReply, InteractionRequest } from "../../shared/protocol/v2/interactions.js";
import { validateUserQuestionAnswers } from "../../shared/protocol/user_questions.js";
import { assertJsonBudget, V2_BUDGETS } from "../../shared/protocol/v2/budgets.js";
import type { NativeConversationSource } from "./neutral_source.js";

export type NativeOption = Omit<InteractionRequest["options"][number], "id"> & { apply(reply: InteractionReply): Promise<void> };
/** Native reply closures never leave the adapter. Every displayed option has an opaque token. */
export class NeutralInteractions {
  private readonly requests = new Map<string, { record: InteractionRecord; options: Map<string, NativeOption> }>();
  constructor(private readonly source: NativeConversationSource, private readonly sessionId: string) {}
  request(request: Omit<InteractionRequest, "options">, nativeOptions: NativeOption[]): void {
    if ([...this.requests.values()].filter(entry => ["pending", "decided"].includes(entry.record.status)).length >= 8) throw new Error("Too many pending interactions.");
    if (this.requests.has(request.id)) throw new Error("Interaction identity already exists.");
    const options = new Map(nativeOptions.map(option => [randomUUID(), option]));
    const now = Date.now() / 1000;
    const record: InteractionRecord = { ...request, options: [...options].map(([id, { apply: _apply, ...option }]) => ({ id, ...option })),
      sessionId: this.sessionId, status: "pending", selectedOptionId: null, selectedIntent: null, createdAt: now, updatedAt: now };
    assertJsonBudget(record, V2_BUDGETS.interactionBytes, "interaction");
    if (this.requests.size >= 128) for (const [id, entry] of this.requests) if (entry.record.status !== "pending" && entry.record.status !== "decided") { this.requests.delete(id); break; }
    this.requests.set(request.id, { record, options });
    this.source.emit({ type: "interaction.requested", payload: record });
  }
  async respond(id: string, reply: InteractionReply): Promise<void> {
    const entry = this.requests.get(id), option = entry?.options.get(reply.optionId);
    if (!entry || entry.record.status !== "pending" || !option) throw new Error("Interaction is unavailable or option is invalid.");
    if (option.intent === "submit" && entry.record.questions) validateUserQuestionAnswers(entry.record.questions.questions, reply.answers);
    if (reply.answers && option.intent !== "submit") throw new Error("Only submission options accept answers.");
    entry.record.selectedOptionId = reply.optionId; entry.record.selectedIntent = option.intent;
    this.transition(entry.record, "decided");
    try {
      await option.apply(reply);
      if (this.requests.get(id)?.record.status === "decided") this.transition(entry.record, "applied");
    } catch (error) {
      if (this.requests.get(id)?.record.status === "decided") this.transition(entry.record, "failed");
      throw error;
    } finally { entry.options.clear(); }
  }
  external(id: string, intent: InteractionRecord["selectedIntent"]): void {
    const entry = this.requests.get(id);
    if (!entry || !["pending", "decided"].includes(entry.record.status)) return;
    entry.record.selectedIntent = intent;
    this.transition(entry.record, "applied"); entry.options.clear();
  }
  expire(id?: string, turnId?: string): void {
    for (const entry of this.requests.values()) if ((!id || entry.record.id === id) && (!turnId || entry.record.turnId === turnId) && ["pending", "decided"].includes(entry.record.status)) {
      this.transition(entry.record, "expired"); entry.options.clear();
    }
  }
  private transition(record: InteractionRecord, status: Exclude<InteractionRecord["status"], "pending">): void {
    record.status = status; record.updatedAt = Date.now() / 1000;
    this.source.emit({ type: `interaction.${status}`, payload: record });
  }
}
