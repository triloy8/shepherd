import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileThreadProviderDirectory } from "../server/storage/thread_provider_directory.js";
import { assembleProviderServices } from "../server/runtime/provider_registration.js";
import { assertInstalledProvider } from "../server/runtime/provider_services.js";
import { ConversationService } from "../server/core/conversation_service.js";
import { IndependentSession, descriptor } from "./helpers/independent_provider.js";
import { account } from "./helpers/account.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { codexOwnsStoredThread } from "../server/providers/codex/thread_ownership.js";
import { readRuntimeConfig } from "../server/config/runtime_environment.js";
import { assertInputSupport, assertThreadSupport } from "../shared/protocol/provider_support.js";
import { codexCapabilities } from "../server/providers/codex/capabilities.js";
import { claudeCapabilities } from "../server/providers/claude/capabilities.js";
import { validateCreateThreadRequest, validateResumeThreadRequest, validateForkThreadRequest } from "../shared/protocol/validation.js";
import type { ApprovalPolicy } from "../shared/protocol/requests.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function directory() { const path = mkdtempSync(join(tmpdir(), "shepherd-boundary-")); directories.push(path); return path; }

function registration() {
  return { id: descriptor.id, displayName: descriptor.displayName, capabilities: descriptor.capabilities, create: () => new IndependentSession(), account: { read: async () => account(descriptor.id) }, hasStoredThreads: () => true };
}

test("an unrelated provider creates, survives process restart and resumes through production registration and file storage", async () => {
  const path = directory();
  const first = new ConversationService({ providers: assembleProviderServices([registration()], path, descriptor.id) });
  let threadId: string;
  try { threadId = (await first.createThread({ provider: descriptor.id, cwd: "/tmp" })).threadId; }
  finally { first.stopAll(); }
  const second = new ConversationService({ providers: assembleProviderServices([registration()], path, descriptor.id) });
  try {
    expect(second.getThreadProvider(threadId!)).toBe(descriptor.id);
    await second.resumeThread(threadId!, {});
    await second.submitTurn(threadId!, { input: [{ type: "text", text: "After restart" }] });
    expect(second.getThreadState(threadId!).activeTurnId).toBe("opaque-turn");
    expect((await second.listThreadTurns(threadId!, {})).data[0]!.items[0]!.text).toBe("Third provider answer");
  } finally { second.stopAll(); }
});

test("ownership discovery requires unique native evidence, persists it once, and never guesses missing or ambiguous owners", () => {
  const path = directory(); let lookups = 0;
  const services = assembleProviderServices([{ ...registration(), ownsStoredThread: id => { lookups++; return id === "known"; } }], path, descriptor.id);
  expect(services.directory.resolve("known")).toBe(descriptor.id);
  expect(services.directory.resolve("known")).toBe(descriptor.id);
  expect(lookups).toBe(1);
  expect(() => services.directory.resolve("unknown")).toThrow("ownership is unknown");
  const ambiguous = assembleProviderServices([{ ...registration(), ownsStoredThread: () => true }, { ...registration(), id: "another-adapter", ownsStoredThread: () => true }], directory(), descriptor.id);
  expect(() => ambiguous.directory.resolve("collision")).toThrow("Ambiguous");
  expect(() => assembleProviderServices([registration(), registration()], directory(), descriptor.id)).toThrow("duplicate");
});

test("persistent bindings validate their shape on both reads and repeated writes for arbitrary provider IDs", () => {
  const path = directory(); const storage = new FileThreadProviderDirectory(path);
  storage.bind("native-id", "custom-adapter");
  expect(new FileThreadProviderDirectory(path).resolve("native-id")).toBe("custom-adapter");
  expect(() => storage.bind("native-id", "another-adapter")).toThrow("Cannot change");
  const file = join(path, readdirSync(path)[0]!);
  for (const value of [null, { threadId: "native-id", provider: "" }, { threadId: "native-id", provider: 123 }]) {
    writeFileSync(file, JSON.stringify(value));
    expect(() => storage.resolve("native-id")).toThrow("Invalid thread provider binding");
    expect(() => storage.bind("native-id", "custom-adapter")).toThrow("Invalid thread provider binding");
  }
});

test("native ownership lookup finds indexed, unindexed and archived Codex records without claiming unrelated IDs", () => {
  const path = directory(), id = "12345678-1234-1234-1234-123456789abc";
  expect(codexOwnsStoredThread(id, path)).toBe(false);
  writeFileSync(join(path, "session_index.jsonl"), JSON.stringify({ id }) + "\n{partial");
  expect(codexOwnsStoredThread(id, path)).toBe(true);
  rmSync(join(path, "session_index.jsonl"));
  mkdirSync(join(path, "sessions", "nested"), { recursive: true });
  writeFileSync(join(path, "sessions", "nested", `rollout-date-${id}.jsonl`), "");
  expect(codexOwnsStoredThread(id, path)).toBe(true);
  rmSync(join(path, "sessions"), { recursive: true });
  mkdirSync(join(path, "archived_sessions"));
  writeFileSync(join(path, "archived_sessions", `rollout-date-${id}.jsonl`), "");
  expect(codexOwnsStoredThread(id, path)).toBe(true);
  expect(codexOwnsStoredThread("unknown", path)).toBe(false);
});

test("application request validators reject SDK fields across create, resume and fork", () => {
  for (const validate of [validateCreateThreadRequest, validateResumeThreadRequest, validateForkThreadRequest]) {
    for (const field of ["config", "personality", "modelProvider", "serviceName", "baseInstructions", "developerInstructions"]) expect(() => validate({ [field]: {} })).toThrow(`Unsupported request field: ${field}`);
    expect(validate({ effort: "high", sandbox: "workspace_write", approvalPolicy: "review_sensitive" })).toMatchObject({ effort: "high", sandbox: "workspace_write", approvalPolicy: "review_sensitive" });
  }
});

test("capabilities reject unsupported settings and media inputs without claiming identical native policies", () => {
  expect(() => assertThreadSupport("agent", claudeCapabilities, { approvalPolicy: "review_untrusted" })).toThrow("approval mode review_untrusted");
  expect(() => assertThreadSupport("agent", claudeCapabilities, { sandbox: "workspace_write" })).toThrow("sandbox mode workspace_write");
  expect(() => assertThreadSupport("agent", claudeCapabilities, { ephemeral: true })).toThrow("ephemeral");
  for (const input of [{ type: "audio", url: "data:audio/wav;base64,AA" }, { type: "image_file", path: "/tmp/image" }, { type: "skill", name: "tool", path: "/tmp/tool" }] as const) expect(() => assertInputSupport("agent", claudeCapabilities, [input])).toThrow("inputs");
  expect(() => assertInputSupport("agent", claudeCapabilities, [{ type: "image", url: "https://example.com", detail: "high" }])).toThrow("image detail");
  expect(() => assertInputSupport("agent", claudeCapabilities, [{ type: "text", text: "abc" }, { type: "image", url: "data:image/png;base64,AA" }])).not.toThrow();
  expect(() => assertThreadSupport("agent", codexCapabilities, { approvalPolicy: "review_untrusted", sandbox: "read_only", ephemeral: true })).not.toThrow();
  expect(readRuntimeConfig({})).toMatchObject({ approvalPolicy: "provider_default" });
  expect(readRuntimeConfig({ SHEPHERD_APPROVAL_MODE: "bypass", SHEPHERD_SANDBOX_MODE: "unrestricted" })).toMatchObject({ approvalPolicy: "bypass", defaultSandbox: "unrestricted" });
  expect(() => readRuntimeConfig({ SHEPHERD_APPROVAL_MODE: "review_all" })).toThrow("misleading");
});

test("core rejects unsupported create, submit and steer before provider execution or state changes", async () => {
  const sessions: IndependentSession[] = [];
  const services = assembleProviderServices([{ ...registration(), create: () => { const session = new IndependentSession(); sessions.push(session); return session; } }], directory(), descriptor.id);
  const conversation = new ConversationService({ providers: services });
  try {
    await expect(conversation.createThread({ ephemeral: true })).rejects.toThrow("ephemeral");
    expect(sessions[0]!.stopped).toBe(true);
    const { threadId } = await conversation.createThread({});
    await expect(conversation.submitTurn(threadId, { input: [{ type: "text", text: "hello" }], approvalPolicy: "review_untrusted" })).rejects.toThrow("approval mode");
    await expect(conversation.submitTurn(threadId, { input: [{ type: "audio", url: "data:audio/wav;base64,AA" }] })).rejects.toThrow("audio inputs");
    await expect(conversation.steerTurn(threadId, { input: [{ type: "audio", url: "data:audio/wav;base64,AA" }] })).rejects.toThrow("audio inputs");
    expect(sessions[1]!.inputs).toEqual([]);
    expect(conversation.getThreadState(threadId).activeTurnId).toBeNull();
  } finally { conversation.stopAll(); }
});

test("Codex maps canonical settings privately through every lifecycle operation and inherits default policies", async () => {
  const session = new CodexSession("provider_default");
  session.initialize = async () => {};
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const raw = session as unknown as { sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  raw.sendRequest = async (method, params) => { requests.push({ method, params }); return method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "thread" }, approvalPolicy: params.approvalPolicy, model: "test" }; };
  try {
    for (const [policy, native] of [["review_sensitive", "on-request"], ["review_untrusted", "untrusted"], ["bypass", "never"]] as const) {
      await session.startThread({ approvalPolicy: policy, sandbox: "workspace_write", effort: "high" });
      expect(requests.at(-1)!.params).toMatchObject({ approvalPolicy: native, sandbox: "workspace-write", config: { model_reasoning_effort: "high" } });
      expect(session.approvalPolicy).toBe(policy);
      await session.resumeThread("thread", { approvalPolicy: policy });
      expect(requests.at(-1)!.params.approvalPolicy).toBe(native);
      await session.forkThread("thread", { approvalPolicy: policy, sandbox: "read_only" });
      expect(requests.at(-1)!.params).toMatchObject({ approvalPolicy: native, sandbox: "read-only" });
      await session.startTurn([{ type: "text", text: "hello" }], policy);
      expect(requests.at(-1)!.params.approvalPolicy).toBe(native);
    }
    await session.startThread({ approvalPolicy: "bypass" });
    await session.startTurn([{ type: "text", text: "Continue saved policy" }], "provider_default");
    expect(session.approvalPolicy).toBe("bypass");
    expect(requests.at(-1)!.params.approvalPolicy).toBe("never");
    for (const operation of [() => session.startThread({ approvalPolicy: "provider_default" }), () => session.resumeThread("thread", { approvalPolicy: "provider_default" }), () => session.forkThread("thread", { approvalPolicy: "provider_default" }), () => session.startTurn([{ type: "text", text: "hello" }], "provider_default")]) {
      await operation(); expect(requests.at(-1)!.params).not.toHaveProperty("approvalPolicy");
    }
  } finally { session.stop(); }
});


test("registration rejects conflicting capabilities and missing advertised methods before initialization", () => {
  for (const capabilities of [{ ...descriptor.capabilities, compact: true }, { ...descriptor.capabilities, inputKinds: ["text"] }]) {
    const session = new IndependentSession(); let initialized = false;
    session.initialize = async () => { initialized = true; };
    const services = assembleProviderServices([{ ...registration(), capabilities, create: () => session }], directory(), descriptor.id);
    expect(() => services.createSession("provider_default", undefined as never, descriptor.id)).toThrow("capability contract mismatch");
    expect(session.stopped).toBe(true); expect(initialized).toBe(false);
  }
  const session = new IndependentSession();
  const capabilities = { ...descriptor.capabilities, fork: true };
  Object.assign(session, { capabilities });
  const services = assembleProviderServices([{ ...registration(), capabilities, create: () => session }], directory(), descriptor.id);
  expect(() => services.createSession("provider_default", undefined as never, descriptor.id)).toThrow("capability contract mismatch");
  expect(session.stopped).toBe(true);
  const equivalent = assembleProviderServices([{ ...registration(), capabilities: { ...descriptor.capabilities, approvalModes: [...descriptor.capabilities.approvalModes].reverse() }, create: () => new IndependentSession() }], directory(), descriptor.id);
  const accepted = equivalent.createSession("provider_default", undefined as never, descriptor.id); accepted.stop();
});

test("loaded discovery queries all registered providers including unmanaged threads, pages and persists owners", async () => {
  const queried: string[] = [];
  const registrations = ["first-adapter", "second-adapter"].map(id => ({ ...registration(), id, create: () => {
    const session = new IndependentSession();
    session.listLoadedThreads = async (request: { cursor?: string } = {}) => { queried.push(id); return { data: [id + (request.cursor ? "-older" : "-external")], nextCursor: request.cursor ? null : "native-next" }; };
    return session;
  } }));
  const path = directory(), services = assembleProviderServices(registrations, path, "first-adapter");
  const conversation = new ConversationService({ providers: services });
  try {
    expect(() => conversation.getThreadState("first-adapter-external")).toThrow();
    const first = await conversation.listLoadedThreads({ limit: 2 });
    const second = await conversation.listLoadedThreads({ limit: 2, cursor: first.nextCursor! });
    expect([...first.threadIds, ...second.threadIds]).toEqual(["first-adapter-external", "first-adapter-older", "second-adapter-external", "second-adapter-older"]);
    expect(second.nextCursor).toBeNull(); expect(new Set(queried)).toEqual(new Set(registrations.map(r => r.id)));
    const persisted = new FileThreadProviderDirectory(path);
    for (const id of [...first.threadIds, ...second.threadIds]) expect(persisted.resolve(id)).toBe(id.startsWith("first-") ? "first-adapter" : "second-adapter");
    const before = queried.length;
    for (const cursor of ["native-next", "shepherd-loaded:1junk", "shepherd-loaded:-1"]) await expect(conversation.listLoadedThreads({ cursor })).rejects.toThrow("cursor");
    expect(queried).toHaveLength(before);
  } finally { conversation.stopAll(); }
});

test("stored catalogs always use shared cursors and navigate backwards for one or several providers", async () => {
  for (const ids of [["one"], ["one", "two"]]) {
    const registrations = ids.map((id, index) => ({ ...registration(), id, create: () => {
      const session = new IndependentSession();
      const rows = Array.from({ length: 6 }, (_, n) => ({ id: `${id}-${n}`, updatedAt: 20 - n * 2 - index }));
      session.listStoredThreads = async (request: { cursor?: string; limit?: number } = {}) => {
        const offset = Number(request.cursor ?? 0), limit = request.limit ?? 20;
        return { data: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
      }; return session;
    } }));
    const conversation = new ConversationService({ providers: assembleProviderServices(registrations, directory(), registrations[0]!.id) });
    try {
      const request = { limit: 2, sortDirection: "desc" as const };
      const first = await conversation.listStoredThreads(request);
      expect(first.backwardsCursor).toBeNull(); expect(first.nextCursor).toStartWith("shepherd-providers:");
      const second = await conversation.listStoredThreads({ ...request, cursor: first.nextCursor! });
      const third = await conversation.listStoredThreads({ ...request, cursor: second.nextCursor! });
      const back = await conversation.listStoredThreads({ ...request, cursor: third.backwardsCursor! });
      expect(back.threads).toEqual(second.threads);
      expect((await conversation.listStoredThreads({ ...request, cursor: back.backwardsCursor! })).threads).toEqual(first.threads);
      await expect(conversation.listStoredThreads({ ...request, cursor: "native-next" })).rejects.toThrow("Invalid provider thread cursor");
      await expect(conversation.listStoredThreads({ ...request, archived: true, cursor: first.nextCursor! })).rejects.toThrow("Invalid provider thread cursor");
      await expect(conversation.listStoredThreads({ ...request, cwd: "/different", cursor: first.nextCursor! })).rejects.toThrow("Invalid provider thread cursor");
    } finally { conversation.stopAll(); }
  }
});

test("the default provider is explicit configuration rather than registration order", async () => {
  const created: string[] = [];
  const registrations = ["first-adapter", "second-adapter"].map(id => ({ ...registration(), id, create: () => { created.push(id); return new IndependentSession(); } }));
  expect(() => assembleProviderServices(registrations, directory(), "missing-adapter")).toThrow("not registered");
  const services = assembleProviderServices(registrations, directory(), "second-adapter");
  expect(services.descriptors.map(entry => [entry.id, entry.isDefault])).toEqual([["first-adapter", false], ["second-adapter", true]]);
  const conversation = new ConversationService({ providers: services });
  try {
    const { threadId } = await conversation.createThread({});
    expect(conversation.getThreadProvider(threadId)).toBe("second-adapter");
    expect(created).toEqual(["second-adapter"]);
  } finally { conversation.stopAll(); }
  expect(readRuntimeConfig({ SHEPHERD_DEFAULT_PROVIDER: " claude " }).defaultProvider).toBe("claude");
  expect(readRuntimeConfig({}).defaultProvider).toBeUndefined();
  expect(() => readRuntimeConfig({ SHEPHERD_DEFAULT_PROVIDER: "two words" })).toThrow("SHEPHERD_DEFAULT_PROVIDER");
  expect(() => assertInstalledProvider("not-installed")).toThrow("SHEPHERD_DEFAULT_PROVIDER must be one of");
  expect(() => assertInstalledProvider("claude")).not.toThrow();
});
