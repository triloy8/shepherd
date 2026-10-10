import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileThreadProviderDirectory } from "../server/storage/thread_provider_directory.js";
import { assembleProviderServices } from "../server/runtime/provider_registration.js";
import { ConversationService } from "../server/core/conversation_service.js";
import { IndependentSession, descriptor } from "./helpers/independent_provider.js";
import { account } from "./helpers/account.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { codexOwnsStoredThread } from "../server/providers/codex/thread_ownership.js";
import { readRuntimeConfig } from "../server/config/runtime_environment.js";
import { assertInputSupport, assertThreadSupport } from "../shared/protocol/provider_support.js";
import { codexCapabilities, claudeCapabilities } from "../server/providers/capabilities.js";
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
  const first = new ConversationService({ providers: assembleProviderServices([registration()], path) });
  let threadId: string;
  try { threadId = (await first.createThread({ provider: descriptor.id, cwd: "/tmp" })).threadId; }
  finally { first.stopAll(); }
  const second = new ConversationService({ providers: assembleProviderServices([registration()], path) });
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
  const services = assembleProviderServices([{ ...registration(), ownsStoredThread: id => { lookups++; return id === "known"; } }], path);
  expect(services.directory.resolve("known")).toBe(descriptor.id);
  expect(services.directory.resolve("known")).toBe(descriptor.id);
  expect(lookups).toBe(1);
  expect(() => services.directory.resolve("unknown")).toThrow("ownership is unknown");
  const ambiguous = assembleProviderServices([{ ...registration(), ownsStoredThread: () => true }, { ...registration(), id: "another-adapter", ownsStoredThread: () => true }], directory());
  expect(() => ambiguous.directory.resolve("collision")).toThrow("Ambiguous");
  expect(() => assembleProviderServices([registration(), registration()], directory())).toThrow("duplicate");
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
    for (const field of ["config", "personality", "modelProvider", "serviceName"]) expect(() => validate({ [field]: {} })).toThrow(`Unsupported request field: ${field}`);
    expect(validate({ effort: "high", sandbox: "workspace_write", approvalPolicy: "review_sensitive" })).toMatchObject({ effort: "high", sandbox: "workspace_write", approvalPolicy: "review_sensitive" });
  }
});

test("capabilities reject unsupported settings and annotated/media inputs without claiming identical native policies", () => {
  expect(() => assertThreadSupport("agent", claudeCapabilities, { approvalPolicy: "review_untrusted" })).toThrow("approval mode review_untrusted");
  expect(() => assertThreadSupport("agent", claudeCapabilities, { sandbox: "workspace_write" })).toThrow("sandbox mode workspace_write");
  expect(() => assertThreadSupport("agent", claudeCapabilities, { ephemeral: true })).toThrow("ephemeral");
  for (const input of [{ type: "audio", url: "data:audio/wav;base64,AA" }, { type: "localImage", path: "/tmp/image" }, { type: "skill", name: "tool", path: "/tmp/tool" }] as const) expect(() => assertInputSupport("agent", claudeCapabilities, [input])).toThrow("inputs");
  expect(() => assertInputSupport("agent", claudeCapabilities, [{ type: "image", url: "https://example.com", detail: "high" }])).toThrow("image detail");
  expect(() => assertInputSupport("agent", claudeCapabilities, [{ type: "text", text: "abc", annotations: [{ byteRange: { start: 0, end: 1 }, placeholder: null }] }])).toThrow("annotations");
  expect(() => assertInputSupport("agent", claudeCapabilities, [{ type: "text", text: "abc" }, { type: "image", url: "data:image/png;base64,AA" }])).not.toThrow();
  expect(() => assertThreadSupport("agent", codexCapabilities, { approvalPolicy: "review_untrusted", sandbox: "read_only", ephemeral: true })).not.toThrow();
  expect(readRuntimeConfig({})).toMatchObject({ approvalPolicy: "provider_default" });
  expect(readRuntimeConfig({ SHEPHERD_APPROVAL_MODE: "bypass", SHEPHERD_SANDBOX_MODE: "unrestricted" })).toMatchObject({ approvalPolicy: "bypass", defaultSandbox: "unrestricted" });
  expect(() => readRuntimeConfig({ SHEPHERD_APPROVAL_MODE: "review_all" })).toThrow("misleading");
});

test("core rejects unsupported create, submit and steer before provider execution or state changes", async () => {
  const sessions: IndependentSession[] = [];
  const services = assembleProviderServices([{ ...registration(), create: () => { const session = new IndependentSession(); sessions.push(session); return session; } }], directory());
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
    for (const operation of [() => session.startThread({ approvalPolicy: "provider_default" }), () => session.resumeThread("thread", { approvalPolicy: "provider_default" }), () => session.forkThread("thread", { approvalPolicy: "provider_default" }), () => session.startTurn([{ type: "text", text: "hello" }], "provider_default")]) {
      await operation(); expect(requests.at(-1)!.params).not.toHaveProperty("approvalPolicy");
    }
  } finally { session.stop(); }
});
