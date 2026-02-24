import type { ServerResponse } from "node:http";

import type { SessionManager } from "../../../core/session_manager.js";

export function handleEventsSse(
  response: ServerResponse,
  manager: SessionManager,
  threadId: string,
  lastEventId?: string,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  const keepAlive = setInterval(() => {
    response.write(`: keepalive ${Date.now()}\n\n`);
  }, 20_000);

  const unsubscribe = manager.subscribeToThreadEvents(
    threadId,
    (event) => {
      response.write(`id: ${event.id}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    lastEventId,
  );

  response.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}
