import type { SurfaceAdapterContext } from "../../core/surface_api.js";
import { SwarmService, SwarmError, SwarmManagerService, SWARM_MANAGER_INSTRUCTIONS, SWARM_WORKER_INSTRUCTIONS } from "../../core/surface_api.js";
import type { SwarmStore } from "../../ports/swarm_store.js";
import type { SwarmGroup, SwarmObservation, SwarmSnapshot, SwarmEventData } from "../../../shared/protocol/swarm.js";
import type { WebConversation } from "../../../shared/protocol/web.js";
import type { WebConfig } from "../shared/browser_config.js";
import { WebSurfaceApi } from "../shared/browser_api.js";
import { WebEventFeed } from "../shared/browser_event_feed.js";
import { WebRequestError } from "../shared/browser_errors.js";
import { readBoundedJson } from "../shared/body.js";

function text(data: Record<string, unknown>, key: string, max: number, optional = false): string {
  const value = data[key];
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max || (key === "assignment" ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) throw new WebRequestError(400, "invalid_request", `Invalid ${key}.`);
  return value.trim();
}
async function body(request: Request, keys: string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new WebRequestError(415, "unsupported_media_type", "Content-Type must be application/json.");
  let data: unknown;
  try { data = await readBoundedJson(request, 16 * 1024); }
  catch { throw new WebRequestError(400, "invalid_request", "Expected a JSON body of at most 16 KiB."); }
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) throw new WebRequestError(400, "invalid_request", "Unexpected request fields.");
  return data as Record<string, unknown>;
}
function revision(data: Record<string, unknown>): number {
  if (!Number.isSafeInteger(data.revision) || Number(data.revision) < 1) throw new WebRequestError(400, "invalid_request", "A current revision is required.");
  return Number(data.revision);
}
const json = (status: number, value: unknown) => Response.json(value, { status });
const errorStatuses: Record<string, number> = { swarm_not_found: 404, member_not_found: 404, swarm_limit: 429, worker_limit: 429 };

/** One aggregate roster feed, plus the shared browser API for conversation controls. */
export class SwarmSurfaceApi {
  readonly browser: WebSurfaceApi;
  readonly groups: SwarmService;
  private readonly feed = new WebEventFeed<SwarmEventData>();
  private readonly recent = new Map<string, { at: number; status: SwarmObservation["state"] }>();
  private readonly unregisterManager: () => void;
  private readonly opening = new Map<string, Promise<WebConversation>>();
  constructor(private readonly context: SurfaceAdapterContext, config: WebConfig, store: SwarmStore) {
    this.browser = new WebSurfaceApi(context, config, {
      adapter: "swarm", maxConversations: 96, route: request => this.route(request),
      onEvent: (threadId, event) => {
        if (event.type === "turn.started" || event.type === "turn.completed" || event.type === "turn.failed" || event.type.startsWith("approval.")) {
          this.recent.delete(threadId);
          this.feed.publish("swarm", { groupId: null });
        }
      },
    });
    this.groups = new SwarmService(store, this.browser.application.conversation);
    const manager = new SwarmManagerService({
      groups: this.groups, conversation: this.browser.application.conversation,
      ingress: context.ingress, approvals: context.approvals, bridge: context.swarmManager,
      interrupt: (threadId, turnId) => this.browser.application.conversation.interruptTurn(threadId, turnId),
      isAvailable: () => !context.isQuiescing() && !context.signal.aborted,
      open: threadId => this.open(threadId),
      createWorker: (project, provider) => this.browser.create(project, undefined, undefined, undefined, provider, SWARM_WORKER_INSTRUCTIONS),
      detach: id => this.browser.detachConversation(id),
      observe: threadId => this.observe(threadId), snapshot: group => this.snapshot(group),
      onChange: groupId => this.feed.publish("swarm", { groupId }),
    });
    this.unregisterManager = context.swarmManager?.connect(params => manager.manage(params)) ?? (() => {});
  }
  fetch(request: Request) { return this.browser.fetch(request); }
  presentSignal(signal: Parameters<WebSurfaceApi["presentSignal"]>[0]) { this.browser.presentSignal(signal); }
  dispose() { this.unregisterManager(); this.feed.close(); this.browser.dispose(); }
  private async open(threadId: string, instructions?: string): Promise<WebConversation> {
    const existing = this.browser.listConversations().find(c => c.threadId === threadId);
    if (existing) return existing;
    const pending = this.opening.get(threadId);
    if (pending) return pending;
    const operation = this.browser.create(undefined, threadId, undefined, undefined, undefined, instructions ?? (this.groups.list().some(g => g.managerThreadId === threadId) ? SWARM_MANAGER_INSTRUCTIONS : SWARM_WORKER_INSTRUCTIONS)).finally(() => this.opening.delete(threadId));
    this.opening.set(threadId, operation);
    return operation;
  }
  private async observe(threadId: string): Promise<SwarmObservation> {
    const observation: SwarmObservation = { threadId, state: "unknown", activeTurnId: null, pendingApprovals: 0, observedAt: new Date().toISOString(), conversation: this.browser.listConversations().find(c => c.threadId === threadId) ?? null };
    try {
      const state = this.context.ingress.getThreadState(threadId);
      observation.activeTurnId = state.activeTurnId;
      observation.pendingApprovals = this.context.approvals.listApprovals(threadId).filter(a => a.status === "pending").length;
      if (observation.pendingApprovals) observation.state = "needs-attention";
      else if (state.activeTurnId) observation.state = "running";
      else {
        let cached = this.recent.get(threadId);
        if (!cached || Date.now() - cached.at > 30_000) {
          const page = await this.browser.application.conversation.listThreadTurns(threadId, { limit: 1, sortDirection: "desc", itemsView: "none" });
          const last = page.data[0]?.status;
          const status = last === "completed" || last === "interrupted" || last === "failed" ? last : last === "in_progress" ? "unknown" : "idle";
          cached = { at: Date.now(), status }; this.recent.set(threadId, cached);
        }
        observation.state = cached.status;
      }
    } catch { /* An unavailable observation is never evidence of completion. */ }
    return observation;
  }
  private async snapshot(group: SwarmGroup): Promise<SwarmSnapshot> {
    const workers: SwarmObservation[] = [];
    for (let i = 0; i < group.members.length; i += 4) workers.push(...await Promise.all(group.members.slice(i, i + 4).map(m => this.observe(m.threadId))));
    return { group, manager: await this.observe(group.managerThreadId), workers };
  }
  private async route(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!/^\/api\/swarms(?:\/|$)/.test(path)) return null;
    try {
      if (path === "/api/swarms/events" && request.method === "GET") return new Response(this.feed.open(request.headers.get("last-event-id"), request.signal), { headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" } });
      if (path === "/api/swarms") {
        if (request.method === "GET") return json(200, { groups: this.groups.list() });
        if (request.method === "POST") {
          const data = await body(request, ["name", "project", "managerThreadId", "provider", "strategy"]);
          const name = text(data, "name", 120, true) || "New conversation", strategy = text(data, "strategy", 120, true);
          const threadId = text(data, "managerThreadId", 256, true);
          const project = text(data, "project", 4096, Boolean(threadId));
          const provider = text(data, "provider", 64, true);
          if (provider && !this.browser.application.conversation.listProviders().some(p => p.id === provider)) throw new WebRequestError(400, "invalid_request", "Choose an available provider.");
          if (provider && threadId) throw new WebRequestError(400, "invalid_request", "An existing manager determines its provider.");
          const manager = threadId ? await this.open(threadId, SWARM_MANAGER_INSTRUCTIONS) : await this.browser.create(project, undefined, undefined, undefined, provider || undefined, SWARM_MANAGER_INSTRUCTIONS);
          try {
            const group = await this.groups.create({ name, project: manager.project, managerThreadId: manager.threadId, strategy });
            this.feed.publish("swarm", { groupId: group.id });
            return json(201, { group });
          } catch (error) { if (!threadId) this.browser.detachConversation(manager.id); throw error; }
        }
        throw new WebRequestError(405, "method_not_allowed", "Method is not supported for this route.");
      }
      const match = /^\/api\/swarms\/([A-Za-z0-9_-]{1,64})(?:\/(members|open|close|interrupt|rename))?$/.exec(path);
      if (!match) throw new WebRequestError(404, "not_found", "Route not found.");
      const group = this.groups.read(match[1]!);
      if (!match[2] && request.method === "GET") return json(200, await this.snapshot(group));
      if (request.method !== "POST") throw new WebRequestError(405, "method_not_allowed", "Method is not supported for this route.");
      if (match[2] === "open") {
        const data = await body(request, ["threadId"]), threadId = text(data, "threadId", 256);
        if (group.managerThreadId !== threadId && !group.members.some(m => m.threadId === threadId)) throw new WebRequestError(404, "member_not_found", "Conversation is not part of this swarm.");
        return json(200, await this.open(threadId));
      }
      if (match[2] === "rename") {
        const data = await body(request, ["name", "revision"]);
        const name = text(data, "name", 120);
        const expectedRevision = revision(data);
        this.groups.checkRevision(this.groups.read(group.id), expectedRevision);
        await this.open(group.managerThreadId);
        const updated = await this.groups.rename(group.id, name, expectedRevision);
        this.feed.publish("swarm", { groupId: group.id });
        return json(200, { group: updated });
      }
      if (match[2] === "members") {
        const data = await body(request, ["revision", "name", "assignment", "threadId", "provider"]);
        this.groups.checkRevision(group, revision(data));
        if (group.lifecycle !== "active") throw new SwarmError("swarm_closed", "Closed swarms cannot add workers.");
        if (group.members.length >= 64) throw new SwarmError("worker_limit", "A swarm supports at most 64 workers.");
        const name = text(data, "name", 80), assignment = text(data, "assignment", 4096, true), threadId = text(data, "threadId", 256, true), provider = text(data, "provider", 64, true);
        if (group.members.some(m => m.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new SwarmError("duplicate_name", "Choose a distinct worker name.");
        if (provider && (!this.browser.application.conversation.listProviders().some(p => p.id === provider) || threadId)) throw new WebRequestError(400, "invalid_request", "Choose an available provider for a new worker.");
        if (!threadId && !/^[\w.-]+\/[\w.-]+$/.test(group.project)) throw new SwarmError("isolated_workspace_required", "New workers require an owner/repo project for isolated workspaces. Attach an existing conversation instead.");
        const worker = threadId ? await this.open(threadId) : await this.browser.create(group.project, undefined, undefined, undefined, provider || undefined, SWARM_WORKER_INSTRUCTIONS);
        try {
          const updated = await this.groups.addMember(group.id, revision(data), { threadId: worker.threadId, name, assignment });
          this.feed.publish("swarm", { groupId: group.id });
          return json(201, { group: updated });
        } catch (error) { if (!threadId) this.browser.detachConversation(worker.id); throw error; }
      }
      if (match[2] === "close" || match[2] === "interrupt") {
        const data = await body(request, ["revision"]); this.groups.checkRevision(group, revision(data));
        const result = match[2] === "close" ? { group: await this.groups.close(group.id, revision(data)) } : { results: await this.groups.interrupt(group.id) };
        this.feed.publish("swarm", { groupId: group.id });
        return json(200, result);
      }
      throw new WebRequestError(404, "not_found", "Route not found.");
    } catch (error) {
      if (error instanceof SwarmError) throw new WebRequestError(errorStatuses[error.code] ?? 409, error.code, error.message);
      throw error;
    }
  }
}
