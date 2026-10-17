
export interface ServerRequestContext {
  requestId: string;
  method: string;
  params: unknown;
}

export interface SessionState {
  sessionId: string;
  threadId: string;
  activeTurnId: string | null;
  createdAt: string;
}
