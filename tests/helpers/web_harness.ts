import { WebSurfaceApi } from "../../server/adapters/web/api.js";
import { readWebConfig } from "../../server/adapters/web/config.js";
import { ApprovalsStore } from "../../server/core/approvals.js";
import { ThreadBindingConflictError } from "../../server/core/conversation_routing_service.js";
import type { SurfaceAdapterContext } from "../../server/runtime/surface_adapter.js";
import type { SurfaceApplicationContext } from "../../server/core/surface_application_context.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";

export const WEB_TEST_TOKEN = "a".repeat(64);
export function webHarness() {
  const calls: string[] = [];
  const bindings = new Map<string, string>();
  const active = new Map<string, string | null>();
  const approvals = new ApprovalsStore();
  const abort = new AbortController();
  let publish!: (id: string, event: BridgeEvent) => void;
  let sequence = 0;
  const application = {
    async setSurfaceProject(id: string, project: string) { calls.push(`project:${id}`); return { repoSlug: project }; },
    async createSurfaceThread(id: string) { const threadId = `thread-${++sequence}`; bindings.set(id, threadId); active.set(threadId, null); calls.push("create"); return threadId; },
    async switchSurfaceThread(id: string, threadId: string) {
      if (threadId === "discord-thread" || [...bindings.values()].includes(threadId)) throw new ThreadBindingConflictError(threadId);
      bindings.set(id, threadId); active.set(threadId, null); calls.push("resume"); return threadId;
    },
    disposeSurface(id: string) { calls.push(`dispose:${id}`); bindings.delete(id); },
    conversation: {
      async listStoredThreads(request: unknown) { calls.push("threads"); return { threads: [{ threadId: "stored" }], nextCursor: null, backwardsCursor: null }; },
      async listThreadTurns(threadId: string, request: unknown) { calls.push(`history:${threadId}`); return { data: [{ id: "turn", items: [] }], nextCursor: null, backwardsCursor: null }; },
      async interruptTurn(threadId: string) { calls.push(`interrupt:${threadId}`); active.set(threadId, null); },
    },
  };
  const context: SurfaceAdapterContext = {
    signal: abort.signal, approvalPolicy: "on-request",
    createApplication(listener) { publish = listener; return application as unknown as SurfaceApplicationContext; },
    isQuiescing: () => abort.signal.aborted,
    reportHealth: (health) => calls.push(`health:${health.state}`),
    ingress: {
      getThreadState(threadId) { return { threadId, sessionId: "session", activeTurnId: active.get(threadId) ?? null, approvalPolicy: "on-request" }; },
      async submitTurn(threadId) {
        calls.push(`submit:${threadId}`); active.set(threadId, "turn-1");
        const id = [...bindings].find(([, thread]) => thread === threadId)![0];
        publish(id, { id: "bridge-1", type: "turn.started", threadId, sessionId: "session", ts: new Date().toISOString(), payload: { turnId: "turn-1" } });
        return { ok: true, turnId: "turn-1" };
      },
      async steerTurn(threadId) { calls.push(`steer:${threadId}`); return { ok: true, turnId: "turn-1" }; },
    },
    interactions: {} as never,
    approvals: {
      listApprovals: (threadId) => approvals.listByThread(threadId),
      async applyApprovalDecision(threadId, id, decision) { approvals.markDecided(threadId, id, decision); approvals.markApplied(threadId, id); calls.push("approval"); },
    },
  };
  const config = readWebConfig({ SHEPHERD_WEB_TOKEN: WEB_TEST_TOKEN, SHEPHERD_WEB_ORIGINS: "https://ui.example.test" });
  const api = new WebSurfaceApi(context, config);
  const request = (path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) => api.fetch(new Request(`http://127.0.0.1/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${WEB_TEST_TOKEN}`, ...(data !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  }));
  const create = async (data: unknown = { project: "~" }) => {
    const response = await request("/conversations", "POST", data);
    if (response.status !== 201) throw new Error(await response.text());
    return response.json() as Promise<{ id: string; threadId: string; project: string }>;
  };
  return { api, context, config, calls, bindings, active, approvals, abort, application, request, create, publish: (id: string, event: BridgeEvent) => publish(id, event) };
}
