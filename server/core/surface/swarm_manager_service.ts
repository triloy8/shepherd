import type { DynamicToolCallParams } from "../../../shared/protocol/dynamic_tools.js";
import { toTextUserInput } from "../../../shared/protocol/user_input.js";
import { validateUserQuestionAnswers } from "../../../shared/protocol/user_questions.js";
import { answerMessages } from "../../../shared/protocol/item_stream.js";
import type { HistoryItem } from "../../../shared/protocol/requests.js";
import type { SwarmGroup, SwarmObservation, SwarmSnapshot } from "../../../shared/protocol/swarm.js";
import type { SurfaceConversation } from "../../../shared/protocol/conversation.js";
import type { ApplicationConversation, ApprovalConversation } from "./conversation_ports.js";
import type { TurnRoutingConversation } from "./turn_routing_service.js";
import type { SwarmManagerBridge } from "../../ports/swarm_runtime.js";
import type { SwarmService } from "./swarm_service.js";

type Options = {
  groups: SwarmService;
  managerConversation: (threadId: string) => SurfaceConversation | undefined;
  conversation: Pick<ApplicationConversation, "listProviders" | "listThreadTurns" | "setThreadName">;
  ingress: Pick<TurnRoutingConversation, "getThreadState" | "submitTurn">;
  approvals: Pick<ApprovalConversation, "listApprovals" | "applyApprovalDecision">;
  interrupt: (threadId: string, turnId: string) => Promise<void>;
  bridge?: SwarmManagerBridge; isAvailable: () => boolean;
  open: (threadId: string) => Promise<Pick<SurfaceConversation, "id" | "threadId">>;
  createWorker: (project: string, provider?: string) => Promise<Pick<SurfaceConversation, "id" | "threadId">>;
  detach: (id: string) => void;
  observe: (threadId: string) => Promise<SwarmObservation>;
  snapshot: (group: SwarmGroup) => Promise<SwarmSnapshot>;
  onChange: (groupId: string) => void;
};
const REPORT_TEXT_LIMIT = 48_000;
function text(data: Record<string, unknown>, key: string, max: number, optional = false): string {
  const value = data[key];
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!["assignment", "message"].includes(key) && /[\r\n\t]/.test(value))) throw new Error(`Invalid ${key}.`);
  return value.trim();
}

/** Manager authority, dispatch receipts, and watch-before-send orchestration. */
export class SwarmManagerService {
  private readonly managing = new Set<string>();
  private readonly groups: SwarmService;
  constructor(private readonly options: Options) { this.groups = options.groups; }
  private async watch(params: DynamicToolCallParams, group: SwarmGroup) {
    if (!group.members.length) return;
    if (!this.options.bridge) throw new Error("Worker notifications are unavailable.");
    for (const member of group.members) await this.options.open(member.threadId);
    const result = await this.options.bridge.watch(params, group.id, group.members.map((m, i) => ({ threadId: m.threadId, label: `worker-${m.name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 45) || "worker"}-${i + 1}` })));
    if (!result.success) throw new Error(result.contentItems.filter(c => c.type === "text").map(c => c.text).join(" "));
  }
  private assertActive(params: DynamicToolCallParams, group: SwarmGroup) {
    if (!this.options.isAvailable() || this.groups.read(group.id).lifecycle !== "active" || this.options.ingress.getThreadState(params.threadId).activeTurnId !== params.turnId) throw new Error("The manager turn ended or the swarm closed before this operation could continue.");
  }
  async manage(params: DynamicToolCallParams): Promise<unknown> {
    if (!this.options.isAvailable()) throw new Error("Host is stopping.");
    let group = this.groups.list().find(g => g.managerThreadId === params.threadId && g.lifecycle === "active");
    const conversation = this.options.managerConversation(params.threadId);
    if (!conversation || !params.turnId || this.options.ingress.getThreadState(params.threadId).activeTurnId !== params.turnId) throw new Error("Only this swarm's active manager turn may manage its workers.");
    if (this.managing.has(params.threadId)) throw new Error("Another manager operation is running. Retry when it finishes.");
    this.managing.add(params.threadId);
    try {
      const data = params.arguments;
      if (!data || typeof data !== "object" || Array.isArray(data) || JSON.stringify(data).length > 16_384) throw new Error("Invalid swarm tool arguments.");
      const fields: Record<string, string[]> = { swarm_status: [], swarm_delegate: ["name", "assignment", "requestId", "provider"], swarm_send: ["threadId", "message", "requestId"], swarm_report: ["threadId", "cursor", "turnId"], swarm_interrupt: ["threadId"], swarm_rename: ["name"], swarm_decide: ["threadId", "approvalId", "decision", "answers"] };
      if (!fields[params.tool] || Object.keys(data).some(k => !fields[params.tool]!.includes(k))) throw new Error("Unexpected swarm tool arguments.");
      if (!group) {
        if (params.tool === "swarm_status") return { group: null, workers: [], manager: await this.options.observe(params.threadId), guidance: "Work independently by default. Delegate only when the user agrees to a team." };
        if (params.tool === "swarm_rename") return await this.options.conversation.setThreadName(params.threadId, { name: text(data, "name", 120) });
        if (params.tool !== "swarm_delegate") throw new Error("This conversation has no workers.");
        text(data, "name", 80); text(data, "assignment", 4096); text(data, "requestId", 128);
        const provider = text(data, "provider", 64, true);
        if (provider && !this.options.conversation.listProviders().some(p => p.id === provider)) throw new Error("Choose an available provider.");
        if (!/^[\w.-]+\/[\w.-]+$/.test(conversation.project)) throw new Error("Isolated workers require an owner/repo project.");
        group = await this.groups.create({ managerThreadId: params.threadId, project: conversation.project, name: "Team", strategy: "" });
      }
      this.assertActive(params, group);
      if (params.tool === "swarm_status") {
        await this.watch(params, group);
        return { ...await this.options.snapshot(group), guidance: "Discuss the team before delegation. Inspect saved workers and history on resuming; never automatically resend pending dispatches. Completion requires your verification." };
      }
      if (params.tool === "swarm_rename") {
        const name = text(data, "name", 120);
        return await this.groups.rename(group.id, name, group.revision);
      }
      let current = group;
      let member: SwarmGroup["members"][number] | undefined;
      if (params.tool === "swarm_delegate") {
        const name = text(data, "name", 80), assignment = text(data, "assignment", 4096), key = text(data, "requestId", 128);
        const provider = text(data, "provider", 64, true);
        if (provider && !this.options.conversation.listProviders().some(p => p.id === provider)) throw new Error("Choose an available provider.");
        const keyOwner = group.members.find(m => m.dispatches?.some(d => d.key === key));
        if (keyOwner && keyOwner.name.toLocaleLowerCase() !== name.toLocaleLowerCase()) throw new Error("This requestId already belongs to another worker. Inspect the existing assignment.");
        member = group.members.find(m => m.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (member && member.assignment !== assignment) throw new Error("Worker already exists with a different assignment. Use swarm_send for follow-ups.");
        if (!member) {
          if (group.members.length >= 64) throw new Error("Worker limit reached.");
          if (!/^[\w.-]+\/[\w.-]+$/.test(group.project)) throw new Error("Isolated workers require an owner/repo project.");
          const worker = await this.options.createWorker(group.project, provider || undefined);
          try { this.assertActive(params, group); current = await this.groups.addMember(group.id, group.revision, { name, assignment, threadId: worker.threadId }); }
          catch (error) { this.options.detach(worker.id); throw error; }
          member = current.members.find(m => m.threadId === worker.threadId)!;
        }
        return await this.sendAssignment(params, current, member, key, assignment);
      }
      const threadId = text(data, "threadId", 256);
      member = group.members.find(m => m.threadId === threadId);
      if (!member) throw new Error("Worker is not in this manager's team.");
      await this.options.open(threadId);
      if (params.tool === "swarm_send") return await this.sendAssignment(params, group, member, text(data, "requestId", 128), text(data, "message", 4096));
      if (params.tool === "swarm_report") {
        const turnId = text(data, "turnId", 256, true);
        const cursor = text(data, "cursor", 4096, true) || undefined;
        if (turnId) {
          if (cursor) throw new Error("Provide either a turnId or a history cursor.");
          return await this.reportTurn(member, turnId);
        }
        const page = await this.options.conversation.listThreadTurns(threadId, { cursor, limit: 5, sortDirection: "desc", itemsView: "full" });
        const serialized = JSON.stringify(page);
        return { threadId, observation: await this.options.observe(threadId), dispatches: member.dispatches ?? [], history: serialized.slice(0, REPORT_TEXT_LIMIT), truncated: serialized.length > REPORT_TEXT_LIMIT, nextCursor: page.nextCursor, approvals: this.options.approvals.listApprovals(threadId).filter(a => a.status === "pending") };
      }
      if (params.tool === "swarm_decide") {
        this.assertActive(params, group);
        const approvalId = text(data, "approvalId", 256), decision = text(data, "decision", 256);
        const pending = this.options.approvals.listApprovals(threadId).find(a => a.approvalId === approvalId && a.status === "pending");
        if (!pending || !pending.choices.some(c => c.value === decision)) throw new Error("Choose an offered decision from a current pending approval.");
        if (pending.kind === "question" && pending.choices.find(c => c.value === decision)?.intent === "answer") validateUserQuestionAnswers(pending.userInput.questions, data.answers);
        else if (data.answers !== undefined) throw new Error("This decision does not accept answers.");
        await this.options.approvals.applyApprovalDecision(threadId, approvalId, { decision, ...(data.answers ? { answers: data.answers as Record<string, string[]> } : {}) });
        return { applied: true };
      }
      this.assertActive(params, group);
      const turnId = this.options.ingress.getThreadState(threadId).activeTurnId;
      if (turnId) await this.options.interrupt(threadId, turnId);
      return { threadId, interrupted: Boolean(turnId) };
    } finally { this.managing.delete(params.threadId); if (group) this.options.onChange(group.id); }
  }

  private async reportTurn(member: SwarmGroup["members"][number], turnId: string) {
    const { threadId } = member;
    const dispatch = member.dispatches?.find(d => d.turnId === turnId) ?? null;
    const pendingApprovals = () => this.options.approvals.listApprovals(threadId, turnId).filter(a => a.status === "pending");
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.options.conversation.listThreadTurns(threadId, { cursor, limit: 20, sortDirection: "desc", itemsView: "summary" });
      const turn = page.data.find(candidate => candidate.id === turnId);
      if (turn) {
        const replies = turn.items.filter((item): item is Extract<HistoryItem, { type: "assistant_message" }> => item.type === "assistant_message" && !item.parentItemId);
        const answers = turn.status === "completed" ? answerMessages(replies) : replies.filter(item => item.phase === "final");
        const finalReply = answers.map(answer => answer.text).join("\n\n");
        return {
          threadId, turnId, dispatch, status: turn.status, error: turn.error,
          finalReply: finalReply.slice(0, REPORT_TEXT_LIMIT) || null,
          truncated: finalReply.length > REPORT_TEXT_LIMIT, approvals: pendingApprovals(),
        };
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seenCursors.has(cursor)) throw new Error("Worker history repeated its cursor before the requested turn was found.");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return { threadId, turnId, dispatch, status: null, error: null, finalReply: null, truncated: false, approvals: pendingApprovals() };
  }

  private async sendAssignment(params: DynamicToolCallParams, group: SwarmGroup, member: SwarmGroup["members"][number], key: string, message: string) {
    const previous = member.dispatches?.find(d => d.key === key);
    if (previous) return { threadId: member.threadId, ...previous, duplicate: true, guidance: previous.status === "pending" ? "Dispatch outcome uncertain. Read worker history; do not automatically resend." : "Assignment already sent." };
    await this.watch(params, group);
    this.assertActive(params, group);
    if (this.options.ingress.getThreadState(member.threadId).activeTurnId) throw new Error("Worker is active. Wait for its report before sending another assignment.");
    await this.groups.dispatch(group.id, member.threadId, { key, status: "pending", turnId: null });
    this.assertActive(params, group);
    const result = await this.options.ingress.submitTurn(member.threadId, { input: [toTextUserInput(message)], source: "swarm_assignment" });
    await this.groups.dispatch(group.id, member.threadId, { key, status: "sent", turnId: result.turnId });
    return { threadId: member.threadId, status: "sent", turnId: result.turnId, guidance: "Worker notifications are delivered when your turn is idle. Finish this turn with a progress update once independent work is done; do not sleep or poll. The host will start a new turn for worker results." };
  }
}
