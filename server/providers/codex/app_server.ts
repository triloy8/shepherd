import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export type RawServerRequest = { id: string | number; method: string; params: unknown };

/** What a connection receives from the process: its threads' notifications and requests, and
 * notifications that name no thread. */
export interface AppServerClient {
  onNotification(method: string, params: unknown): void;
  onServerRequest(request: RawServerRequest): void;
  /** The process ended. The connection is closed and every thread it loaded is gone with it. */
  onClosed(message: string): void;
}

export interface AppServerConnection {
  readonly closed: boolean;
  request(method: string, params: unknown): Promise<unknown>;
  /** Writes a reply to a server request, or any other line, to the process. */
  write(payload: unknown): void;
  /** Routes the thread's notifications and requests to this connection. */
  bind(threadId: string): void;
  unbind(threadId: string): void;
  /** Stops the thread's notifications if this connection still runs it. Codex subscribes the
   * process's one client, so a session that resumed the thread since keeps it subscribed. */
  releaseThread(threadId: string): void;
  close(): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const threadOf = (params: unknown) => {
  const record = asRecord(params);
  const id = record.threadId ?? record.conversationId;
  return typeof id === "string" ? id : null;
};

/** One running `codex app-server`. Codex serves many threads from one process and names the
 * thread in each notification and request, so connections share it and receive their own. */
class AppServerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private readonly pending = new Map<number, Pending>();
  private readonly connections = new Set<Connection>();
  private readonly threads = new Map<string, Connection>();
  private nextId = 1;
  ended = false;
  readonly ready: Promise<void>;

  constructor(spawnProcess: () => ChildProcessWithoutNullStreams, private readonly onEnded: (process: AppServerProcess) => void) {
    this.child = spawnProcess();
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => this.onLine(line));
    this.child.on("error", error => this.end(`Failed to spawn codex app-server: ${error.message}`));
    this.child.on("exit", (code, signal) => this.end(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) console.error(`codex app-server stderr: ${text}`);
    });
    this.ready = (async () => {
      await this.request("initialize", { capabilities: { experimentalApi: true }, clientInfo: { name: "shepherd", title: "Shepherd", version: "1.0.0" } });
      this.write({ method: "initialized" });
    })();
  }

  connect(client: AppServerClient): Connection {
    const connection = new Connection(this, client);
    this.connections.add(connection);
    return connection;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error("codex app-server is not running."));
    const id = this.nextId++;
    const reply = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return reply;
  }

  write(payload: unknown): void {
    if (this.ended) throw new Error("codex app-server is not running.");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  bind(threadId: string, connection: Connection): void { this.threads.set(threadId, connection); }
  unbind(threadId: string, connection: Connection): boolean {
    if (this.threads.get(threadId) !== connection) return false;
    this.threads.delete(threadId);
    return true;
  }
  release(connection: Connection): void {
    this.connections.delete(connection);
    for (const [threadId, owner] of this.threads) if (owner === connection) this.threads.delete(threadId);
  }

  stop(): void {
    if (!this.child.killed) this.child.kill("SIGTERM");
    this.end("codex app-server stopped.");
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try { message = asRecord(JSON.parse(trimmed)); } catch { console.error("codex app-server sent invalid JSON."); return; }
    const { id, method } = message;
    if ((typeof id === "number" || typeof id === "string") && typeof method === "string") {
      const request = { id, method, params: message.params ?? {} };
      const owner = this.owner(request.params);
      if (owner) owner.client.onServerRequest(request);
      else this.write({ id, error: { code: -32602, message: `No conversation in Shepherd handles ${method} for this thread.` } });
      return;
    }
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) pending.reject(new Error((asRecord(message.error).message as string) ?? "App-server request failed."));
      else pending.resolve(message.result);
      return;
    }
    if (typeof method !== "string") return;
    const params = message.params ?? {};
    // A thread's notifications go to the connection running it; notifications that name no
    // thread concern every connection. Threads only being read have no connection.
    if (threadOf(params)) this.owner(params)?.client.onNotification(method, params);
    else for (const connection of this.connections) connection.client.onNotification(method, params);
  }

  private owner(params: unknown): Connection | undefined {
    const threadId = threadOf(params);
    return threadId ? this.threads.get(threadId) : undefined;
  }

  private end(message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.lines.close();
    for (const pending of this.pending.values()) pending.reject(new Error("Session terminated."));
    this.pending.clear();
    const connections = [...this.connections];
    this.connections.clear(); this.threads.clear();
    this.onEnded(this);
    for (const connection of connections) connection.end(message);
  }
}

class Connection implements AppServerConnection {
  closed = false;
  constructor(private readonly process: AppServerProcess, readonly client: AppServerClient) {}
  request(method: string, params: unknown): Promise<unknown> {
    return this.closed ? Promise.reject(new Error("codex app-server is not running.")) : this.process.request(method, params);
  }
  write(payload: unknown): void {
    if (this.closed) throw new Error("codex app-server is not running.");
    this.process.write(payload);
  }
  bind(threadId: string): void { if (!this.closed) this.process.bind(threadId, this); }
  unbind(threadId: string): void { this.process.unbind(threadId, this); }
  releaseThread(threadId: string): void {
    if (this.closed || !this.process.unbind(threadId, this)) return;
    void this.process.request("thread/unsubscribe", { threadId }).catch(() => {});
  }
  close(): void { if (!this.closed) { this.closed = true; this.process.release(this); } }
  end(message: string): void { this.closed = true; this.client.onClosed(message); }
}

/** The app-server command line. `agents.enabled=false` is the only setting that removes the
 * subagent tools from models that declare their own multi-agent version, and it applies to every
 * thread the process starts, resumes or forks. An enabled `features.multi_agent_v2` would take
 * precedence over it, so it is pinned off too. */
export function codexAppServerArgs(environment: Record<string, string | undefined> = process.env): string[] {
  const value = environment.CODEX_SUBAGENTS?.trim() || "enabled";
  if (value !== "enabled" && value !== "disabled") throw new Error("CODEX_SUBAGENTS must be enabled or disabled.");
  return value === "enabled" ? ["app-server"] : ["-c", "agents.enabled=false", "-c", "features.multi_agent_v2=false", "app-server"];
}

/** The Codex app-server every Codex thread, history read and account request shares. It starts
 * on first use and again on the next use after it exits; threads loaded in an ended process must
 * be resumed in the new one. */
export class CodexAppServer {
  private current: AppServerProcess | null = null;
  private stopped = false;
  constructor(private readonly spawnProcess: () => ChildProcessWithoutNullStreams = () => spawn("codex", codexAppServerArgs(), { stdio: ["pipe", "pipe", "pipe"], env: process.env })) {}

  async connect(client: AppServerClient): Promise<AppServerConnection> {
    if (this.stopped) throw new Error("Codex app-server is stopped.");
    const server = this.current ??= new AppServerProcess(this.spawnProcess, ended => { if (this.current === ended) this.current = null; });
    try { await server.ready; } catch (error) {
      if (this.current === server) { this.current = null; server.stop(); }
      throw error;
    }
    if (server.ended) throw new Error("codex app-server is not running.");
    return server.connect(client);
  }

  stop(): void {
    this.stopped = true;
    const process = this.current; this.current = null;
    process?.stop();
  }
}
