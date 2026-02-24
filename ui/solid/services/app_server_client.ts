import type {
  AskForApproval,
  BridgeEvent,
  CommandApprovalDecision,
  FileChangeApprovalDecision,
  InterruptTurnResponse,
  ReviewApprovalDecision,
  StartThreadResponse,
  StartTurnResponse,
} from "../types/ui_types.js";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toLegacyBridgeEvent(raw: unknown): BridgeEvent {
  const record = asRecord(raw);
  const type = record.type;
  const payload = asRecord(record.payload);

  if (type === "session.started") {
    return { type: "ready" };
  }

  if (type === "session.error") {
    return { type: "error", message: (payload.message as string) ?? "Session error" };
  }

  if (type === "thread.started") {
    return { type: "thread_started", threadId: record.threadId as string | undefined };
  }

  if (type === "turn.started") {
    return { type: "turn_started", turnId: (payload.turnId as string | undefined) ?? undefined };
  }

  if (type === "turn.notification") {
    return {
      type: "notification",
      method: (payload.method as string | undefined) ?? "unknown",
      params: payload.params,
    };
  }

  if (type === "turn.stream.delta") {
    return {
      type: "notification",
      method: ((payload.method as string | undefined) ?? "item/agentMessage/delta") as string,
      params: { delta: (payload.textDelta as string | undefined) ?? "" },
    };
  }

  if (type === "approval.requested") {
    return {
      type: "server_request",
      requestId: payload.approvalId as string | undefined,
      method: payload.method as string | undefined,
      params: payload.params,
    };
  }

  if (type === "approval.failed") {
    return { type: "error", message: (payload.message as string) ?? "Approval failed" };
  }

  return {
    type: "notification",
    method: String(type ?? "unknown"),
    params: payload,
  };
}

let currentThreadId: string | null = null;
let activeSource: EventSource | null = null;
let onLegacyEvent: ((event: BridgeEvent) => void) | null = null;
let onLegacyError: ((error: Event) => void) | null = null;

function closeActiveSource(): void {
  activeSource?.close();
  activeSource = null;
}

function openSourceForCurrentThread(): void {
  if (!currentThreadId || !onLegacyEvent || !onLegacyError) return;

  closeActiveSource();
  const source = new EventSource(`/api/threads/${currentThreadId}/events`);
  const eventNames = [
    "session.started",
    "session.error",
    "thread.started",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.stream.delta",
    "turn.notification",
    "approval.requested",
    "approval.decided",
    "approval.applied",
    "approval.failed",
  ];

  const handleMessage = (event: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(event.data);
      onLegacyEvent?.(toLegacyBridgeEvent(parsed));
    } catch (error) {
      onLegacyEvent?.({
        type: "error",
        message: error instanceof Error ? error.message : "Invalid event payload.",
      });
    }
  };

  source.onmessage = handleMessage;
  for (const name of eventNames) {
    source.addEventListener(name, (event) => handleMessage(event as MessageEvent<string>));
  }
  source.onerror = (event) => onLegacyError?.(event);
  activeSource = source;
}

export async function startThread(approvalPolicy: AskForApproval): Promise<StartThreadResponse> {
  const response = await fetch("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvalPolicy }),
  });
  const result = await parseJson<{ threadId: string }>(response);
  currentThreadId = result.threadId;
  openSourceForCurrentThread();
  return { threadId: result.threadId };
}

export async function startTurn(input: string, approvalPolicy: AskForApproval): Promise<StartTurnResponse> {
  if (!currentThreadId) {
    await startThread(approvalPolicy);
  }

  const response = await fetch(`/api/threads/${currentThreadId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, approvalPolicy }),
  });
  return parseJson<StartTurnResponse>(response);
}

export async function interruptTurn(turnId: string | null): Promise<InterruptTurnResponse> {
  if (!currentThreadId) {
    throw new Error("No active thread.");
  }

  const response = await fetch(`/api/threads/${currentThreadId}/turns/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId }),
  });
  return parseJson<InterruptTurnResponse>(response);
}

async function submitDecision(requestId: string, decision: string): Promise<{ ok: true }> {
  if (!currentThreadId) {
    throw new Error("No active thread.");
  }

  const response = await fetch(`/api/threads/${currentThreadId}/approvals/${requestId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  return parseJson<{ ok: true }>(response);
}

export async function respondCommandApproval(
  requestId: string,
  decision: CommandApprovalDecision,
): Promise<{ ok: true }> {
  return submitDecision(requestId, decision);
}

export async function respondFileChangeApproval(
  requestId: string,
  decision: FileChangeApprovalDecision,
): Promise<{ ok: true }> {
  return submitDecision(requestId, decision);
}

export async function respondToolUserInput(
  requestId: string,
  _answers: Record<string, { answers: string[] }>,
): Promise<{ ok: true }> {
  return submitDecision(requestId, "approve");
}

export async function respondDynamicToolCall(
  requestId: string,
  success: boolean,
  _contentText: string,
): Promise<{ ok: true }> {
  return submitDecision(requestId, success ? "success" : "failure");
}

export async function respondChatgptAuthTokensRefresh(
  requestId: string,
  _accessToken: string,
  _chatgptAccountId: string,
  _chatgptPlanType: string | null,
): Promise<{ ok: true }> {
  return submitDecision(requestId, "approve");
}

export async function respondApplyPatchApproval(
  requestId: string,
  decision: ReviewApprovalDecision,
): Promise<{ ok: true }> {
  return submitDecision(requestId, decision);
}

export async function respondExecCommandApproval(
  requestId: string,
  decision: ReviewApprovalDecision,
): Promise<{ ok: true }> {
  return submitDecision(requestId, decision);
}

export function connectEventStream(
  onEvent: (event: BridgeEvent) => void,
  onError: (error: Event) => void,
): EventSource {
  onLegacyEvent = onEvent;
  onLegacyError = onError;
  openSourceForCurrentThread();

  return {
    close() {
      onLegacyEvent = null;
      onLegacyError = null;
      closeActiveSource();
    },
  } as EventSource;
}
