import type {
  BridgeEvent,
  InterruptTurnResponse,
  StartThreadResponse,
  StartTurnResponse,
} from "../core/types.js";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function startThread(): Promise<StartThreadResponse> {
  const response = await fetch("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  return parseJson<StartThreadResponse>(response);
}

export async function startTurn(input: string): Promise<StartTurnResponse> {
  const response = await fetch("/api/turns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return parseJson<StartTurnResponse>(response);
}

export async function interruptTurn(turnId: string | null): Promise<InterruptTurnResponse> {
  const response = await fetch("/api/turns/interrupt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnId }),
  });
  return parseJson<InterruptTurnResponse>(response);
}

export function connectEventStream(
  onEvent: (event: BridgeEvent) => void,
  onError: (error: Event) => void,
): EventSource {
  const source = new EventSource("/api/events");
  source.onmessage = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as BridgeEvent;
      onEvent(payload);
    } catch (error) {
      onEvent({
        type: "error",
        message: error instanceof Error ? error.message : "Invalid event payload.",
      });
    }
  };
  source.onerror = onError;
  return source;
}
