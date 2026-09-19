import { randomUUID } from "node:crypto";
import { WEB_API_PREFIX, WEB_API_VERSION, type WebConversation, type WebError } from "../../../shared/protocol/web.js";
import { toTextUserInput } from "../../../shared/protocol/user_input.js";
import { ApplicationActionError } from "../../core/action_error.js";
import { ApprovalDecisionError } from "../../core/approvals.js";
import { ThreadBindingConflictError } from "../../core/conversation_routing_service.js";
import { executeTurnRouting } from "../../core/turn_routing_service.js";
import type { SurfaceAdapterContext } from "../../runtime/surface_adapter.js";
import type { SurfaceApplicationContext } from "../../core/surface_application_context.js";
import type { RegisteredSignal } from "../../core/signal_registry.js";
import { BodyTooLargeError, readBoundedJson } from "../http/body.js";
import type { WebConfig } from "./config.js";
import { WebRequestError } from "./errors.js";
import { WebEventFeed } from "./event_feed.js";

export const WEB_MAX_BODY_BYTES = 64 * 1024;
const MAX_CONVERSATIONS = 32;
const MAX_REQUESTS = 32;
type Entry = { id: string; threadId: string | null; project: string; busy: boolean; feed: WebEventFeed };

function requiredString(object: Record<string, unknown>, key: string, max = 4096): string {
  const value = object[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new WebRequestError(400, "invalid_request", `${key} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}
function optionalString(object: Record<string, unknown>, key: string, max = 4096): string | undefined {
  return object[key] === undefined ? undefined : requiredString(object, key, max);
}
function pagination(url: URL) {
  if ([...url.searchParams.keys()].some((key) => !["cursor", "limit"].includes(key))) {
    throw new WebRequestError(400, "invalid_query", "Only cursor and limit are supported.");
  }
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && cursor.length > 4096)) {
    throw new WebRequestError(400, "invalid_query", "limit must be 1–100; cursor must be at most 4096 characters.");
  }
  return { limit, ...(cursor ? { cursor } : {}) };
}
async function body(request: Request, fields: string[]): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new WebRequestError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  let value: unknown;
  try { value = await readBoundedJson(request, WEB_MAX_BODY_BYTES); }
  catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    throw new WebRequestError(400, "invalid_json", "Request body must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new WebRequestError(400, "invalid_request", `Expected an object with only these fields: ${fields.join(", ")}.`);
  }
  return value as Record<string, unknown>;
}

/** HTTP navigation state only. All agent operations use shared application ports. */
export class WebSurfaceApi {
  private readonly application: SurfaceApplicationContext;
  private readonly entries = new Map<string, Entry>();
  private readonly resuming = new Set<string>();
  private stopping = false;
  private requests = 0;

  constructor(private readonly context: SurfaceAdapterContext, private readonly config: WebConfig) {
    this.application = context.createApplication((id, event) => this.entries.get(id)?.feed.publish("bridge", event));
  }

  async fetch(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    const allowedOrigin = origin !== null && this.config.origins.includes(origin);
    const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff", "vary": "Origin" });
    if (allowedOrigin) headers.set("access-control-allow-origin", origin);
    const json = (status: number, value: unknown) => Response.json(value, { status, headers });
    const fail = (status: number, code: string, message: string) => json(status, { error: { code, message } } satisfies WebError);
    if (origin !== null && !allowedOrigin) return fail(403, "origin_denied", "Origin is not allowed.");
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (!allowedOrigin || !url.pathname.startsWith(`${WEB_API_PREFIX}/`)) return fail(403, "origin_denied", "Preflight is not allowed.");
      const method = request.headers.get("access-control-request-method");
      const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
      if (!method || !["GET", "POST", "DELETE"].includes(method) || requestedHeaders.some((s) => !["content-type", "last-event-id"].includes(s))) {
        return fail(403, "preflight_denied", "Requested method or headers are not allowed.");
      }
      headers.set("access-control-allow-methods", "GET, POST, DELETE");
      headers.set("access-control-allow-headers", "Content-Type, Last-Event-ID");
      headers.set("access-control-max-age", "600");
      return new Response(null, { status: 204, headers });
    }
    if (this.stopping || this.context.isQuiescing()) return fail(503, "unavailable", "Shepherd is stopping.");
    if (this.requests >= MAX_REQUESTS) return fail(429, "request_limit", "Too many in-flight requests.");
    this.requests++;
    try {
      if (request.method === "GET" && url.pathname === `${WEB_API_PREFIX}/health`) return json(200, { ok: true, apiVersion: WEB_API_VERSION });
      if (request.method === "GET" && url.pathname === `${WEB_API_PREFIX}/threads`) {
        return json(200, await this.application.conversation.listStoredThreads(pagination(url)));
      }
      if (url.pathname === `${WEB_API_PREFIX}/conversations`) {
        if (request.method === "GET") return json(200, { conversations: [...this.entries.values()].filter((e) => e.threadId).map((e) => this.summary(e)) });
        if (request.method === "POST") {
          const data = await body(request, ["project", "threadId"]);
          return json(201, await this.create(requiredString(data, "project"), optionalString(data, "threadId", 256)));
        }
      }
      const match = /^\/api\/v1\/conversations\/([^/]+)(?:\/(messages|interrupt|turns|approvals|events)(?:\/([^/]+))?)?$/.exec(url.pathname);
      if (!match) return fail(404, "not_found", "Route not found.");
      const entry = this.entries.get(match[1]!);
      if (!entry?.threadId) return fail(404, "conversation_not_found", "Conversation not found. Resume its stored thread after a host restart.");
      const threadId = entry.threadId;
      const action = match[2];
      if (match[3] && action !== "approvals") return fail(404, "not_found", "Route not found.");
      if (!action && request.method === "GET") return json(200, { ...this.summary(entry), state: this.context.ingress.getThreadState(threadId) });
      if (!action && request.method === "DELETE") {
        await this.mutate(entry, async () => this.remove(entry));
        return json(200, { ok: true });
      }
      if (action === "events" && request.method === "GET") {
        const stream = entry.feed.open(request.headers.get("last-event-id"), request.signal);
        headers.set("content-type", "text/event-stream");
        headers.set("x-accel-buffering", "no");
        return new Response(stream, { headers });
      }
      if (action === "turns" && request.method === "GET") {
        return json(200, await this.application.conversation.listThreadTurns(threadId, { ...pagination(url), itemsView: "full" }));
      }
      if (action === "approvals" && !match[3] && request.method === "GET") return json(200, { approvals: this.context.approvals.listApprovals(threadId) });
      if (action === "messages" && request.method === "POST") {
        const data = await body(request, ["text"]);
        const text = requiredString(data, "text", 32_768);
        const input = [toTextUserInput(text)];
        return json(200, await this.mutate(entry, () => executeTurnRouting({ conversation: this.context.ingress }, {
          surface: { adapter: "web", surfaceId: entry.id, content: text, input, isCommand: false, isDirectAddressed: true },
          handled: false, threadId, input, approvalPolicy: this.context.approvalPolicy,
        })));
      }
      if (action === "interrupt" && request.method === "POST") {
        const data = await body(request, ["turnId"]);
        const turnId = optionalString(data, "turnId", 256);
        await this.mutate(entry, () => this.application.conversation.interruptTurn(threadId, turnId));
        return json(200, { ok: true });
      }
      if (action === "approvals" && match[3] && request.method === "POST") {
        const data = await body(request, ["decision", "reason"]);
        const decision = requiredString(data, "decision", 128);
        const reason = optionalString(data, "reason");
        let approvalId: string;
        try { approvalId = decodeURIComponent(match[3]); } catch { throw new WebRequestError(400, "invalid_request", "Malformed approval identifier."); }
        if (approvalId.length > 256) throw new WebRequestError(400, "invalid_request", "Approval identifier is too long.");
        await this.mutate(entry, () => this.context.approvals.applyApprovalDecision(threadId, approvalId, { decision, ...(reason ? { reason } : {}) }));
        return json(200, { ok: true });
      }
      return fail(405, "method_not_allowed", "Method is not supported for this route.");
    } catch (error) {
      if (error instanceof WebRequestError) return fail(error.status, error.code, error.message);
      if (error instanceof BodyTooLargeError) return fail(413, "body_too_large", "Request body exceeds 64 KiB.");
      if (error instanceof ThreadBindingConflictError) return fail(409, "thread_in_use", error.message);
      if (error instanceof ApprovalDecisionError) return fail(error.code === "approval_not_found" ? 404 : error.code === "invalid_decision" ? 400 : 409, error.code, error.message);
      if (error instanceof ApplicationActionError) return fail(409, error.failure.code, "An application prerequisite is not satisfied.");
      console.error("Web API operation failed:", error);
      return fail(502, "operation_failed", "The backend operation failed. Check host logs.");
    } finally { this.requests--; }
  }

  presentSignal(signal: RegisteredSignal): void {
    this.entries.get(signal.target.delivery.surfaceId)?.feed.publish("signal", signal.envelope);
  }

  dispose(): void {
    this.stopping = true;
    const failures: unknown[] = [];
    for (const entry of this.entries.values()) {
      try { this.remove(entry); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Web conversation cleanup failed.");
  }

  private summary(entry: Entry): WebConversation {
    return { id: entry.id, threadId: entry.threadId!, project: entry.project };
  }
  private available(): void {
    if (this.stopping || this.context.isQuiescing()) throw new WebRequestError(503, "unavailable", "Shepherd is stopping.");
  }
  private remove(entry: Entry): void {
    entry.feed.close();
    this.entries.delete(entry.id);
    this.application.disposeSurface(entry.id);
  }
  private async create(project: string, threadId?: string): Promise<WebConversation> {
    this.available();
    if (threadId && !/^[A-Za-z0-9_-]+$/.test(threadId)) {
      throw new WebRequestError(400, "invalid_request", "threadId must be an opaque thread identifier, not a path.");
    }
    if (this.entries.size >= MAX_CONVERSATIONS) throw new WebRequestError(429, "conversation_limit", "Detach an existing conversation before opening another.");
    if (threadId && this.resuming.has(threadId)) throw new WebRequestError(409, "thread_in_use", "Thread resume is already in progress.");
    const entry: Entry = { id: randomUUID(), threadId: null, project, busy: false, feed: new WebEventFeed() };
    this.entries.set(entry.id, entry);
    if (threadId) this.resuming.add(threadId);
    try {
      const selected = await this.application.setSurfaceProject(entry.id, project);
      entry.project = selected.repoSlug;
      this.available();
      entry.threadId = threadId
        ? await this.application.switchSurfaceThread(entry.id, threadId)
        : await this.application.createSurfaceThread(entry.id);
      this.available();
      return this.summary(entry);
    } catch (error) { this.remove(entry); throw error; }
    finally { if (threadId) this.resuming.delete(threadId); }
  }
  private async mutate<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
    this.available();
    if (this.entries.get(entry.id) !== entry) throw new WebRequestError(404, "conversation_not_found", "Conversation was detached.");
    if (entry.busy) throw new WebRequestError(409, "conversation_busy", "Another operation is in progress; retry after it completes.");
    entry.busy = true;
    try { return await operation(); }
    finally { entry.busy = false; }
  }
}
