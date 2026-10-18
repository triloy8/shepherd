import { afterEach, expect, test } from "bun:test";
import { toTextUserInput } from "../shared/protocol/user_input.js";
import { sessionProvider } from "./helpers/session_providers.js";
import { noProviderTools } from "../server/ports/provider_tools.js";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileThreadProviderDirectory } from "../server/storage/thread_provider_directory.js";
import { assembleProviderServices, describeThreadDefaults } from "../server/runtime/provider_registration.js";
import { assertDefaultProviderAcceptsThreadDefaults, assertInstalledProvider, threadDefaultNotices } from "../server/runtime/provider_services.js";
import { ConversationService } from "../server/core/conversation/conversation_service.js";
import { IndependentSession, descriptor } from "./helpers/independent_provider.js";
import { account } from "./helpers/account.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { codexOwnsStoredThread } from "../server/providers/codex/thread_ownership.js";
import { readRuntimeConfig } from "../server/config/runtime_environment.js";
import { assertInputSupport, resolveThreadProfile, threadPolicy } from "../shared/protocol/provider_support.js";
import { POLICY_PRESETS, type ExecutionPolicy } from "../shared/protocol/execution_policy.js";
import type { ProviderThreadRequest } from "../server/ports/provider_session.js";
import { codexCapabilities } from "../server/providers/codex/capabilities.js";
import { claudeCapabilities } from "../server/providers/claude/capabilities.js";
import { validateCreateThreadRequest, validateResumeThreadRequest, validateForkThreadRequest } from "../shared/protocol/validation.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function directory() { const path = mkdtempSync(join(tmpdir(), "shepherd-boundary-")); directories.push(path); return path; }

function registration() {
  return { threadIdentity: "application" as const, id: descriptor.id, displayName: descriptor.displayName, capabilities: descriptor.capabilities, provider: sessionProvider(() => new IndependentSession(), descriptor.capabilities), account: { read: async () => account(descriptor.id) }, hasStoredThreads: () => true };
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
    // instructions and ephemeral were removed: no surface sent them, and their cross-provider semantics were unverified.
    for (const field of ["config", "personality", "modelProvider", "serviceName", "baseInstructions", "developerInstructions", "instructions", "ephemeral"]) expect(() => validate({ [field]: {} })).toThrow(`Unsupported request field: ${field}`);
    expect(validate({ effort: "high", policy: POLICY_PRESETS.workspace })).toMatchObject({ effort: "high", policy: POLICY_PRESETS.workspace });
  }
});

test("each provider resolves a policy to its least restrictive profile within it and rejects unsupported media", () => {
  const resolve = (capabilities: typeof claudeCapabilities, policy: ExecutionPolicy) => resolveThreadProfile("agent", capabilities, policy, undefined);
  expect(resolve(claudeCapabilities, POLICY_PRESETS.bypass)).toBe("bypassPermissions");
  expect(resolve(claudeCapabilities, POLICY_PRESETS.workspace)).toBe("plan");
  expect(resolve(codexCapabilities, POLICY_PRESETS.bypass)).toBe("danger-full-access:never");
  expect(resolve(codexCapabilities, POLICY_PRESETS.review)).toBe("danger-full-access:on-request");
  // Codex's workspace sandbox blocks the network, which is stricter than the preset allows.
  expect(resolve(codexCapabilities, POLICY_PRESETS.workspace)).toBe("workspace-write:on-request");
  expect(resolve(codexCapabilities, { writes: "none", network: "none", review: "none" })).toBe("read-only:never");
  expect(() => resolve(claudeCapabilities, { writes: "any", network: "none", review: "none" })).toThrow("execution policy");
  // A request names its own policy; without one the host policy applies; with neither the agent keeps its defaults.
  expect(resolveThreadProfile("agent", codexCapabilities, undefined, POLICY_PRESETS.bypass)).toBe("danger-full-access:never");
  expect(resolveThreadProfile("agent", codexCapabilities, POLICY_PRESETS.review, POLICY_PRESETS.bypass)).toBe("danger-full-access:on-request");
  expect(resolveThreadProfile("agent", codexCapabilities, undefined, null)).toBeNull();
  expect(threadPolicy(codexCapabilities, "read-only:never")).toEqual({ profile: "read-only:never", policy: { writes: "none", network: "none", review: "none" } });
  expect(threadPolicy(codexCapabilities, null)).toBeNull();
  for (const input of [{ type: "audio", url: "data:audio/wav;base64,AA" }, { type: "image_file", path: "/tmp/image" }, { type: "skill", name: "tool", path: "/tmp/tool" }] as const) expect(() => assertInputSupport("agent", claudeCapabilities, [input])).toThrow("inputs");
  expect(() => assertInputSupport("agent", claudeCapabilities, [{ type: "image", url: "https://example.com", detail: "high" }])).toThrow("image detail");
  expect(() => assertInputSupport("agent", claudeCapabilities, [{ type: "text", text: "abc" }, { type: "image", url: "data:image/png;base64,AA" }])).not.toThrow();
});

test("core rejects unsupported create, submit and steer before provider execution or state changes", async () => {
  const sessions: IndependentSession[] = [];
  const services = assembleProviderServices([{ ...registration(), provider: sessionProvider(() => { const session = new IndependentSession(); sessions.push(session); return session; }, descriptor.capabilities)}], directory(), descriptor.id);
  const conversation = new ConversationService({ providers: services });
  try {
    // This provider declares no profiles, so any requested policy is refused rather than ignored.
    await expect(conversation.createThread({ policy: POLICY_PRESETS.read_only })).rejects.toThrow("execution policy");
    expect(sessions[0]!.stopped).toBe(true);
    const { threadId } = await conversation.createThread({});
    await expect(conversation.submitTurn(threadId, { input: [{ type: "audio", url: "data:audio/wav;base64,AA" }] })).rejects.toThrow("audio inputs");
    await expect(conversation.steerTurn(threadId, { input: [{ type: "audio", url: "data:audio/wav;base64,AA" }] })).rejects.toThrow("audio inputs");
    expect(sessions[1]!.inputs).toEqual([]);
    expect(conversation.getThreadState(threadId).activeTurnId).toBeNull();
  } finally { conversation.stopAll(); }
});

test("Codex sends every profile's native settings through each lifecycle operation, never per turn", async () => {
  const session = new CodexSession();
  session.initialize = async () => {};
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const raw = session as unknown as { sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  raw.sendRequest = async (method, params) => { requests.push({ method, params }); return method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "thread", cwd: "/repo" }, model: "test" }; };
  try {
    for (const profile of codexCapabilities.policyProfiles) {
      const [sandbox, approvalPolicy] = profile.id.split(":");
      await session.startThread({ profile: profile.id, effort: "high" });
      expect(requests.at(-1)!.params).toMatchObject({ approvalPolicy, sandbox, config: { model_reasoning_effort: "high" } });
      expect(session.profile).toBe(profile.id);
      await session.resumeThread("thread", { profile: profile.id });
      expect(requests.at(-1)!.params).toMatchObject({ approvalPolicy, sandbox });
      await session.forkThread("thread", { profile: profile.id });
      expect(requests.at(-1)!.params).toMatchObject({ approvalPolicy, sandbox });
      // The thread's mode is set when it starts; turns do not resend it.
      await session.startTurn([{ type: "text", text: "hello" }]);
      expect(requests.at(-1)!.params).not.toHaveProperty("approvalPolicy");
    }
    for (const operation of [() => session.startThread({}), () => session.resumeThread("thread", {}), () => session.forkThread("thread", { profile: null })]) {
      await operation(); expect(requests.at(-1)!.params).not.toHaveProperty("approvalPolicy"); expect(requests.at(-1)!.params).not.toHaveProperty("sandbox");
    }
    await expect(session.startThread({ profile: "bypassPermissions" })).rejects.toThrow("Unknown Codex policy profile");
  } finally { session.stop(); }
});


test("registration rejects conflicting capabilities and missing advertised methods before initialization", () => {
  for (const capabilities of [{ ...descriptor.capabilities, compact: true }, { ...descriptor.capabilities, inputKinds: ["text"] }]) {
    const session = new IndependentSession(); let initialized = false;
    session.initialize = async () => { initialized = true; };
    const services = assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => session, capabilities)}], directory(), descriptor.id);
    expect(() => services.provider(descriptor.id).openSession(noProviderTools)).toThrow("capability contract mismatch");
    expect(session.stopped).toBe(true); expect(initialized).toBe(false);
  }
  const session = new IndependentSession();
  const capabilities = { ...descriptor.capabilities, fork: true };
  Object.assign(session, { capabilities });
  const services = assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => session, capabilities)}], directory(), descriptor.id);
  expect(() => services.provider(descriptor.id).openSession(noProviderTools)).toThrow("capability contract mismatch");
  expect(session.stopped).toBe(true);
  const equivalent = assembleProviderServices([{ ...registration(), capabilities: { ...descriptor.capabilities, inputKinds: [...descriptor.capabilities.inputKinds].reverse() }, provider: sessionProvider(() => new IndependentSession())}], directory(), descriptor.id);
  const accepted = equivalent.provider(descriptor.id).openSession(noProviderTools); accepted.stop();
});

test("loaded discovery queries all registered providers including unmanaged threads, pages and persists owners", async () => {
  const queried: string[] = [];
  const registrations = ["first-adapter", "second-adapter"].map(id => ({ ...registration(), id, provider: sessionProvider(() => {
    const session = new IndependentSession();
    session.listLoadedThreads = async (request: { cursor?: string } = {}) => { queried.push(id); return { data: [id + (request.cursor ? "-older" : "-external")], nextCursor: request.cursor ? null : "native-next" }; };
    return session;
  }, descriptor.capabilities)}));
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
    const registrations = ids.map((id, index) => ({ ...registration(), id, provider: sessionProvider(() => {
      const session = new IndependentSession();
      const rows = Array.from({ length: 6 }, (_, n) => ({ id: `${id}-${n}`, updatedAt: 20 - n * 2 - index }));
      session.listStoredThreads = async (request: { cursor?: string; limit?: number } = {}) => {
        const offset = Number(request.cursor ?? 0), limit = request.limit ?? 20;
        return { data: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
      }; return session;
    }, descriptor.capabilities)}));
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
  const registrations = ["first-adapter", "second-adapter"].map(id => ({ ...registration(), id, provider: sessionProvider(() => { created.push(id); return new IndependentSession(); }, descriptor.capabilities)}));
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
  expect(readRuntimeConfig({ SHEPHERD_DEFAULT_PROVIDER: "two words" }).defaultProvider).toBe("two words");
  expect(() => assertInstalledProvider("not-installed")).toThrow("SHEPHERD_DEFAULT_PROVIDER must be one of");
  expect(() => assertInstalledProvider("claude")).not.toThrow();
});

const optionalOperations = [
  ["steer", "steerTurn"], ["interrupt", "interruptTurn"], ["rename", "setThreadName"],
  ["archive", "archiveThread"], ["unarchive", "unarchiveThread"],
  ["workspaceChange", "setCwd"], ["modelCatalog", "listModels"],
] as const;

test("disabled provider operations are exposed and rejected before adapter calls or pending state changes", async () => {
  const capabilities = { ...descriptor.capabilities, steer: false, interrupt: false, rename: false,
    archive: false, unarchive: false, workspaceChange: false, modelCatalog: false,
    modelSelection: false, effortSelection: false };
  const calls: string[] = [];
  const services = assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => {
    const session = new IndependentSession();
    Object.assign(session, { capabilities });
    for (const [, method] of optionalOperations) Object.assign(session, { [method]: () => { calls.push(method); throw Error("Adapter must not be called"); } });
    return session;
  }, capabilities)}], directory(), descriptor.id);
  const conversation = new ConversationService({ providers: services });
  try {
    const { threadId } = await conversation.createThread({});
    expect(conversation.listProviders()[0]!.capabilities).toMatchObject(capabilities);
    expect(conversation.getThreadState(threadId).capabilities).toMatchObject(capabilities);
    const actions = [
      () => conversation.steerTurn(threadId, { input: [{ type: "text", text: "steer" }] }),
      () => conversation.interruptTurn(threadId), () => conversation.setThreadName(threadId, { name: "changed" }),
      () => conversation.archiveThread(threadId), () => conversation.unarchiveThread(threadId),
      () => conversation.setThreadCwd(threadId, "/changed"), () => conversation.listModels({}),
      () => conversation.setThreadModel(threadId, "other"), () => conversation.setThreadEffort(threadId, "focused"),
      () => conversation.submitTurn(threadId, { model: "other", input: [{ type: "text", text: "hello" }] }),
      () => conversation.submitTurn(threadId, { effort: "focused", input: [{ type: "text", text: "hello" }] }),
      () => conversation.writeSkillConfig(threadId, { path: "/tmp/skill", enabled: false }),
      () => conversation.createThread({ model: "other" }), () => conversation.resumeThread(threadId, { effort: "focused" }),
    ];
    for (const action of actions) await expect(Promise.resolve().then(action)).rejects.toThrow("does not support");
    expect(calls).toEqual([]);
    expect(conversation.getThreadModel(threadId).pendingModel).toBeNull();
    expect((await conversation.getThreadEffort(threadId)).pendingEffort).toBeNull();
    expect(await conversation.getThreadCwd(threadId)).toBe("/tmp");
  } finally { conversation.stopAll(); }
});

test("a provider can omit optional methods and still execute media turns without a model catalog", async () => {
  const capabilities = { ...descriptor.capabilities, steer: false, interrupt: false, rename: false,
    archive: false, unarchive: false, workspaceChange: false, modelCatalog: false,
    modelSelection: false, effortSelection: false };
  const services = assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => {
    const session = new IndependentSession(); Object.assign(session, { capabilities });
    for (const [, method] of optionalOperations) Object.assign(session, { [method]: undefined });
    return session;
  }, capabilities)}], directory(), descriptor.id);
  const conversation = new ConversationService({ providers: services });
  try {
    const { threadId } = await conversation.createThread({});
    expect(await conversation.getThreadEffort(threadId)).toMatchObject({ inputModalities: null, supportedEfforts: null });
    await conversation.submitTurn(threadId, { input: [{ type: "image", url: "https://example.com/image.png" }] });
    expect(conversation.getThreadState(threadId).activeTurnId).toBe("opaque-turn");
    expect((await conversation.listThreadTurns(threadId, {})).data).toHaveLength(1);
  } finally { conversation.stopAll(); }
});

test("registration validates every advertised optional method and permits selection without discovery", () => {
  // History and provider-wide discovery are checked when the provider registers.
  for (const method of ["setThreadName", "archiveThread", "unarchiveThread", "listModels"] as const) {
    const provider = sessionProvider(() => new IndependentSession(), descriptor.capabilities);
    delete (provider as Partial<typeof provider>)[method];
    expect(() => assembleProviderServices([{ ...registration(), provider }], directory(), descriptor.id)).toThrow("capability contract mismatch");
  }
  // Thread operations are checked when the provider opens a session.
  for (const method of ["steerTurn", "interruptTurn", "setCwd"] as const) {
    const session = new IndependentSession(); Object.assign(session, { [method]: undefined });
    const services = assembleProviderServices([{ ...registration(), provider: sessionProvider(() => session, descriptor.capabilities)}], directory(), descriptor.id);
    expect(() => services.provider(descriptor.id).openSession(noProviderTools)).toThrow("capability contract mismatch");
    expect(session.stopped).toBe(true);
  }
  const capabilities = { ...descriptor.capabilities, modelCatalog: false, effortSelection: true };
  const session = new IndependentSession(); Object.assign(session, { capabilities });
  const services = assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => session, capabilities)}], directory(), descriptor.id);
  expect(() => services.provider(descriptor.id).openSession(noProviderTools)).not.toThrow();
});

test("skill discovery and model catalogs can be read-only", async () => {
  const capabilities = { ...descriptor.capabilities, skills: true, skillConfig: false,
    modelSelection: false, effortSelection: false };
  const services = assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => {
    const session = new IndependentSession();
    Object.assign(session, { capabilities, listSkills: async () => ({ skills: [], errors: [] }) });
    return session;
  }, capabilities)}], directory(), descriptor.id);
  const conversation = new ConversationService({ providers: services });
  try {
    const { threadId } = await conversation.createThread({});
    // Core reports the effective workspace it asked the provider to search.
    expect(await conversation.listSkills(threadId, {})).toEqual({ workspacePath: await conversation.resolveThreadCwd(threadId), skills: [], errors: [] });
    expect((await conversation.listModels({})).data).toHaveLength(1);
    await expect(conversation.writeSkillConfig(threadId, { path: "/tmp/skill", enabled: true })).rejects.toThrow("skillConfig");
    expect(() => conversation.setThreadModel(threadId, "third-model")).toThrow("modelSelection");
    await expect(conversation.setThreadEffort(threadId, "focused")).rejects.toThrow("effortSelection");
  } finally { conversation.stopAll(); }
});

/** A test agent whose profiles cover the cases resolution distinguishes. */
const profiled = { ...descriptor.capabilities, policyProfiles: [
  { id: "open", label: "Open", policy: POLICY_PRESETS.bypass },
  { id: "ask", label: "Ask", policy: POLICY_PRESETS.review },
  { id: "locked", label: "Locked", policy: { writes: "none", network: "none", review: "risky" } },
] } satisfies typeof descriptor.capabilities;

test("host and requested policies resolve to a profile within them and never loosen execution", async () => {
  const requests: unknown[] = [];
  class RecordingSession extends IndependentSession {
    override async startThread(request?: ProviderThreadRequest) { requests.push(request); return super.startThread(request); }
  }
  const create = (capabilities: typeof descriptor.capabilities, policy: ExecutionPolicy | null) => new ConversationService({
    threadDefaults: { policy },
    providers: assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => { const session = new RecordingSession(); Object.assign(session, { capabilities }); return session; }, capabilities)}], directory(), descriptor.id),
  });
  const bypass = create(profiled, POLICY_PRESETS.bypass);
  const workspace = create(profiled, POLICY_PRESETS.workspace);
  const unrestricted = create(profiled, null);
  const none = create(descriptor.capabilities, POLICY_PRESETS.bypass);
  try {
    const { threadId } = await bypass.createThread({});
    expect(requests.at(-1)).toMatchObject({ profile: "open" });
    expect(bypass.getThreadState(threadId).policy).toEqual({ profile: "open", policy: POLICY_PRESETS.bypass });
    // No exact match: the least restrictive profile that is still within the policy.
    await workspace.createThread({});
    expect(requests.at(-1)).toMatchObject({ profile: "locked" });
    // A request names its own policy instead of the host's, and is held to it.
    await workspace.createThread({ policy: POLICY_PRESETS.review });
    expect(requests.at(-1)).toMatchObject({ profile: "ask" });
    // Asking before risky actions is stricter than no review, so the locked profile is within this policy.
    await bypass.createThread({ policy: { writes: "none", network: "none", review: "none" } });
    expect(requests.at(-1)).toMatchObject({ profile: "locked" });
    // Without a host policy, the agent keeps its own defaults.
    await unrestricted.createThread({});
    expect(requests.at(-1)).toMatchObject({ profile: null });
    // An agent without a profile within the policy is refused before its session starts.
    const created = requests.length;
    await expect(none.createThread({})).rejects.toThrow("execution policy");
    expect(requests.length).toBe(created);
  } finally { for (const service of [bypass, workspace, unrestricted, none]) service.stopAll(); }
});

test("resume and fork also run within the host policy", async () => {
  const path = directory();
  const open = (policy: ExecutionPolicy | null) => new ConversationService({ threadDefaults: { policy }, providers: assembleProviderServices([registration()], path, descriptor.id) });
  const first = open(null);
  let threadId: string;
  try { threadId = (await first.createThread({ cwd: "/tmp" })).threadId; } finally { first.stopAll(); }
  const second = open(POLICY_PRESETS.read_only);
  try { await expect(second.resumeThread(threadId!, {})).rejects.toThrow("execution policy"); }
  finally { second.stopAll(); }
});

test("startup notices name each installed agent that cannot apply SHEPHERD_POLICY exactly", () => {
  expect(threadDefaultNotices({ policy: null })).toEqual([]);
  expect(threadDefaultNotices({ policy: POLICY_PRESETS.bypass })).toEqual([]);
  expect(threadDefaultNotices({ policy: POLICY_PRESETS.workspace })).toEqual([
    expect.stringContaining('Codex has no mode matching SHEPHERD_POLICY (writes=workspace, network=any, review=risky) exactly; its conversations use the stricter "Workspace writes, asks when needed"'),
    expect.stringContaining('Claude has no mode matching SHEPHERD_POLICY (writes=workspace, network=any, review=risky) exactly; its conversations use the stricter "Plan without changes"'),
  ]);
  expect(threadDefaultNotices({ policy: { writes: "none", network: "none", review: "risky" } })).toEqual([
    expect.stringContaining("Claude has no mode within SHEPHERD_POLICY (writes=none, network=none, review=risky); Shepherd refuses to start or resume its conversations"),
  ]);
});

test("startup rejects a host policy that the default agent would refuse for every conversation", () => {
  const offline = { writes: "none", network: "none", review: "risky" } as const;
  expect(() => assertDefaultProviderAcceptsThreadDefaults({ policy: offline }, "codex")).not.toThrow();
  expect(() => assertDefaultProviderAcceptsThreadDefaults({ policy: POLICY_PRESETS.bypass }, "claude")).not.toThrow();
  expect(() => assertDefaultProviderAcceptsThreadDefaults({ policy: offline }, "claude")).toThrow("Claude has no mode within SHEPHERD_POLICY");
});

test("keeping a thread's workspace does not require workspace changes", async () => {
  const capabilities = { ...descriptor.capabilities, workspaceChange: false };
  const conversation = new ConversationService({ providers: assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => { const session = new IndependentSession(); Object.assign(session, { capabilities }); return session; }, capabilities)}], directory(), descriptor.id) });
  try {
    const { threadId } = await conversation.createThread({});
    expect(() => conversation.setThreadCwd(threadId, "/tmp")).not.toThrow();
    expect(() => conversation.setThreadCwd(threadId, "/elsewhere")).toThrow("does not support");
  } finally { conversation.stopAll(); }
});

test("account reset support is a declared capability that registration checks against the account reader", () => {
  const reset = async () => ({ outcome: "reset" as const });
  const resetCapabilities = { ...descriptor.capabilities, accountReset: true };
  const withReset = { ...registration(), capabilities: resetCapabilities, provider: sessionProvider(() => new IndependentSession(), resetCapabilities), account: { read: async () => account(descriptor.id), reset } };
  expect(assembleProviderServices([withReset], directory(), descriptor.id).descriptors[0]!.capabilities.accountReset).toBe(true);
  expect(() => assembleProviderServices([{ ...withReset, account: { read: withReset.account.read } }], directory(), descriptor.id)).toThrow("capability contract mismatch");
  expect(() => assembleProviderServices([{ ...registration(), account: withReset.account }], directory(), descriptor.id)).toThrow("capability contract mismatch");
});

test("question requests from a provider that does not declare questions are failed, not recorded", async () => {
  const capabilities = { ...descriptor.capabilities, questions: false };
  let session!: IndependentSession;
  const decisions: unknown[] = [];
  const conversation = new ConversationService({ providers: assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => { session = new IndependentSession(); Object.assign(session, { capabilities }); return session; }, capabilities)}], directory(), descriptor.id) });
  try {
    const { threadId } = await conversation.createThread({});
    const events: string[] = [];
    conversation.subscribeToThreadEvents(threadId, event => events.push(event.type), { replay: false });
    session.applyApprovalDecision = async (id, decision) => { decisions.push({ id, decision }); return { approvalId: id }; };
    const userInput = { threadId, turnId: "turn", itemId: "item", isBlocking: true, questions: [{ id: "q", header: "Q", question: "Which?", isOther: true, isSecret: false, options: null }] };
    session.eventBus.publish({ id: "question", type: "approval.requested", threadId, sessionId: session.sessionId, ts: new Date().toISOString(), payload: { approvalId: "ask", kind: "question", choices: [{ value: "opaque-skip", label: "Skip", intent: "cancel" }], userInput } });
    session.eventBus.publish({ id: "permission", type: "approval.requested", threadId, sessionId: session.sessionId, ts: new Date().toISOString(), payload: { approvalId: "allow", kind: "permission", activity: { kind: "command", command: "Run?", cwd: null }, reason: null, choices: [] } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(conversation.listApprovals(threadId)).toHaveLength(1);
    expect(conversation.listApprovals(threadId)[0]!.activity).toEqual({ kind: "command", command: "Run?", cwd: null });
    expect(events).toEqual(["approval.requested", "approval.failed"]);
    expect(decisions).toEqual([{ id: "ask", decision: { decision: "opaque-skip", reason: "This agent does not support questions." } }]);
    const replay: string[] = [];
    conversation.subscribeToThreadEvents(threadId, event => replay.push(event.id));
    expect(replay).toEqual(["permission", "question:rejected"]);
  } finally { conversation.stopAll(); }
});

test("invalid question cancellation stops the session instead of leaving a provider waiting", async () => {
  for (const cancellation of ["missing", "failed"] as const) {
    const capabilities = { ...descriptor.capabilities, questions: false };
    let session!: IndependentSession;
    const conversation = new ConversationService({ providers: assembleProviderServices([{ ...registration(), capabilities, provider: sessionProvider(() => {
      session = new IndependentSession(); Object.assign(session, { capabilities });
      session.applyApprovalDecision = async () => { throw new Error("Cannot cancel"); };
      return session;
    }, capabilities)}], directory(), descriptor.id) });
    try {
      const { threadId } = await conversation.createThread({});
      const threadSession = session;
      await conversation.submitTurn(threadId, { input: [{ type: "text", text: "hello" }] });
      session = threadSession;
      const events: string[] = [];
      conversation.subscribeToThreadEvents(threadId, event => events.push(event.type), { replay: false });
      session.eventBus.publish({ id: "invalid", type: "approval.requested", threadId, sessionId: session.sessionId, ts: new Date().toISOString(), payload: {
        approvalId: "ask", kind: "question", choices: cancellation === "missing" ? [] : [{ value: "opaque", label: "Skip", intent: "cancel" }],
      } });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(session.stopped).toBe(true);
      expect(events).toEqual(["turn.failed", "session.error", "approval.failed"]);
      expect(conversation.listApprovals(threadId)).toEqual([]);
      await expect(conversation.submitTurn(threadId, { input: [{ type: "text", text: "next" }] })).rejects.toThrow("Unknown thread");
    } finally { conversation.stopAll(); }
  }
});

test("config notices validate arbitrary provider registrations, including providers without profiles", () => {
  expect(describeThreadDefaults({ policy: POLICY_PRESETS.review }, [registration()])).toEqual([
    expect.stringContaining("An unrelated agent has no mode within SHEPHERD_POLICY (writes=any, network=any, review=risky)"),
  ]);
  expect(describeThreadDefaults({ policy: null }, [registration()])).toEqual([]);
});

test("while a restart drains, new turns wait but running turns can be steered and interrupted", async () => {
  const sessions: IndependentSession[] = [];
  const services = assembleProviderServices([{ ...registration(), provider: sessionProvider(() => { const session = new IndependentSession(); sessions.push(session); return session; }, descriptor.capabilities)}], directory(), descriptor.id);
  const conversation = new ConversationService({ providers: services });
  try {
    const running = (await conversation.createThread({})).threadId;
    const idle = (await conversation.createThread({})).threadId;
    await conversation.submitTurn(running, { input: [toTextUserInput("long task")] });
    conversation.pauseNewTurns();
    // Conversations can still be opened; only starting work waits.
    const opened = (await conversation.createThread({})).threadId;
    await expect(conversation.submitTurn(idle, { input: [toTextUserInput("new work")] })).rejects.toMatchObject({ failure: { code: "restart_pending" } });
    await expect(conversation.submitTurn(opened, { input: [toTextUserInput("new work")] })).rejects.toMatchObject({ failure: { code: "restart_pending" } });
    await conversation.steerTurn(running, { input: [toTextUserInput("also this")] });
    expect(conversation.getRuntimeActivity().activeTurnThreadIds).toEqual([running]);
    await conversation.interruptTurn(running, {});
    expect(conversation.getRuntimeActivity().activeTurnThreadIds).toEqual([]);
    conversation.resumeNewTurns();
    await conversation.submitTurn(idle, { input: [toTextUserInput("new work")] });
    expect(conversation.getRuntimeActivity().activeTurnThreadIds).toEqual([idle]);
  } finally { conversation.stopAll(); }
});

test("a thread no surface uses releases its session once idle, and resuming it opens a new one", async () => {
  const sessions: IndependentSession[] = [];
  const services = assembleProviderServices([{ ...registration(), provider: sessionProvider(() => { const session = new IndependentSession(); sessions.push(session); return session; }, descriptor.capabilities)}], directory(), descriptor.id);
  const conversation = new ConversationService({ providers: services });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    // An idle thread releases its session as soon as its surface leaves.
    const idle = (await conversation.createThread({})).threadId;
    await conversation.bindSurfaceToThread("web", "tab-1", idle);
    const idleSession = sessions.at(-1)!;
    conversation.releaseSurface("web", "tab-1");
    expect(idleSession.stopped).toBe(true);
    expect(() => conversation.getThreadState(idle)).toThrow();

    // A busy thread keeps its session until its turn ends.
    const busy = (await conversation.createThread({})).threadId;
    await conversation.bindSurfaceToThread("web", "tab-2", busy);
    const busySession = sessions.at(-1)!;
    await conversation.submitTurn(busy, { input: [toTextUserInput("long task")] });
    conversation.clearSurfaceBinding("web", "tab-2");
    expect(busySession.stopped).toBe(false);
    await conversation.interruptTurn(busy); await settle();
    expect(busySession.stopped).toBe(true);

    // A thread taken up again before its work ends keeps its session.
    const kept = (await conversation.createThread({})).threadId;
    await conversation.bindSurfaceToThread("web", "tab-3", kept);
    const keptSession = sessions.at(-1)!;
    await conversation.submitTurn(kept, { input: [toTextUserInput("long task")] });
    conversation.clearSurfaceBinding("web", "tab-3");
    await conversation.bindSurfaceToThread("web", "tab-4", kept);
    await conversation.interruptTurn(kept); await settle();
    expect(keptSession.stopped).toBe(false);

    // A released thread resumes in a new session.
    await conversation.resumeThread(idle, {});
    expect(sessions.at(-1)!.stopped).toBe(false);
    expect(sessions.at(-1)).not.toBe(idleSession);
  } finally { conversation.stopAll(); }
});
