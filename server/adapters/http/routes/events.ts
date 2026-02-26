import type { SessionManager } from "../../../core/session_manager.js";
import { respondError } from "./utils.js";

export function handleEventsSse(
  request: Request,
  manager: SessionManager,
  threadId: string,
  lastEventId?: string,
): Response {
  try {
    manager.getThreadState(threadId);
  } catch (error) {
    return respondError(404, error instanceof Error ? error.message : "Thread not found.");
  }

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

      unsubscribe = manager.subscribeToThreadEvents(
        threadId,
        (event) => {
          write(`id: ${event.id}\n`);
          write(`event: ${event.type}\n`);
          write(`data: ${JSON.stringify(event)}\n\n`);
        },
        lastEventId,
      );

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
