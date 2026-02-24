import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionManager } from "../../core/session_manager.js";
import { handleApprovalDecision, handleListApprovals } from "./routes/approvals.js";
import { handleEventsSse } from "./routes/events.js";
import { isAuthorized } from "./routes/auth.js";
import { handleCreateThread, handleGetThread, handleListThreads } from "./routes/threads.js";
import { handleToolsNotImplemented } from "./routes/tools.js";
import { handleInterruptTurn, handleSubmitTurn } from "./routes/turns.js";
import { notFound, respondError } from "./routes/utils.js";
import { serveStaticUi } from "./static_ui.js";

export function startHttpServer(manager: SessionManager, host: string, port: number): http.Server {
  const server = http.createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const hostHeader = request.headers.host ?? `${host}:${port}`;
    const url = new URL(request.url ?? "/", `http://${hostHeader}`);

    if (!isAuthorized(request)) {
      respondError(response, 401, "Unauthorized");
      return;
    }

    if (method === "POST" && url.pathname === "/api/threads") {
      await handleCreateThread(request, response, manager);
      return;
    }

    if (method === "GET" && url.pathname === "/api/threads") {
      handleListThreads(response, manager);
      return;
    }

    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (method === "GET" && threadMatch) {
      handleGetThread(response, manager, threadMatch[1]);
      return;
    }

    const threadTurnsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
    if (method === "POST" && threadTurnsMatch) {
      await handleSubmitTurn(request, response, manager, threadTurnsMatch[1]);
      return;
    }

    const interruptMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns\/interrupt$/);
    if (method === "POST" && interruptMatch) {
      await handleInterruptTurn(request, response, manager, interruptMatch[1]);
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/events$/);
    if (method === "GET" && eventsMatch) {
      handleEventsSse(response, manager, eventsMatch[1], request.headers["last-event-id"] as string | undefined);
      return;
    }

    const approvalsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/approvals$/);
    if (method === "GET" && approvalsMatch) {
      handleListApprovals(response, manager, approvalsMatch[1]);
      return;
    }

    const approvalDecisionMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/approvals\/([^/]+)\/decision$/);
    if (method === "POST" && approvalDecisionMatch) {
      await handleApprovalDecision(request, response, manager, approvalDecisionMatch[1], approvalDecisionMatch[2]);
      return;
    }

    if (url.pathname.startsWith("/api/tools")) {
      handleToolsNotImplemented(response);
      return;
    }

    if (await serveStaticUi(request, response)) {
      return;
    }

    notFound(response);
  });

  server.listen(port, host);
  return server;
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const { SessionManager } = await import("../../core/session_manager.js");
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "8787");
  const manager = new SessionManager();
  const server = startHttpServer(manager, host, port);

  process.on("SIGINT", () => {
    manager.stopAll();
    server.close(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    manager.stopAll();
    server.close(() => process.exit(0));
  });

  console.log(`codex bridge listening at http://${host}:${port}`);
}
