export type ItemKind = "user_input" | "agent_output" | "event";

export interface ThreadItem {
  id: string;
  kind: ItemKind;
  label: string;
  content: string;
  createdAt: string;
  status?: "pending" | "error";
  error?: string;
  outputSegments?: OutputSegment[];
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
  kind: "text" | "reasoning";
  text: string;
  title?: string;
  expanded?: boolean;
  createdAt: string;
}
