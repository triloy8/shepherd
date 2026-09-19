import type { ApprovalDecisionRequest, ApprovalRecord } from "./approvals.js";
import type { BridgeEvent } from "./events.js";
import type { GetThreadStateResponse, ListStoredThreadsResponse, ListThreadTurnsResponse } from "./requests.js";
import type { SignalEnvelope } from "./signals.js";

/** Versioned browser contract, independent of adapter implementation. */
export const WEB_API_VERSION = 1;
export const WEB_API_PREFIX = "/api/v1";
export type WebConversation = { id: string; threadId: string; project: string };
export type WebCreateConversation = { project: string; threadId?: string };
export type WebMessageRequest = { text: string };
export type WebInterruptRequest = { turnId?: string };
export type WebApprovalRequest = ApprovalDecisionRequest;
export type WebOkResponse = { ok: true };
export type WebHealthResponse = WebOkResponse & { apiVersion: typeof WEB_API_VERSION };
export type WebMessageResponse = { type: "submit" | "steer"; threadId: string; turnId: string | null };
export type WebConversationState = WebConversation & { state: GetThreadStateResponse };
export type WebConversationsResponse = { conversations: WebConversation[] };
export type WebApprovalsResponse = { approvals: ApprovalRecord[] };
export type WebThreadsResponse = ListStoredThreadsResponse;
export type WebHistoryResponse = ListThreadTurnsResponse;
export type WebError = { error: { code: string; message: string } };
/** SSE event names and their JSON data. SSE IDs are opaque replay cursors. */
export type WebEventData = {
  bridge: BridgeEvent;
  signal: SignalEnvelope;
  reset: { reason: "event_too_large" };
};
