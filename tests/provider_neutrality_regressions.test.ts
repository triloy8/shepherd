import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../server/core/session_manager.js";
import { executeControlAction } from "../server/core/control_actions_service.js";
import { listProviderThreads } from "../server/core/provider_thread_catalog.js";
import { memoryProviderDirectory } from "../server/core/provider_directory.js";
import { IndependentSession } from "./helpers/independent_provider.js";
import { codexTokenUsage } from "../server/providers/codex/token_usage.js";
import { validateSubmitTurnRequest } from "../shared/protocol/validation.js";
import type { ModelSummary } from "../shared/protocol/requests.js";

const row: ModelSummary = { id: "third-model", displayName: "Third", description: "", hidden: false, isDefault: true, inputModalities: ["text"], defaultEffort: "focused", supportedEfforts: [{ value: "focused", description: "" }, { value: "default", description: "" }, { value: "Focused", description: "" }] };
function harness() {
  const session = new IndependentSession();
  session.listModels = async () => ({ data: [row, { ...row, id: "simple", isDefault: false, defaultEffort: null, supportedEfforts: [] }], nextCursor: null });
  const calls: Array<string | null | undefined> = [];
  Object.assign(session, { startTurn: async (...args: Parameters<import("../server/ports/provider_session.js").ProviderSession["startTurn"]>) => { calls.push(args[4]); return "turn"; } });
  const manager = new SessionManager(undefined, () => session);
  return { manager, session, calls };
}

test("opaque effort values, model default and clear are distinct", async () => {
  const h = harness();
  try {
    const { threadId } = await h.manager.createThread({});
    for (const value of ["default", "Focused"]) {
      expect((await h.manager.setThreadEffort(threadId, value)).pendingEffort).toBe(value);
      await h.manager.submitTurn(threadId, { input: [] });
      expect(h.calls.at(-1)).toBe(value);
    }
    expect((await h.manager.setThreadEffort(threadId, { mode: "default" })).pendingEffort).toBe("focused");
    expect(await h.manager.setThreadEffort(threadId, null)).toMatchObject({ pendingEffort: null, pendingEffortClear: true });
    await h.manager.submitTurn(threadId, { input: [] });
    expect(h.calls.at(-1)).toBeNull();
    expect(await h.manager.getThreadEffort(threadId)).toMatchObject({ currentEffort: null, pendingEffortClear: false });
    await h.manager.submitTurn(threadId, { input: [] });
    expect(h.calls.at(-1)).toBeUndefined();
  } finally { h.manager.stopAll(); }
});

test("a pending effort can be cleared on a model without effort controls, including after a failed start", async () => {
  const h = harness();
  try {
    const { threadId } = await h.manager.createThread({});
    await h.manager.setThreadEffort(threadId, "focused");
    h.manager.setThreadModel(threadId, "simple");
    await expect(h.manager.submitTurn(threadId, { input: [] })).rejects.toMatchObject({ failure: { code: "unsupported_effort" } });
    await h.manager.setThreadEffort(threadId, null);
    const start = h.session.startTurn;
    h.session.startTurn = async () => { throw new Error("transport failed"); };
    await expect(h.manager.submitTurn(threadId, { input: [] })).rejects.toThrow("transport failed");
    expect((await h.manager.getThreadEffort(threadId)).pendingEffortClear).toBe(true);
    h.session.startTurn = start;
    await h.manager.submitTurn(threadId, { input: [] });
    expect(h.calls).toEqual([null]);
    expect(h.manager.getThreadModel(threadId)).toMatchObject({ currentModel: "simple", pendingModel: null });
  } finally { h.manager.stopAll(); }
});

test("settings queued while a turn starts survive completion of the older selection", async () => {
  const h = harness(); let release!: () => void;
  h.session.startTurn = async () => { await new Promise<void>(resolve => { release = resolve; }); return "turn"; };
  try {
    const { threadId } = await h.manager.createThread({});
    h.manager.setThreadModel(threadId, "simple");
    await h.manager.setThreadEffort(threadId, null);
    const starting = h.manager.submitTurn(threadId, { input: [] });
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    h.manager.setThreadModel(threadId, row.id);
    await h.manager.setThreadEffort(threadId, "Focused");
    release(); await starting;
    expect(h.manager.getThreadModel(threadId)).toMatchObject({ currentModel: "simple", pendingModel: row.id });
    expect(await h.manager.getThreadEffort(threadId)).toMatchObject({ currentEffort: null, pendingEffort: "Focused", pendingEffortClear: false });
  } finally { h.manager.stopAll(); }
});

test("model selection preserves case-sensitive catalog IDs", async () => {
  let selected = "";
  const context = { getSurfaceThreadId: () => "thread", conversation: {
    getThreadProvider: () => "independent",
    listModels: async () => ({ data: [{ ...row, id: "ModelA" }, { ...row, id: "modela" }], nextCursor: null }),
    setThreadModel: (_thread: string, model: string) => { selected = model; return { threadId: "thread", provider: "independent", currentModel: null, pendingModel: model }; },
  } };
  expect(await executeControlAction(context as never, { type: "model.set", surfaceId: "surface", requestedModel: "modela" })).toMatchObject({ ok: true, model: "modela" });
  expect(selected).toBe("modela");
  expect(await executeControlAction(context as never, { type: "model.set", surfaceId: "surface", requestedModel: "MODELA" })).toMatchObject({ ok: false, error: { code: "unknown_model" } });
});

test("catalogs skip empty providers, preserve failure notices across pages and retry on reload", async () => {
  const calls: string[] = []; let failing = true;
  const sources = {
    providers: ["empty", "offline", "healthy"], directory: memoryProviderDirectory(),
    hasStoredThreads: (provider: string) => provider !== "empty",
    canUnarchive: (provider: string) => provider === "healthy",
    listPage: async (provider: string, request: { cursor?: string }) => {
      calls.push(provider);
      if (provider === "offline") { if (failing) throw new Error("offline"); return { data: [], nextCursor: null }; }
      return { data: [{ id: request.cursor ?? "first", updatedAt: request.cursor ? 1 : 2 }], nextCursor: request.cursor ? null : "second" };
    },
  };
  const first = await listProviderThreads(sources, { limit: 1 });
  expect(first).toMatchObject({ unavailableProviders: ["offline"], threads: [{ provider: "healthy", canUnarchive: true }] });
  const second = await listProviderThreads(sources, { limit: 1, cursor: first.nextCursor! });
  expect(second).toMatchObject({ unavailableProviders: ["offline"], threads: [{ threadId: "second" }] });
  expect(calls).not.toContain("empty");
  expect(calls.filter(provider => provider === "offline")).toHaveLength(1);
  failing = false;
  expect((await listProviderThreads(sources, {})).unavailableProviders).toBeUndefined();
  expect(calls.filter(provider => provider === "offline")).toHaveLength(2);
});

test("Codex decodes reported cache writes and leaves absent or invalid counts unknown", () => {
  const native = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 5, cacheWriteInputTokens: 17, reasoningOutputTokens: 2 };
  expect(codexTokenUsage({ last: native, total: native })?.last.cacheWriteInputTokens).toBe(17);
  for (const value of [undefined, null, -1, "17"]) {
    expect(codexTokenUsage({ last: { ...native, cacheWriteInputTokens: value }, total: native })?.last.cacheWriteInputTokens).toBeNull();
  }
  expect(validateSubmitTurnRequest({ input: "hello", effort: null }).effort).toBeNull();
  expect(validateSubmitTurnRequest({ input: "hello", model: " ModelA ", effort: " Focused " })).toMatchObject({ model: " ModelA ", effort: " Focused " });
});

test("production Claude listings settle when Codex cannot be spawned", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shepherd-provider-isolation-"));
  try {
    const code = `const {createProviderServices}=await import('./server/runtime/provider_services.ts'); const {ConversationService}=await import('./server/core/conversation_service.ts'); const c=new ConversationService({providers:createProviderServices('claude')}); try {console.log(JSON.stringify({stored:await c.listStoredThreads({}),loaded:await c.listLoadedThreads({})}));} finally {c.stopAll();}`;
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", code], {
      cwd: join(import.meta.dir, ".."), timeout: 5_000,
      env: { ...process.env, PATH: directory, SHEPHERD_PROVIDER_STATE_DIR: join(directory, "providers"), SHEPHERD_CLAUDE_STATE_DIR: join(directory, "claude") },
    });
    expect(JSON.parse(stdout)).toMatchObject({ stored: { threads: [], unavailableProviders: ["codex"] }, loaded: { threadIds: [], unavailableProviders: ["codex"] } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
