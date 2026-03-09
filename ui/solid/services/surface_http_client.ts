import type {
  ApprovalPolicy,
  CreateThreadResponse,
  ResumeThreadResponse,
  ForkThreadResponse,
  ReadThreadTokenUsageResponse,
  SetThreadModelRequest,
  SubmitSurfaceTurnRequest,
  SubmitSurfaceTurnResponse,
  SurfaceStateResponse,
  ThreadModelState,
  WorkspaceTarget,
} from "../../../shared/protocol/requests.js";

async function asJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function surfacePath(adapter: string, surfaceId: string): string {
  return `/api/surfaces/${encodePathSegment(adapter)}/${encodePathSegment(surfaceId)}`;
}

export async function getSurfaceState(adapter: string, surfaceId: string): Promise<SurfaceStateResponse> {
  return asJson<SurfaceStateResponse>(await fetch(surfacePath(adapter, surfaceId)));
}

export async function getSurfaceWorkspaceTarget(
  adapter: string,
  surfaceId: string,
): Promise<{ target: WorkspaceTarget | null }> {
  return asJson<{ target: WorkspaceTarget | null }>(
    await fetch(`${surfacePath(adapter, surfaceId)}/workspace-target`),
  );
}

export async function setSurfaceWorkspaceTarget(
  adapter: string,
  surfaceId: string,
  target: WorkspaceTarget,
): Promise<{ target: WorkspaceTarget }> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/workspace-target`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  return asJson<{ target: WorkspaceTarget }>(response);
}

export async function clearSurfaceWorkspaceTarget(
  adapter: string,
  surfaceId: string,
): Promise<{ ok: true }> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/workspace-target`, {
    method: "DELETE",
  });
  return asJson<{ ok: true }>(response);
}

export async function bindSurfaceThread(
  adapter: string,
  surfaceId: string,
  threadId: string,
): Promise<{ threadId: string }> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/thread`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId }),
  });
  return asJson<{ threadId: string }>(response);
}

export async function clearSurfaceThread(adapter: string, surfaceId: string): Promise<{ ok: true }> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/thread`, {
    method: "DELETE",
  });
  return asJson<{ ok: true }>(response);
}

export async function createSurfaceThread(
  adapter: string,
  surfaceId: string,
  payload: {
    approvalPolicy?: ApprovalPolicy;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  } = {},
): Promise<CreateThreadResponse> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson<CreateThreadResponse>(response);
}

export async function resumeSurfaceThread(
  adapter: string,
  surfaceId: string,
  threadId: string,
  payload: Record<string, unknown> = {},
): Promise<ResumeThreadResponse> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/threads/${encodePathSegment(threadId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson<ResumeThreadResponse>(response);
}

export async function forkSurfaceThread(
  adapter: string,
  surfaceId: string,
  threadId: string,
  payload: Record<string, unknown> = {},
): Promise<ForkThreadResponse> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/threads/${encodePathSegment(threadId)}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson<ForkThreadResponse>(response);
}

export async function submitSurfaceTurn(
  adapter: string,
  surfaceId: string,
  payload: SubmitSurfaceTurnRequest,
): Promise<SubmitSurfaceTurnResponse> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson<SubmitSurfaceTurnResponse>(response);
}

export async function getSurfaceContext(
  adapter: string,
  surfaceId: string,
): Promise<ReadThreadTokenUsageResponse> {
  return asJson<ReadThreadTokenUsageResponse>(await fetch(`${surfacePath(adapter, surfaceId)}/context`));
}

export async function interruptSurfaceTurn(
  adapter: string,
  surfaceId: string,
  turnId?: string,
): Promise<{ ok: true }> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId }),
  });
  return asJson<{ ok: true }>(response);
}

export async function getSurfaceModel(adapter: string, surfaceId: string): Promise<ThreadModelState> {
  return asJson<ThreadModelState>(await fetch(`${surfacePath(adapter, surfaceId)}/model`));
}

export async function setSurfaceModel(
  adapter: string,
  surfaceId: string,
  payload: SetThreadModelRequest,
): Promise<ThreadModelState> {
  const response = await fetch(`${surfacePath(adapter, surfaceId)}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return asJson<ThreadModelState>(response);
}

export function openSurfaceEvents(
  adapter: string,
  surfaceId: string,
  onEvent: (event: MessageEvent<string>) => void,
  onError: (event: Event) => void,
): EventSource {
  const source = new EventSource(`${surfacePath(adapter, surfaceId)}/events`);
  source.onmessage = onEvent;
  source.onerror = onError;
  return source;
}
