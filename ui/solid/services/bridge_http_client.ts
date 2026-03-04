import type { ApprovalRecord } from "../../../shared/protocol/approvals.js";
import type {
  ApprovalDecisionApiRequest,
  ApprovalPolicy,
  CreateThreadResponse,
  GetThreadStateResponse,
  ListThreadsResponse,
  SteerTurnResponse,
  SubmitTurnResponse,
} from "../../../shared/protocol/requests.js";

async function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function createThread(approvalPolicy: ApprovalPolicy, cwd: string): Promise<CreateThreadResponse> {
  const response = await fetch("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvalPolicy, cwd }),
  });
  return asJson<CreateThreadResponse>(response);
}

export async function listThreads(): Promise<ListThreadsResponse> {
  return asJson<ListThreadsResponse>(await fetch("/api/threads"));
}

export async function getThread(threadId: string): Promise<GetThreadStateResponse> {
  return asJson<GetThreadStateResponse>(await fetch(`/api/threads/${threadId}`));
}

export async function submitTurn(
  threadId: string,
  input: string,
  approvalPolicy: ApprovalPolicy,
): Promise<SubmitTurnResponse> {
  const response = await fetch(`/api/threads/${threadId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, approvalPolicy }),
  });
  return asJson<SubmitTurnResponse>(response);
}

export async function interruptTurn(threadId: string, turnId?: string): Promise<{ ok: true }> {
  const response = await fetch(`/api/threads/${threadId}/turns/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId }),
  });
  return asJson<{ ok: true }>(response);
}

export async function steerTurn(threadId: string, input: string, turnId?: string): Promise<SteerTurnResponse> {
  const response = await fetch(`/api/threads/${threadId}/turns/steer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, turnId }),
  });
  return asJson<SteerTurnResponse>(response);
}

export async function listApprovals(threadId: string): Promise<{ approvals: ApprovalRecord[] }> {
  return asJson<{ approvals: ApprovalRecord[] }>(await fetch(`/api/threads/${threadId}/approvals`));
}

export async function decideApproval(
  threadId: string,
  approvalId: string,
  payload: ApprovalDecisionApiRequest,
): Promise<{ ok: true }> {
  const response = await fetch(`/api/threads/${threadId}/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson<{ ok: true }>(response);
}

export function openThreadEvents(
  threadId: string,
  onEvent: (event: MessageEvent<string>) => void,
  onError: (event: Event) => void,
): EventSource {
  const source = new EventSource(`/api/threads/${threadId}/events`);
  source.onmessage = onEvent;
  source.onerror = onError;
  return source;
}
