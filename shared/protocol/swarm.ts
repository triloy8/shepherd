import type { SurfaceConversation } from "./conversation.js";

/** Durable membership; turn completion never closes a group or verifies its work. */
export type SwarmMember = { threadId: string; name: string; assignment: string; iconSeed: string; joinedAt: string; dispatches?: Array<{ key: string; status: "pending" | "sent"; turnId: string | null }> };
export type SwarmGroup = {
  version: 1; id: string; revision: number; name: string; project: string;
  managerThreadId: string; strategy: string; lifecycle: "active" | "closed";
  createdAt: string; updatedAt: string; members: SwarmMember[];
};
export type SwarmWorkerState = "unknown" | "idle" | "running" | "completed" | "needs-attention" | "interrupted" | "failed";
export const swarmStateLabels: Record<SwarmWorkerState, string> = {
  unknown: "Unavailable", idle: "Idle", running: "Working", completed: "Turn finished",
  "needs-attention": "Needs attention", interrupted: "Stopped", failed: "Failed",
};
export type SwarmObservation = {
  threadId: string; state: SwarmWorkerState; activeTurnId: string | null;
  pendingApprovals: number; observedAt: string; conversation: SurfaceConversation | null;
};
export type SwarmSnapshot = { group: SwarmGroup; manager: SwarmObservation; workers: SwarmObservation[] };
export type SwarmInterruptResult = { threadId: string; outcome: "interrupted" | "idle" | "unavailable" | "failed" };
export type SwarmEventData = { swarm: { groupId: string | null }; reset: { reason: "event_too_large" | "history_changed" } };

/** Reject malformed on-disk records rather than inventing ownership or membership. */
export function isSwarmGroup(value: unknown): value is SwarmGroup {
  if (!value || typeof value !== "object") return false;
  const g = value as SwarmGroup;
  const text = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s);
  return g.version === 1 && text(g.id, 64) && /^[A-Za-z0-9_-]+$/.test(g.id)
    && Number.isSafeInteger(g.revision) && g.revision >= 1 && text(g.name, 120)
    && text(g.project, 4096) && text(g.managerThreadId, 256) && typeof g.strategy === "string" && g.strategy.length <= 120
    && ["active", "closed"].includes(g.lifecycle) && typeof g.createdAt === "string" && Number.isFinite(Date.parse(g.createdAt)) && typeof g.updatedAt === "string" && Number.isFinite(Date.parse(g.updatedAt))
    && Array.isArray(g.members) && g.members.length <= 64 && g.members.every(m => m && text(m.threadId, 256) && text(m.name, 80)
      && (m.dispatches === undefined || (Array.isArray(m.dispatches) && m.dispatches.length <= 64 && m.dispatches.every(d => d && text(d.key, 128) && ["pending", "sent"].includes(d.status) && (d.turnId === null || text(d.turnId, 256))) && new Set(m.dispatches.map(d => d.key)).size === m.dispatches.length))
      && typeof m.assignment === "string" && m.assignment.length <= 4096 && text(m.iconSeed, 256) && typeof m.joinedAt === "string" && Number.isFinite(Date.parse(m.joinedAt)))
    && new Set([g.managerThreadId, ...g.members.map(m => m.threadId)]).size === g.members.length + 1
    && new Set(g.members.map(m => m.name.toLocaleLowerCase())).size === g.members.length;
}
