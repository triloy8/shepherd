import type { WebSkillsResponse, WebSkillResponse, WebSettingsResponse, WebModelsResponse, WebContextResponse, WebLimitsResponse } from "../../shared/protocol/web";
import { WEB_API_PREFIX, type WebApprovalsResponse, type WebConversation, type WebConversationsResponse, type WebConversationState, type WebCreateConversation, type WebEventData, type WebHistoryResponse, type WebMessageResponse, type WebThreadsResponse } from "../../shared/protocol/web";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const data = await response.json().catch(() => null);
  throw new ApiError(response.status, data?.error?.code ?? "request_failed", data?.error?.message ?? `Request failed (${response.status}).`);
}
async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(60_000);
  const response = await fetch(`${WEB_API_PREFIX}${path}`, {
    method, credentials: "omit", cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return (await checked(response)).json() as Promise<T>;
}
const conversationPath = (id: string) => `/conversations/${encodeURIComponent(id)}`;
const page = (cursor?: string) => `?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
export const api = {
  compact: (id: string) => request(`${conversationPath(id)}/compact`, "POST", {}),
  rollback: (id: string, numTurns: number) => request(`${conversationPath(id)}/rollback`, "POST", { numTurns }),
  skills: (id: string, signal?: AbortSignal) => request<WebSkillsResponse>(`${conversationPath(id)}/skills`, "GET", undefined, signal),
  reloadSkills: (id: string) => request<WebSkillsResponse>(`${conversationPath(id)}/skills-reload`, "POST", {}),
  setSkill: (id: string, path: string, enabled: boolean) => request<WebSkillResponse>(`${conversationPath(id)}/skills`, "POST", { path, enabled }),
  settings: (id: string, signal?: AbortSignal) => request<WebSettingsResponse>(`${conversationPath(id)}/settings`, "GET", undefined, signal),
  models: (id: string, cursor?: string, signal?: AbortSignal) => request<WebModelsResponse>(`${conversationPath(id)}/models${page(cursor)}`, "GET", undefined, signal),
  context: (id: string, signal?: AbortSignal) => request<WebContextResponse>(`${conversationPath(id)}/context`, "GET", undefined, signal),
  limits: (signal?: AbortSignal) => request<WebLimitsResponse>("/limits", "GET", undefined, signal),
  setModel: (id: string, model: string) => request(`${conversationPath(id)}/model`, "POST", { model }),
  setEffort: (id: string, effort: string) => request(`${conversationPath(id)}/effort`, "POST", { effort }),
  conversations: (signal?: AbortSignal) => request<WebConversationsResponse>("/conversations", "GET", undefined, signal),
  threads: (cursor?: string, signal?: AbortSignal, archived = false) => request<WebThreadsResponse>(`/threads${page(cursor)}&archived=${archived}`, "GET", undefined, signal),
  create: (input: WebCreateConversation) => request<WebConversation>("/conversations", "POST", input),
  state: (id: string, signal?: AbortSignal) => request<WebConversationState>(conversationPath(id), "GET", undefined, signal),
  history: (id: string, cursor?: string, signal?: AbortSignal) => request<WebHistoryResponse>(`${conversationPath(id)}/turns${page(cursor)}`, "GET", undefined, signal),
  approvals: (id: string, signal?: AbortSignal) => request<WebApprovalsResponse>(`${conversationPath(id)}/approvals`, "GET", undefined, signal),
  send: (id: string, text: string) => request<WebMessageResponse>(`${conversationPath(id)}/messages`, "POST", { text }),
  interrupt: (id: string) => request(`${conversationPath(id)}/interrupt`, "POST", {}),
  decide: (id: string, approvalId: string, decision: string) => request(`${conversationPath(id)}/approvals/${encodeURIComponent(approvalId)}`, "POST", { decision }),
  rename: (id: string, name: string) => request(`${conversationPath(id)}/rename`, "POST", { name }),
  archive: (id: string) => request(`${conversationPath(id)}/archive`, "POST", {}),
  fork: (id: string) => request<WebConversation>(`${conversationPath(id)}/fork`, "POST", {}),
  restore: (threadId: string) => request(`/threads/${encodeURIComponent(threadId)}/unarchive`, "POST", {}),
  detach: (id: string) => request(conversationPath(id), "DELETE"),
};

export type StreamEvent = { [K in keyof WebEventData]: { id: string; type: K; data: WebEventData[K] } }[keyof WebEventData];

/** SSE framing across arbitrary UTF-8/chunk/CRLF boundaries, without unbounded buffering. */
export async function readEvents(body: ReadableStream<Uint8Array>, receive: (event: StreamEvent) => void, progress: () => void = () => {}): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let fields: string[] = [];
  let size = 0;
  function line(value: string) {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value === "") {
      const valueOf = (prefix: string) => fields.filter((field) => field.startsWith(prefix)).map((field) => field.slice(prefix.length).replace(/^ /, ""));
      const type = valueOf("event:").at(-1);
      const id = valueOf("id:").at(-1) ?? "";
      const data = valueOf("data:").join("\n");
      fields = []; size = 0;
      if (data && ["bridge", "signal", "reset"].includes(type ?? "")) receive({ id, type, data: JSON.parse(data) } as StreamEvent);
    } else if (!value.startsWith(":")) {
      fields.push(value); size += value.length;
      if (size > 262_144) throw new Error("Event exceeds the client buffer limit.");
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      progress();
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      }
      if (pending.length > 262_144) throw new Error("Event exceeds the client buffer limit.");
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function streamConversation(id: string, cursor: string | null, signal: AbortSignal, ready: () => void, receive: (event: StreamEvent) => void) {
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const heartbeat = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), 45_000); };
  heartbeat();
  try {
    const response = await checked(await fetch(`${WEB_API_PREFIX}${conversationPath(id)}/events`, {
      signal: AbortSignal.any([signal, idle.signal]), credentials: "omit", cache: "no-store", headers: cursor ? { "Last-Event-ID": cursor } : {},
    }));
    if (!response.body) throw new Error("Event stream is unavailable.");
    ready();
    await readEvents(response.body, receive, heartbeat);
  } finally { clearTimeout(timer!); }

}

export function explainError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "thread_in_use") return "This conversation is attached elsewhere. Detach it there, then try again.";
    if (error.code === "origin_denied") return "This address is not allowed. Add the UI’s exact origin to SHEPHERD_WEB_ORIGINS and restart the host.";
    if (error.code === "conversation_busy") return "Another action is in progress. Wait a moment, then try again.";
    if (error.code === "conversation_not_found") return "The host restarted or this conversation was detached. Resume the stored conversation to continue.";
    return error.message;
  }
  return "Could not reach Shepherd. Check your connection and try again.";
}
