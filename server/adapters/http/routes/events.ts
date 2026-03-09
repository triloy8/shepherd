import type { ConversationService } from "../../../core/conversation_service.js";
import { respondError } from "./utils.js";

function createSseResponse(
  request: Request,
  subscribe: (
    listener: (event: import("../../../../shared/protocol/events.js").BridgeEvent) => void,
  ) => () => void,
): Response {
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    unsubscribe?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };

      keepAlive = setInterval(() => {
        write(`: keepalive ${Date.now()}\n\n`);
      }, 20_000);

      unsubscribe = subscribe((event) => {
        write(`id: ${event.id}\n`);
        write(`event: ${event.type}\n`);
        write(`data: ${JSON.stringify(event)}\n\n`);
      });

      request.signal.addEventListener(
        "abort",
        () => {
          close();
          try {
            controller.close();
          } catch {
            // Stream can already be closed/cancelled.
          }
        },
        { once: true },
      );
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

export function handleEventsSse(
  request: Request,
  conversation: ConversationService,
  threadId: string,
  lastEventId?: string,
): Response {
  try {
    conversation.getThreadState(threadId);
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "Thread not found.");
  }

  return createSseResponse(request, (listener) =>
    conversation.subscribeToThreadEvents(threadId, listener, lastEventId),
  );
}

export function handleSurfaceEventsSse(
  request: Request,
  conversation: ConversationService,
  adapter: string,
  surfaceId: string,
  lastEventId?: string,
): Response {
  return createSseResponse(request, (listener) =>
    conversation.subscribeSurfaceEvents(adapter, surfaceId, listener, lastEventId),
  );
}
