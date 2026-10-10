/** Explicit live recorder. Not run by bun test; always uses a temporary fixture repo. */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeAuthenticationOptions } from "../server/providers/claude/authentication.js";
import { claudeExecutablePath } from "../server/providers/claude/claude_executable.js";

const args = process.argv.slice(2);
const provider = args[args.indexOf("--provider") + 1];
const output = args[args.indexOf("--out") + 1];
if (!args.includes("--provider") || !args.includes("--out") || !["codex", "claude"].includes(provider ?? "") || !output) {
  throw new Error("Usage: bun scripts/record-provider-neutral.ts --provider codex|claude --out /path/to/new-fixture.json");
}
const workspace = await mkdtemp(join(tmpdir(), "shepherd-native-fixture-"));
const prompt = "Read fixture.txt using a tool, then reply with a single sentence summarizing its contents.";
const privateKeys = new Set(["authorization", "apikey", "accesstoken", "refreshtoken", "credential", "credentials", "accountid", "userid", "email", "env", "plantype"]);
function sanitize(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll(workspace, "<fixture-workspace>").replaceAll(workspace.replaceAll("/", "-"), "<fixture-project>").replaceAll(homedir(), "<fixture-home>").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    privateKeys.has(key.toLowerCase().replaceAll("_", "")) ? "<redacted>" : sanitize(item)]));
  return value;
}
try {
  await cp(resolve("tests/fixtures/workspace"), workspace, { recursive: true });
  execFileSync("git", ["init", "--quiet", workspace]);
  let fixture: unknown;
  if (provider === "claude") {
    const messages: unknown[] = [];
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 180_000);
    const running = query({ prompt, options: { cwd: workspace, model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
      tools: ["Read"], settingSources: [], includePartialMessages: true, maxTurns: 3, maxBudgetUsd: 1,
      abortController, permissionMode: "default", canUseTool: async (tool, input) => tool === "Read" && resolve(workspace, String(input.file_path)) === join(workspace, "fixture.txt")
        ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Fixture recorder only permits reading fixture.txt." },
      ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}), ...claudeAuthenticationOptions() } });
    try { for await (const message of running) messages.push(message); }
    finally { clearTimeout(timer); running.close(); }
    const sdk = JSON.parse(await readFile(resolve("node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"));
    fixture = { evidence: "recorded", versions: { sdk: sdk.version }, scenario: "read synthetic fixture and reply", messages };
  } else {
    const child = spawn("codex", ["app-server"], { cwd: workspace, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    const requests: unknown[] = [], notifications: unknown[] = [];
    let id = 0, ended!: () => void, failed!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { ended = resolve; failed = reject; });
    // Native completion can precede the turn/start response.
    void completed.catch(() => {});
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const send = (method: string, params?: unknown) => {
      const message = { id: ++id, method, ...(params === undefined ? {} : { params }) };
      requests.push(message);
      const result = new Promise<any>((resolve, reject) => pending.set(message.id, { resolve, reject }));
      child.stdin.write(JSON.stringify(message) + "\n");
      return result;
    };
    const abort = () => { const error = new Error("Native fixture recording stopped before completion."); failed(error); for (const request of pending.values()) request.reject(error); pending.clear(); };
    const timer = setTimeout(() => { abort(); child.kill(); }, 180_000);
    child.on("error", abort); child.on("exit", abort);
    lines.on("line", line => {
      let value: any;
      try { value = JSON.parse(line); } catch { abort(); return; }
      if (value.method && value.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: "Unsupported fixture callback." } }) + "\n");
      } else if (value.method) {
        notifications.push(value);
        if (value.method === "turn/completed") ended();
      } else if (typeof value.id === "number") {
        const request = pending.get(value.id); pending.delete(value.id);
        if (value.error) request?.reject(new Error("Native fixture RPC failed.")); else request?.resolve(value.result);
      }
    });
    try {
      const initialize = await send("initialize", { clientInfo: { name: "shepherd-fixture-recorder", title: null, version: "1" }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
      const created = await send("thread/start", { cwd: workspace, sandbox: "read-only", approvalPolicy: "never", ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}) });
      const threadId = created.thread.id;
      await send("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], approvalPolicy: "never" });
      await completed;
      const history = await send("thread/items/list", { threadId, limit: 100, sortDirection: "asc" });
      const turns = await send("thread/turns/list", { threadId, limit: 100, itemsView: "notLoaded" });
      fixture = { evidence: "recorded", versions: { cli: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim() },
        scenario: "read synthetic fixture and reply", initialize, requests, notifications, history, turns };
    } finally { clearTimeout(timer); lines.close(); child.kill(); }
  }
  await writeFile(resolve(output), JSON.stringify(sanitize(fixture), null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(`Recorded ${provider} fixture at ${resolve(output)}. Review it before committing.\n`);
} finally { await rm(workspace, { recursive: true, force: true }); }
