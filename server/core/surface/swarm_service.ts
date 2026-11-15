import { randomUUID } from "node:crypto";
import type { SwarmGroup, SwarmMember, SwarmInterruptResult } from "../../../shared/protocol/swarm.js";
import type { SwarmStore } from "../../ports/swarm_store.js";
import type { ApplicationConversation } from "./conversation_ports.js";

export class SwarmError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Group records are independent of transient watches and surface conversation bindings. */
export class SwarmService {
  private writing = false;
  constructor(private readonly store: SwarmStore, private readonly conversation: Pick<ApplicationConversation, "readThread" | "getThreadState" | "interruptTurn" | "setThreadName">) {}
  list() { return this.store.list(); }
  read(id: string): SwarmGroup {
    const group = this.store.read(id);
    if (!group) throw new SwarmError("swarm_not_found", "Swarm not found.");
    return group;
  }
  checkRevision(group: SwarmGroup, revision: number) {
    if (group.revision !== revision) throw new SwarmError("swarm_changed", "The swarm changed. Refresh before retrying.");
  }
  private exclusive(threadId: string, excluding?: string) {
    if (this.list().some(g => g.id !== excluding && g.lifecycle === "active" && (g.managerThreadId === threadId || g.members.some(m => m.threadId === threadId)))) {
      throw new SwarmError("thread_in_swarm", "This conversation already belongs to an active swarm.");
    }
  }
  private async write<T>(operation: () => Promise<T>): Promise<T> {
    if (this.writing) throw new SwarmError("swarm_busy", "Another swarm change is in progress. Retry after it finishes.");
    this.writing = true;
    try { return await operation(); } finally { this.writing = false; }
  }
  async create(input: { name: string; project: string; managerThreadId: string; strategy: string }): Promise<SwarmGroup> {
    return this.write(async () => {
      if (this.list().length >= 128) throw new SwarmError("swarm_limit", "Swarm storage is at capacity.");
      this.exclusive(input.managerThreadId);
      await this.conversation.readThread(input.managerThreadId, { includeTurns: false });
      const now = new Date().toISOString();
      const group: SwarmGroup = { ...input, version: 1, id: randomUUID(), revision: 1, lifecycle: "active", createdAt: now, updatedAt: now, members: [] };
      this.store.save(group, null);
      return group;
    });
  }
  async addMember(id: string, revision: number, input: Pick<SwarmMember, "threadId" | "name" | "assignment">) {
    return this.write(async () => {
      const group = this.read(id); this.checkRevision(group, revision);
      if (group.lifecycle !== "active") throw new SwarmError("swarm_closed", "Closed swarms cannot add workers.");
      if (group.members.length >= 64) throw new SwarmError("worker_limit", "A swarm supports at most 64 workers.");
      if ([group.managerThreadId, ...group.members.map(m => m.threadId)].includes(input.threadId)) throw new SwarmError("duplicate_member", "This conversation already belongs to the swarm.");
      if (group.members.some(m => m.name.toLocaleLowerCase() === input.name.toLocaleLowerCase())) throw new SwarmError("duplicate_name", "Choose a distinct worker name.");
      this.exclusive(input.threadId, group.id);
      await this.conversation.readThread(input.threadId, { includeTurns: false });
      const next = { ...group, revision: group.revision + 1, updatedAt: new Date().toISOString(), members: [...group.members, { ...input, iconSeed: input.threadId, joinedAt: new Date().toISOString() }] };
      this.store.save(next, group.revision);
      return next;
    });
  }
  async rename(id: string, name: string, revision: number) {
    return this.write(async () => {
      const group = this.read(id);
      this.checkRevision(group, revision);
      await this.conversation.setThreadName(group.managerThreadId, { name });
      const next = { ...group, name, revision: group.revision + 1, updatedAt: new Date().toISOString() };
      this.store.save(next, group.revision);
      return next;
    });
  }
  async dispatch(id: string, threadId: string, receipt: { key: string; status: "pending" | "sent"; turnId: string | null }) {
    return this.write(async () => {
      const group = this.read(id);
      if (group.lifecycle !== "active") throw new SwarmError("swarm_closed", "This conversation is closed.");
      const member = group.members.find(m => m.threadId === threadId);
      if (!member) throw new SwarmError("member_not_found", "Worker is not part of this swarm.");
      const previous = member.dispatches ?? [];
      const existing = previous.find(d => d.key === receipt.key);
      if (receipt.status === "pending" && existing) throw new SwarmError("duplicate_dispatch", "Assignment already recorded; inspect its result before retrying.");
      if (!existing && previous.length >= 64) throw new SwarmError("dispatch_limit", "This worker has reached its assignment history limit.");
      const dispatches = [...previous.filter(d => d.key !== receipt.key), receipt];
      const next = { ...group, revision: group.revision + 1, updatedAt: new Date().toISOString(), members: group.members.map(m => m.threadId === threadId ? { ...m, dispatches } : m) };
      this.store.save(next, group.revision);
      return next;
    });
  }
  async close(id: string, revision: number) {
    return this.write(async () => {
      const group = this.read(id); this.checkRevision(group, revision);
      if (group.lifecycle === "closed") return group;
      const next: SwarmGroup = { ...group, lifecycle: "closed", revision: group.revision + 1, updatedAt: new Date().toISOString() };
      this.store.save(next, group.revision);
      return next;
    });
  }
  async interrupt(id: string): Promise<SwarmInterruptResult[]> {
    const group = this.read(id);
    return Promise.all(group.members.map(async ({ threadId }): Promise<SwarmInterruptResult> => {
      let turnId: string | null;
      try { turnId = this.conversation.getThreadState(threadId).activeTurnId; }
      catch { return { threadId, outcome: "unavailable" }; }
      if (!turnId) return { threadId, outcome: "idle" };
      try { await this.conversation.interruptTurn(threadId, turnId); return { threadId, outcome: "interrupted" }; }
      catch { return { threadId, outcome: "failed" }; }
    }));
  }
}
