import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");

const MODEL = process.env.CODEX_MODEL ?? "gpt-5.3-codex";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

class CodexAppServerSession {
  constructor() {
    this.child = null;
    this.readline = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.isInitialized = false;
    this.initializePromise = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.eventSubscribers = new Set();
  }

  async start() {
    if (this.child) return;

    this.child = spawn("codex", ["app-server"], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.on("error", (error) => {
      this.broadcast({
        type: "error",
        message: `Failed to start codex app-server: ${error.message}`,
      });
    });

    this.child.on("exit", (code, signal) => {
      this.broadcast({
        type: "error",
        message: `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      });
      this.child = null;
      this.readline = null;
      this.pending.clear();
      this.serverRequests.clear();
      this.isInitialized = false;
      this.threadId = null;
      this.activeTurnId = null;
    });

    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      this.broadcast({
        type: "error",
        message: `app-server stderr: ${text}`,
      });
    });

    this.readline = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.readline.on("line", (line) => this.handleServerLine(line));
  }

  stop() {
    this.readline?.close();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  subscribe(response) {
    this.eventSubscribers.add(response);
    response.on("close", () => {
      this.eventSubscribers.delete(response);
    });
  }

  broadcast(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const response of this.eventSubscribers) {
      response.write(line);
    }
  }

  handleServerLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.broadcast({ type: "error", message: "Received invalid JSON line from app-server." });
      return;
    }

    if (this.isServerRequest(message)) {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.id === "number" || typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "App-server request failed."));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (typeof message.method === "string") {
      this.broadcast({
        type: "notification",
        method: message.method,
        params: message.params ?? null,
      });

      if (message.method === "turn/started") {
        const turnId = this.extractTurnId(message.params);
        this.activeTurnId = typeof turnId === "string" ? turnId : this.activeTurnId;
        this.broadcast({
          type: "turn_started",
          turnId: typeof turnId === "string" ? turnId : undefined,
        });
      }

      if (message.method === "turn/completed") {
        this.activeTurnId = null;
      }
      return;
    }
  }

  isServerRequest(message) {
    return (
      message &&
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    );
  }

  handleServerRequest(message) {
    const requestId = String(message.id);
    this.serverRequests.set(requestId, {
      id: message.id,
      method: message.method,
      params: message.params ?? {},
    });

    this.broadcast({
      type: "server_request",
      requestId,
      method: message.method,
      params: message.params ?? null,
    });
  }

  sendRequest(method, params = {}) {
    if (!this.child?.stdin) {
      return Promise.reject(new Error("codex app-server is not running."));
    }

    const id = this.nextRequestId++;
    const payload = { id, method, params };
    const line = `${JSON.stringify(payload)}\n`;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  sendNotification(method, params = {}) {
    if (!this.child?.stdin) {
      throw new Error("codex app-server is not running.");
    }

    const payload = { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  resolveServerRequest(requestId, expectedMethod, result) {
    if (!this.child?.stdin) {
      throw new Error("codex app-server is not running.");
    }

    const request = this.serverRequests.get(requestId);
    if (!request) {
      throw new Error(`Unknown server request id: ${requestId}`);
    }

    if (request.method !== expectedMethod) {
      throw new Error(`Request ${requestId} expects method ${request.method}, not ${expectedMethod}`);
    }

    const payload = { id: request.id, result };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    this.serverRequests.delete(requestId);
  }

  async ensureInitialized() {
    if (this.isInitialized) return;
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = (async () => {
      await this.start();
      await this.sendRequest("initialize", {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: {
          name: "agent-minimal-proto",
          version: "0.1.0",
        },
      });

      this.sendNotification("initialized", {});
      this.isInitialized = true;
      this.broadcast({ type: "ready" });
    })();

    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
    }
  }

  async startThread() {
    await this.ensureInitialized();
    const result = await this.sendRequest("thread/start", {
      model: MODEL,
    });

    const threadId = this.extractThreadId(result);
    if (typeof threadId !== "string" || !threadId) {
      const preview = JSON.stringify(result ?? {}).slice(0, 300);
      throw new Error(`thread/start returned an invalid threadId. result=${preview}`);
    }

    this.threadId = threadId;
    this.broadcast({ type: "thread_started", threadId });
    return threadId;
  }

  async ensureThread() {
    if (this.threadId) return this.threadId;
    return this.startThread();
  }

  async startTurn(inputText) {
    const threadId = await this.ensureThread();

    const result = await this.sendRequest("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: inputText,
        },
      ],
    });

    const turnId = this.extractTurnId(result);
    if (typeof turnId === "string") {
      this.activeTurnId = turnId;
      this.broadcast({ type: "turn_started", turnId });
    } else {
      this.broadcast({ type: "turn_started" });
    }

    return turnId;
  }

  async interruptTurn(turnId) {
    const activeTurnId = turnId ?? this.activeTurnId;
    if (!activeTurnId) {
      throw new Error("No active turn to interrupt.");
    }
    if (!this.threadId) {
      throw new Error("No active thread for turn interrupt.");
    }
    await this.sendRequest("turn/interrupt", {
      threadId: this.threadId,
      turnId: activeTurnId,
    });
  }

  extractThreadId(result) {
    if (typeof result?.threadId === "string") return result.threadId;
    if (typeof result?.thread_id === "string") return result.thread_id;
    if (typeof result?.id === "string") return result.id;
    if (typeof result?.thread === "string") return result.thread;
    if (result?.thread && typeof result.thread.id === "string") return result.thread.id;
    if (result?.thread && typeof result.thread.threadId === "string") return result.thread.threadId;
    if (result?.thread && typeof result.thread.thread_id === "string") return result.thread.thread_id;
    return null;
  }

  extractTurnId(result) {
    if (typeof result?.turnId === "string") return result.turnId;
    if (typeof result?.turn_id === "string") return result.turn_id;
    if (typeof result?.id === "string") return result.id;
    if (typeof result?.turn === "string") return result.turn;
    if (result?.turn && typeof result.turn.id === "string") return result.turn.id;
    if (result?.turn && typeof result.turn.turnId === "string") return result.turn.turnId;
    if (result?.turn && typeof result.turn.turn_id === "string") return result.turn.turn_id;
    return undefined;
  }
}

const session = new CodexAppServerSession();

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function parseJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function safePathFromUrl(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const normalized = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const absolutePath = path.join(rootDir, normalized);
  if (!absolutePath.startsWith(rootDir)) return null;
  return absolutePath;
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";

  const filePath = safePathFromUrl(pathname);
  if (!filePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] ?? "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write("\n");
    session.subscribe(response);

    try {
      await session.ensureInitialized();
    } catch (error) {
      session.broadcast({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to initialize session.",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/threads") {
    try {
      const threadId = await session.startThread();
      respondJson(response, 200, { threadId });
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : "Failed to start thread.",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/turns") {
    try {
      const body = await parseJsonBody(request);
      const input = typeof body.input === "string" ? body.input.trim() : "";
      if (!input) {
        respondJson(response, 400, { error: "Missing input." });
        return;
      }

      const turnId = await session.startTurn(input);
      respondJson(response, 200, { ok: true, turnId });
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : "Failed to start turn.",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/turns/interrupt") {
    try {
      const body = await parseJsonBody(request);
      const turnId = typeof body.turnId === "string" ? body.turnId : null;
      await session.interruptTurn(turnId);
      respondJson(response, 200, { ok: true });
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : "Failed to interrupt turn.",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/approvals/command") {
    try {
      const body = await parseJsonBody(request);
      const requestId = typeof body.requestId === "string" ? body.requestId : null;
      const decision = typeof body.decision === "string" ? body.decision : null;
      const allowed = new Set(["accept", "acceptForSession", "decline", "cancel"]);

      if (!requestId || !decision || !allowed.has(decision)) {
        respondJson(response, 400, { error: "Invalid command approval payload." });
        return;
      }

      session.resolveServerRequest(requestId, "item/commandExecution/requestApproval", {
        decision,
      });
      respondJson(response, 200, { ok: true });
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : "Failed to submit command approval.",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/approvals/file-change") {
    try {
      const body = await parseJsonBody(request);
      const requestId = typeof body.requestId === "string" ? body.requestId : null;
      const decision = typeof body.decision === "string" ? body.decision : null;
      const allowed = new Set(["accept", "acceptForSession", "decline", "cancel"]);

      if (!requestId || !decision || !allowed.has(decision)) {
        respondJson(response, 400, { error: "Invalid file change approval payload." });
        return;
      }

      session.resolveServerRequest(requestId, "item/fileChange/requestApproval", {
        decision,
      });
      respondJson(response, 200, { ok: true });
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : "Failed to submit file change approval.",
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tool-user-input") {
    try {
      const body = await parseJsonBody(request);
      const requestId = typeof body.requestId === "string" ? body.requestId : null;
      const answers = body.answers && typeof body.answers === "object" ? body.answers : null;

      if (!requestId || !answers) {
        respondJson(response, 400, { error: "Invalid tool user input payload." });
        return;
      }

      session.resolveServerRequest(requestId, "item/tool/requestUserInput", {
        answers,
      });
      respondJson(response, 200, { ok: true });
    } catch (error) {
      respondJson(response, 500, {
        error: error instanceof Error ? error.message : "Failed to submit tool user input.",
      });
    }
    return;
  }

  await serveStatic(request, response);
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`agent bridge listening at http://${host}:${port}`);
});

process.on("SIGINT", () => {
  session.stop();
  server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  session.stop();
  server.close(() => process.exit(0));
});
