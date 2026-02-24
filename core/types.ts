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
  pendingApprovals: PendingApprovalRequest[];
  selectedApprovalPolicy: AskForApproval;
  activeTurnId: string | null;
  activeAgentItemId: string | null;
  isTurnActive: boolean;
  eventSource?: EventSource;
}

export interface BridgeEvent {
  type: "ready" | "thread_started" | "turn_started" | "notification" | "server_request" | "error";
  message?: string;
  threadId?: string;
  turnId?: string;
  requestId?: string;
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
  details?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  displayMode?: DisplayMode;
  expanded?: boolean;
  createdAt: string;
}

export type CommandApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type ReviewApprovalDecision = "approved" | "approved_for_session" | "denied" | "abort";

export interface ApprovalQuestionOption {
  label: string;
  description: string;
}

export interface ApprovalQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ApprovalQuestionOption[];
}

interface PendingApprovalBase {
  requestId: string;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  createdAt: string;
  reason: string | null;
  submitting: boolean;
  error?: string;
}

export interface PendingCommandApprovalRequest extends PendingApprovalBase {
  kind: "command";
  command: string | null;
  cwd: string | null;
  commandActions: string[];
}

export interface PendingFileChangeApprovalRequest extends PendingApprovalBase {
  kind: "fileChange";
  grantRoot: string | null;
}

export interface PendingToolUserInputRequest extends PendingApprovalBase {
  kind: "toolUserInput";
  questions: ApprovalQuestion[];
}

export interface PendingDynamicToolCallRequest extends PendingApprovalBase {
  kind: "dynamicToolCall";
  callId: string;
  tool: string;
  arguments: unknown;
}

export interface PendingChatgptAuthRefreshRequest extends PendingApprovalBase {
  kind: "chatgptAuthRefresh";
  refreshReason: string;
  previousAccountId: string | null;
}

export interface PendingLegacyExecApprovalRequest extends PendingApprovalBase {
  kind: "legacyExecApproval";
  callId: string;
  approvalId: string | null;
  command: string[];
  cwd: string | null;
}

export interface PendingLegacyPatchApprovalRequest extends PendingApprovalBase {
  kind: "legacyPatchApproval";
  callId: string;
  grantRoot: string | null;
  fileChangeCount: number;
}

export type PendingApprovalRequest =
  | PendingCommandApprovalRequest
  | PendingFileChangeApprovalRequest
  | PendingToolUserInputRequest
  | PendingDynamicToolCallRequest
  | PendingChatgptAuthRefreshRequest
  | PendingLegacyExecApprovalRequest
  | PendingLegacyPatchApprovalRequest;

export type AskForApproval = "untrusted" | "on-failure" | "on-request" | "never";
export type DisplayMode = "debug" | "compact" | "full";
