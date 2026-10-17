import type { ApprovalDecisionRequest, ApprovalRecord } from "./approvals.js";
import type { BridgeEvent, BridgeEventOf } from "./events.js";
import type { ThreadModelState, ThreadEffortState, ListModelsResponse, ReadThreadTokenUsageResponse, GetThreadStateResponse, HistoryItem, HistoryTurn, ListStoredThreadsResponse, ListThreadTurnsResponse } from "./requests.js";
import type { SignalEnvelope } from "./signals.js";

/** Browser contract, independent of provider implementation. */
export const WEB_API_PREFIX = "/api";
export type WebConversation = { id: string; threadId: string; project: string; provider?: string };
export type WebCreateConversation = { project: string; threadId?: never; provider?: import("./requests.js").AgentProvider } | { threadId: string; project?: string; provider?: never };
export type WebMessageRequest = { text: string; images?: string[] };
export type WebInterruptRequest = { turnId?: string };
export type WebApprovalRequest = ApprovalDecisionRequest;
export type WebOkResponse = { ok: true };
export type WebHealthResponse = WebOkResponse;
export type WebMessageResponse = { type: "submit" | "steer"; threadId: string; turnId: string | null };
export type WebConversationState = WebConversation & { state: GetThreadStateResponse };
export type WebConversationsResponse = { conversations: WebConversation[] };
export type WebApprovalsResponse = { approvals: ApprovalRecord[] };
export type WebThreadsResponse = ListStoredThreadsResponse;
export type WebImage = { url: string; prompt: string | null; name?: string; path?: string; kind?: "generated" | "viewed" };
/** History as presented to the browser. Images become server URLs; everything else is unchanged.
 * Live items use the same presentation, so a reload shows what the live view showed. */
export type WebHistoryItem =
  | Exclude<HistoryItem, { type: "image" }>
  | { id: string; type: "image"; webImage: WebImage; parentItemId?: string };
export type WebHistoryTurn = Omit<HistoryTurn, "items"> & { items: WebHistoryItem[] };
export type WebHistoryResponse = Omit<ListThreadTurnsResponse, "data"> & { data: WebHistoryTurn[]; revision: number };
export type WebError = { error: { code: string; message: string } };
/** SSE event names and their JSON data. SSE IDs are opaque replay cursors. */
type WebItemEvent<K extends "item.started" | "item.completed"> = Omit<BridgeEventOf<K>, "payload"> & { payload: { turnId: string | null; item: WebHistoryItem } };
/** Application events as delivered to the browser, with items presented like history. */
export type WebBridgeEvent = Exclude<BridgeEvent, { type: "item.started" | "item.completed" }> | WebItemEvent<"item.started"> | WebItemEvent<"item.completed">;
export type WebEventData = {
  bridge: WebBridgeEvent;
  signal: SignalEnvelope;
  reset: { reason: "event_too_large" | "history_changed" };
};

export type WebSettingsResponse = {
  model: ThreadModelState;
  effort: ThreadEffortState;
  modelCapabilities: {
    current: import("./model_capabilities.js").ModelCapabilities;
    next: import("./model_capabilities.js").ModelCapabilities;
  };
};
export type WebModelsResponse = ListModelsResponse;
export type WebContextResponse = ReadThreadTokenUsageResponse;
export type WebLimitsResponse = import("./account_limits.js").ProviderAccountLimits;
export type WebResetRequest = import("./account_limits.js").AccountResetRequest;
export type WebResetResponse = import("./account_limits.js").AccountResetResponse;
export type WebModelRequest = { model: string };
/** Strings select opaque values; null clears the override; mode default selects the model default. */
export type WebEffortRequest = { effort: import("./requests.js").EffortSelection };

export type WebRenameRequest = { name: string };

export type WebSkillsResponse = import("./requests.js").SkillsListResponse;
export type WebSkillRequest = { path: string; enabled: boolean };
export type WebSkillResponse = import("./requests.js").SkillsConfigWriteResponse;

export type WebRevertRequest = { beforeTurnId: string };
