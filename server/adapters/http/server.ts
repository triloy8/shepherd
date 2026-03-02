import type { SessionManager } from "../../core/session_manager.js";
import { handleApprovalDecision, handleListApprovals } from "./routes/approvals.js";
import { handleGetAccountRateLimits } from "./routes/account.js";
import { handleEventsSse } from "./routes/events.js";
import { isAuthorized } from "./routes/auth.js";
import {
  handleExportRemoteSkill,
  handleListRemoteSkills,
  handleListSkills,
  handleWriteSkillConfig,
} from "./routes/skills.js";
import {
  handleArchiveThread,
  handleCompactThread,
  handleCreateThread,
  handleForkThread,
  handleGetThreadContext,
  handleGetThread,
  handleListLoadedThreads,
  handleListStoredThreads,
  handleReadThread,
  handleResumeThread,
  handleRollbackThread,
  handleSetThreadName,
  handleUnarchiveThread,
} from "./routes/threads.js";
import { handleToolsNotImplemented } from "./routes/tools.js";
import { handleInterruptTurn, handleSubmitTurn } from "./routes/turns.js";
import { notFound, respondError } from "./routes/utils.js";
import { serveStaticUi } from "./static_ui.js";

type BunRuntime = {
  serve(options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
    error?: (error: Error) => Response;
  }): {
    hostname: string;
    port: number;
    stop(closeActiveConnections?: boolean): void;
  };
};

export type BridgeServer = {
  hostname: string;
  port: number;
  stop(): void;
};

export function startHttpServer(manager: SessionManager, host: string, port: number): BridgeServer {
  const runtime = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!runtime) {
    throw new Error("Bun runtime is required. Start this server with Bun.");
  }

  const server = runtime.serve({
    hostname: host,
    port,
    error(error) {
      return respondError(500, error.message || "Internal server error.");
    },
    fetch: async (request) => {
      const method = request.method;
      const url = new URL(request.url);

      if (!isAuthorized(request)) {
        return respondError(401, "Unauthorized");
      }

      if (method === "POST" && url.pathname === "/api/threads") {
        return handleCreateThread(request, manager);
      }

      if (method === "GET" && url.pathname === "/api/account/rate-limits") {
        return handleGetAccountRateLimits(manager);
      }

      if (method === "GET" && url.pathname === "/api/skills") {
        return handleListSkills(request, manager);
      }

      if (method === "GET" && url.pathname === "/api/skills/remote") {
        return handleListRemoteSkills(request, manager);
      }

      if (method === "POST" && url.pathname === "/api/skills/remote/export") {
        return handleExportRemoteSkill(request, manager);
      }

      if (method === "POST" && url.pathname === "/api/skills/config") {
        return handleWriteSkillConfig(request, manager);
      }

      if (method === "GET" && url.pathname === "/api/threads") {
        return handleListStoredThreads(request, manager);
      }

      if (method === "GET" && url.pathname === "/api/threads/loaded") {
        return handleListLoadedThreads(request, manager);
      }

      const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (method === "GET" && threadMatch) {
        return handleGetThread(manager, threadMatch[1]);
      }

      const threadReadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/read$/);
      if (method === "GET" && threadReadMatch) {
        return handleReadThread(request, manager, threadReadMatch[1]);
      }

      const threadContextMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/context$/);
      if (method === "GET" && threadContextMatch) {
        return handleGetThreadContext(manager, threadContextMatch[1]);
      }

      const threadResumeMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/resume$/);
      if (method === "POST" && threadResumeMatch) {
        return handleResumeThread(request, manager, threadResumeMatch[1]);
      }

      const threadForkMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/fork$/);
      if (method === "POST" && threadForkMatch) {
        return handleForkThread(request, manager, threadForkMatch[1]);
      }

      const threadNameMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/name$/);
      if (method === "POST" && threadNameMatch) {
        return handleSetThreadName(request, manager, threadNameMatch[1]);
      }

      const threadArchiveMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/archive$/);
      if (method === "POST" && threadArchiveMatch) {
        return handleArchiveThread(manager, threadArchiveMatch[1]);
      }

      const threadUnarchiveMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/unarchive$/);
      if (method === "POST" && threadUnarchiveMatch) {
        return handleUnarchiveThread(manager, threadUnarchiveMatch[1]);
      }

      const threadCompactMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/compact$/);
      if (method === "POST" && threadCompactMatch) {
        return handleCompactThread(manager, threadCompactMatch[1]);
      }

      const threadRollbackMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/rollback$/);
      if (method === "POST" && threadRollbackMatch) {
        return handleRollbackThread(request, manager, threadRollbackMatch[1]);
      }

      const threadTurnsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
      if (method === "POST" && threadTurnsMatch) {
        return handleSubmitTurn(request, manager, threadTurnsMatch[1]);
      }

      const interruptMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns\/interrupt$/);
      if (method === "POST" && interruptMatch) {
        return handleInterruptTurn(request, manager, interruptMatch[1]);
      }

      const eventsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/events$/);
      if (method === "GET" && eventsMatch) {
        return handleEventsSse(request, manager, eventsMatch[1], request.headers.get("last-event-id") ?? undefined);
      }

      const approvalsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/approvals$/);
      if (method === "GET" && approvalsMatch) {
        return handleListApprovals(manager, approvalsMatch[1]);
      }

      const approvalDecisionMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/approvals\/([^/]+)\/decision$/);
      if (method === "POST" && approvalDecisionMatch) {
        return handleApprovalDecision(request, manager, approvalDecisionMatch[1], approvalDecisionMatch[2]);
      }

      if (url.pathname.startsWith("/api/tools")) {
        return handleToolsNotImplemented();
      }

      const staticResponse = await serveStaticUi(request);
      if (staticResponse) {
        return staticResponse;
      }

      return notFound();
    },
  });

  return {
    hostname: server.hostname,
    port: server.port,
    stop() {
      server.stop(true);
    },
  };
}
