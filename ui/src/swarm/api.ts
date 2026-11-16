import { request } from "../api";
import type { SwarmGroup, SwarmSnapshot, SwarmInterruptResult } from "../../../shared/protocol/swarm";
import type { SurfaceConversation } from "../../../shared/protocol/conversation";
const path = (id: string) => `/swarms/${encodeURIComponent(id)}`;
export const swarms = {
  list: (signal?: AbortSignal) => request<{ groups: SwarmGroup[] }>("/swarms", "GET", undefined, signal),
  read: (id: string, signal?: AbortSignal) => request<SwarmSnapshot>(path(id), "GET", undefined, signal),
  open: (id: string, threadId: string) => request<SurfaceConversation>(`${path(id)}/open`, "POST", { threadId }),
  interrupt: (id: string, revision: number) => request<{ results: SwarmInterruptResult[] }>(`${path(id)}/interrupt`, "POST", { revision }),
};
