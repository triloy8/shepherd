import { request } from "../api";
import type { SwarmGroup, SwarmSnapshot, SwarmInterruptResult } from "../../../shared/protocol/swarm";
import type { WebConversation } from "../../../shared/protocol/web";
const path = (id: string) => `/swarms/${encodeURIComponent(id)}`;
export const swarms = {
  list: (signal?: AbortSignal) => request<{ groups: SwarmGroup[] }>("/swarms", "GET", undefined, signal),
  read: (id: string, signal?: AbortSignal) => request<SwarmSnapshot>(path(id), "GET", undefined, signal),
  create: (input: { name?: string; project?: string; managerThreadId?: string; provider?: string; strategy?: string }) => request<{ group: SwarmGroup }>("/swarms", "POST", input),
  rename: (id: string, revision: number, name: string) => request<{ group: SwarmGroup }>(`${path(id)}/rename`, "POST", { revision, name }),
  add: (id: string, input: { revision: number; name: string; assignment?: string; threadId?: string; provider?: string }) => request<{ group: SwarmGroup }>(`${path(id)}/members`, "POST", input),
  open: (id: string, threadId: string) => request<WebConversation>(`${path(id)}/open`, "POST", { threadId }),
  interrupt: (id: string, revision: number) => request<{ results: SwarmInterruptResult[] }>(`${path(id)}/interrupt`, "POST", { revision }),
};
