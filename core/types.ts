export type ThreadItemType =
  | "userMessage"
  | "agentMessage"
  | "plan"
  | "reasoning"
  | "commandExecution"
  | "fileChange"
  | "mcpToolCall"
  | "collabToolCall"
  | "webSearch"
  | "imageView"
  | "enteredReviewMode"
  | "exitedReviewMode"
  | "contextCompaction"
  | "unknown";

export interface ThreadItem {
  id: string;
  itemType: ThreadItemType;
  label: string;
  content: string;
  createdAt: string;
  status?: "pending" | "error";
  error?: string;
  outputSegments?: OutputSegment[];
  protocolItemId?: string;
}

export interface ThreadSnapshot {
  threadId: string | null;
  items: ThreadItem[];
  savedAt: string;
}

export interface AgentState {
  threadId: string | null;
  items: ThreadItem[];
  activeTurnId: string | null;
  activeAgentItemId: string | null;
  isTurnActive: boolean;
  eventSource?: EventSource;
}

export interface BridgeEvent {
  type: "ready" | "thread_started" | "turn_started" | "notification" | "error";
  message?: string;
  threadId?: string;
  turnId?: string;
  method?: string;
  params?: unknown;
}

export interface StartThreadResponse {
  threadId: string;
}

export interface StartTurnResponse {
  ok: boolean;
  turnId?: string;
}

export interface InterruptTurnResponse {
  ok: boolean;
}

export interface OutputSegment {
  id: string;
  kind: "text" | "subBlock";
  text: string;
  title?: string;
  itemType?: ThreadItemType;
  status?: "pending" | "error" | "completed";
  error?: string;
  expanded?: boolean;
  createdAt: string;
}
