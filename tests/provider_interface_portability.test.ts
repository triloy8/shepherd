import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationService } from "../server/core/conversation_service.js";
import { executeControlAction } from "../server/core/control_actions_service.js";
import { assembleProviderServices, type ProviderRegistration } from "../server/runtime/provider_registration.js";
import { scopedThreadId } from "../server/runtime/provider_thread_identity.js";
import { LocalSession, capabilities, model } from "./helpers/portable_provider.js";
import { noProviderTools } from "../server/ports/provider_tools.js";
import { codexTokenUsage } from "../server/providers/codex/token_usage.js";
import { storedTokenUsage } from "../server/providers/claude/history.js";
import { claudeModelCatalog } from "../server/providers/claude/model_catalog.js";
import { WorkspaceProvisioner } from "../server/core/workspace_provisioner.js";
import type { ProviderCapabilities } from "../shared/protocol/provider_capabilities.js";
import type { ThreadTokenUsage } from "../shared/protocol/requests.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function directory() { const root = mkdtempSync(join(tmpdir(), "shepherd-portability-")); roots.push(root); return root; }
function registration(id: string, configure: (session: LocalSession) => void = () => {}, flags = capabilities) {
  const sessions: LocalSession[] = [];
  const entry: ProviderRegistration = { id, displayName: id, capabilities: flags,
    create: () => { const session = new LocalSession(flags); configure(session); sessions.push(session); return session; },
    hasStoredThreads: () => true, ownsStoredThread: id => id === "1" };
  return { entry, sessions };
}

test("selection and opaque effort work without discovery, and native rejection retains pending selections", async () => {
  const h = registration("selectable", () => {}, { ...capabilities, modelSelection: true, effortSelection: true });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({});
    const context = { conversation, getSurfaceThreadId: () => threadId };
    expect(await executeControlAction(context as never, { type: "model.set", surfaceId: "surface", requestedModel: "Project/CaseSensitive" })).toMatchObject({ ok: true });
    expect(await conversation.setThreadEffort(threadId, "NativeEffort")).toMatchObject({ effortOptionsKnown: false, pendingEffort: "NativeEffort" });
    await expect(conversation.setThreadEffort(threadId, { mode: "default" })).rejects.toMatchObject({ failure: { code: "unsupported_effort" } });
    const session = h.sessions[0]!;
    const start = session.startTurn;
    session.startTurn = async () => { throw new Error("Native selection rejected"); };
    await expect(conversation.submitTurn(threadId, { input: [] })).rejects.toThrow("Native selection rejected");
    expect(conversation.getThreadModel(threadId).pendingModel).toBe("Project/CaseSensitive");
    expect((await conversation.getThreadEffort(threadId)).pendingEffort).toBe("NativeEffort");
    session.startTurn = start;
    await conversation.submitTurn(threadId, { input: [] });
    expect(session.calls).toEqual([{ model: "Project/CaseSensitive", effort: "NativeEffort" }]);
  } finally { conversation.stopAll(); }
});

test("read-only discovery with unknown current/default model never prevents execution or settings reads", async () => {
  const h = registration("readonly", s => { s.rows = [model("alpha")]; }, { ...capabilities, modelCatalog: true });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({});
    expect(await conversation.getThreadEffort(threadId)).toMatchObject({ model: null, effortOptionsKnown: false, inputModalities: null });
    await conversation.submitTurn(threadId, { input: [{ type: "text", text: "hello" }] });
    expect(h.sessions[0]!.calls).toHaveLength(1);
    expect((await conversation.listModels({ threadId })).data[0]!.id).toBe("alpha");
    expect(h.sessions).toHaveLength(1);
  } finally { conversation.stopAll(); }
});

test("discovered models can leave effort levels unreported without disabling native selection", async () => {
  const h = registration("partial-catalog", s => {
    s.selectedModel = "alpha"; s.rows = [{ ...model("alpha"), supportedEfforts: null }];
  }, { ...capabilities, modelCatalog: true, effortSelection: true });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({});
    expect(await conversation.setThreadEffort(threadId, "provider-value")).toMatchObject({ supportedEfforts: null, effortOptionsKnown: false });
    await conversation.submitTurn(threadId, { input: [] });
    expect(h.sessions[0]!.calls[0]!.effort).toBe("provider-value");
  } finally { conversation.stopAll(); }
});

test("advisory discovery preserves reported models and permits native IDs absent from its catalog", async () => {
  const h = registration("advisory", s => { s.selectedModel = "provider-managed"; s.rows = [model("alpha")]; },
    { ...capabilities, modelCatalog: true, modelSelection: true });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({});
    expect(await conversation.getThreadEffort(threadId)).toMatchObject({ model: "provider-managed", supportedEfforts: null });
    await conversation.submitTurn(threadId, { input: [] });
    const context = { conversation, getSurfaceThreadId: () => threadId };
    expect(await executeControlAction(context as never, { type: "model.set", surfaceId: "s", requestedModel: "native-alias" })).toMatchObject({ ok: true });
    await conversation.submitTurn(threadId, { input: [] });
    expect(h.sessions[0]!.calls.at(-1)!.model).toBe("native-alias");
  } finally { conversation.stopAll(); }
});

test("conversation-specific bootstrap validates only after native workspace establishment", async () => {
  const flags = { ...capabilities, modelCatalog: true, modelCatalogScope: "conversation" as const,
    modelCatalogAuthoritative: true, modelSelection: true, fork: true };
  const h = registration("bootstrap-scoped", s => {
    s.startThread = async request => { s.bound = true; s.selectedModel = request?.cwd === "/other" ? "other-model" : "project-model";
      return { threadId: "1", cwd: request?.cwd ?? "/tmp", model: s.selectedModel, effort: null }; };
    Object.assign(s, { forkThread: async (_id: string, request: import("../shared/protocol/requests.js").ForkThreadRequest) => ({ ...await s.startThread(request), threadId: "2" }) });
    s.listModels = async () => { if (!s.bound) throw new Error("Catalog requires a bound conversation");
      return { data: [model(s.selectedModel!)], nextCursor: null }; };
  }, flags);
  const root = directory();
  const createService = () => new ConversationService({ providers: assembleProviderServices([h.entry], root, h.entry.id) });
  let conversation = createService();
  try {
    const { threadId } = await conversation.createThread({ cwd: "/workspace", model: "project-model" });
    expect(await conversation.resolveThreadCwd(threadId)).toBe("/workspace");
    const fork = await conversation.forkThread(threadId, { cwd: "/other", model: "other-model" });
    expect(conversation.getThreadModel(fork.threadId).currentModel).toBe("other-model");
    conversation.stopAll(); conversation = createService();
    await conversation.resumeThread(threadId, { cwd: "/workspace", model: "project-model" });
    await expect(conversation.createThread({ model: "missing" })).rejects.toMatchObject({ failure: { code: "model_unavailable" } });
    expect(h.sessions.at(-1)!.stopped).toBe(true);
    expect(conversation.getThreadModel(threadId).currentModel).toBe("project-model");
  } finally { conversation.stopAll(); }
});

test("conversation settings, control selection, submission and steering use the attached session catalog", async () => {
  const flags = { ...capabilities, modelCatalog: true, modelSelection: true, steer: true };
  const h = registration("scoped", s => {
    s.selectedModel = "project-model";
    s.listModels = async () => ({ data: [model(s.bound ? "project-model" : "host-model", true)], nextCursor: null });
    Object.assign(s, { steerTurn: async () => "turn" });
  }, flags);
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    await conversation.listModels({}); // Independently initialize provider-wide discovery.
    const { threadId } = await conversation.createThread({});
    expect((await conversation.getThreadEffort(threadId)).model).toBe("project-model");
    expect((await conversation.listModels({ threadId })).data.map(row => row.id)).toEqual(["project-model"]);
    const context = { conversation, getSurfaceThreadId: () => threadId };
    expect(await executeControlAction(context as never, { type: "model.set", surfaceId: "s", requestedModel: "project-model" })).toMatchObject({ ok: true });
    await conversation.submitTurn(threadId, { input: [] });
    await conversation.steerTurn(threadId, { input: [] });
    expect(h.sessions[1]!.calls).toHaveLength(1);
    expect(h.sessions[0]!.calls).toHaveLength(0);
  } finally { conversation.stopAll(); }
});

test("overlapping native thread and approval IDs stay independent through history, decisions, replay and restart", async () => {
  const a = registration("first"), b = registration("second");
  const root = directory(); const services = () => assembleProviderServices([a.entry, b.entry], root, a.entry.id);
  let conversation = new ConversationService({ providers: services() });
  try {
    const first = (await conversation.createThread({ provider: "first" })).threadId;
    const second = (await conversation.createThread({ provider: "second" })).threadId;
    expect(first).not.toBe(second);
    expect(first).toBe(scopedThreadId("first", "1"));
    for (const session of [a.sessions[0]!, b.sessions[0]!]) session.eventBus.publish({ id: "approval", type: "approval.requested",
      threadId: "1", sessionId: session.sessionId, ts: "now", payload: { approvalId: "1", kind: "permission", prompt: "Run?",
        choices: [{ value: "allow", intent: "allow", label: "Allow" }], detail: null } });
    expect(conversation.listApprovals(first)).toHaveLength(1);
    expect(conversation.listApprovals(second)).toHaveLength(1);
    const replay: string[] = [];
    conversation.subscribeToThreadEvents(first, event => replay.push(event.threadId));
    expect(replay).toEqual([first]);
    await conversation.applyApprovalDecision(first, conversation.listApprovals(first)[0]!.approvalId, { decision: "allow" });
    expect(a.sessions[0]!.decisions).toEqual(["1"]);
    expect(b.sessions[0]!.decisions).toEqual([]);
    expect(conversation.listApprovals(second)[0]!.status).toBe("pending");
    expect((await conversation.listStoredThreads({})).threads.map(row => row.threadId).sort()).toEqual([first, second].sort());
    await conversation.listThreadTurns(first, {});
    expect(a.sessions[0]!.readIds).toContain("1");
    conversation.stopAll(); conversation = new ConversationService({ providers: services() });
    await conversation.resumeThread(first, {});
    await conversation.resumeThread(second, {});
    expect(conversation.getThreadProvider(first)).toBe("first");
    expect(conversation.getThreadProvider(second)).toBe("second");
    expect(a.sessions.at(-1)!.readIds).toContain("1");
    await expect(conversation.listModels({ threadId: first, provider: "second" })).rejects.toThrow("Cannot change");
  } finally { conversation.stopAll(); }
});

test("account reporting is optional and partial cumulative telemetry stays unknown", async () => {
  const h = registration("local-only");
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    expect(conversation.listProviders()[0]!.accountReporting).toBe(false);
    await expect(conversation.readAccount(h.entry.id)).rejects.toThrow("account reporting");
    const { threadId } = await conversation.createThread({});
    const usage: ThreadTokenUsage = { last: null, total: { inputTokens: null, outputTokens: null, totalTokens: 42,
      cacheReadInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null }, contextWindow: null };
    h.sessions[0]!.eventBus.publish({ id: "usage", type: "thread.tokenUsage.updated", threadId: "1",
      sessionId: h.sessions[0]!.sessionId, ts: "now", payload: { turnId: null, tokenUsage: usage } });
    expect((await conversation.readThreadTokenUsage(threadId)).tokenUsage).toEqual(usage);
  } finally { conversation.stopAll(); }
});

test("unavailable discovery does not block a provider-chosen default", async () => {
  const h = registration("offline-discovery", s => { s.listModels = async () => { throw new Error("Discovery offline"); }; }, { ...capabilities, modelCatalog: true });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({});
    expect((await conversation.getThreadEffort(threadId)).effortOptionsKnown).toBe(false);
    await conversation.submitTurn(threadId, { input: [] });
    expect(h.sessions[0]!.calls).toHaveLength(1);
  } finally { conversation.stopAll(); }
});

test("identity translation covers tools, nested question targets, loaded discovery and foreign-ID rejection", async () => {
  let nativeTools = noProviderTools;
  const flags = { ...capabilities, questions: true };
  const native = new LocalSession(flags);
  Object.assign(native, { listLoadedThreads: async () => ({ data: ["1"], nextCursor: null }) });
  const entry: ProviderRegistration = { id: "tool-provider", displayName: "Tools", capabilities: flags,
    create: (_policy, tools) => { nativeTools = tools; return native; }, hasStoredThreads: () => true };
  const services = assembleProviderServices([entry], directory(), entry.id);
  const calls: string[] = [];
  const session = services.createSession("provider_default", { ...noProviderTools, execute: async request => { calls.push(request.threadId); return { contentItems: [], success: true }; } }, entry.id);
  try {
    const { threadId } = await session.startThread({});
    await nativeTools.execute({ threadId: "1", turnId: "turn", callId: "call", namespace: null, tool: "probe", arguments: null });
    expect(calls).toEqual([threadId]);
    native.eventBus.publish({ id: "question", threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.requested",
      payload: { approvalId: "1", kind: "question", prompt: "Which?", choices: [], detail: null,
        userInput: { threadId: "1", turnId: "turn", itemId: "item", isBlocking: true, questions: [] } } });
    const targets: string[] = [];
    const unsubscribe = session.eventBus.subscribe(event => { if (event.type === "approval.requested") targets.push(event.threadId, event.payload.userInput!.threadId); });
    expect(targets).toEqual([threadId, threadId]); unsubscribe();
    expect((await session.listLoadedThreads!({})).data).toEqual([threadId]);
    await expect(session.readThread(scopedThreadId("another", "1"), false)).rejects.toThrow("another provider");
    await expect(session.readThread("shepherd-thread:invalid", false)).rejects.toThrow("Invalid scoped");
    expect(session.forkThread).toBeUndefined();
  } finally { session.stop(); }
});

test("native and stored usage codecs preserve total-only reports without fabricated counts", () => {
  const expected = { last: null, total: { inputTokens: null, outputTokens: null, totalTokens: 42, cacheReadInputTokens: null,
    cacheWriteInputTokens: null, reasoningOutputTokens: null }, contextWindow: null };
  expect(codexTokenUsage({ total: { totalTokens: 42 } })).toEqual(expected);
  expect(storedTokenUsage({ total: { totalTokens: 42 } })).toEqual(expected);
});

test("opaque application IDs use bounded workspace names while deployed UUID paths stay unchanged", async () => {
  const root = directory(); const provisioner = new WorkspaceProvisioner();
  const target = { kind: "local" as const, rootPath: root, display: "local", appendWorkspaceId: true };
  const id = scopedThreadId("provider", "../" + "x".repeat(300));
  const first = await provisioner.reserveWorkspace(target, id);
  const again = await provisioner.reserveWorkspace(target, id);
  expect(first.cwd).toBe(again.cwd);
  expect(first.cwd).toMatch(new RegExp(`^${root}/[a-f0-9]{64}$`));
  await again.rollback();
  await provisioner.requireExistingWorkspace(first.cwd);
  const uuid = crypto.randomUUID();
  const deployed = await provisioner.provisionWorkspace(target, uuid);
  expect(deployed.cwd).toBe(join(root, uuid));
  await first.rollback();
});

for (const operation of ["create", "resume", "fork"] as const) test(`${operation} initializes before bootstrap and provider-wide catalog reads`, async () => {
  const flags = { ...capabilities, fork: true, modelCatalog: true, modelCatalogScope: "provider" as const, modelCatalogAuthoritative: true, modelSelection: true };
  const order: string[] = [];
  const h = registration("explicit-lifecycle", s => {
    let initialized = false;
    s.initialize = async () => { initialized = true; order.push("initialize"); };
    s.listModels = async () => { expect(initialized).toBe(true); order.push("catalog"); return { data: [model("alpha")], nextCursor: null }; };
    s.readThread = async id => { expect(initialized).toBe(true); return { thread: { id, cwd: "/tmp", model: "alpha" } }; };
    const bootstrap = async () => { expect(initialized).toBe(true); order.push(operation); return { threadId: operation === "fork" ? "2" : "1", cwd: "/tmp", model: "alpha", effort: null }; };
    s.startThread = bootstrap; s.resumeThread = bootstrap;
    Object.assign(s, { forkThread: bootstrap });
  }, flags);
  const services = assembleProviderServices([h.entry], directory(), h.entry.id);
  const source = scopedThreadId(h.entry.id, "1"); services.directory.bind(source, h.entry.id);
  const conversation = new ConversationService({ providers: services });
  try {
    if (operation === "create") await conversation.createThread({ model: "alpha" });
    else if (operation === "resume") await conversation.resumeThread(source, { model: "alpha" });
    else await conversation.forkThread(source, { model: "alpha" });
    expect(order).toEqual(["initialize", "catalog", operation]);
  } finally { conversation.stopAll(); }
});

test("bootstrap initialization failure stops the session and a retry uses a new session", async () => {
  let fail = true; let bootstraps = 0;
  const h = registration("retry-initialization", s => {
    s.initialize = async () => { if (fail) throw new Error("Initialization unavailable"); };
    const start = s.startThread.bind(s); s.startThread = async request => { bootstraps++; return start(request); };
  });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    await expect(conversation.createThread({})).rejects.toThrow("Initialization unavailable");
    expect(h.sessions[0]!.stopped).toBe(true); expect(bootstraps).toBe(0);
    fail = false; await conversation.createThread({});
    expect(h.sessions).toHaveLength(2); expect(bootstraps).toBe(1);
  } finally { conversation.stopAll(); }
});

test("thread IDs scope catalogs through bootstrap, settings, resume validation, submission and steering", async () => {
  const ids: Array<string | undefined> = [];
  const flags = { ...capabilities, modelCatalog: true, modelCatalogScope: "conversation" as const,
    modelCatalogAuthoritative: true, modelSelection: true, effortSelection: true, steer: true, inputKinds: ["text", "image"] as const };
  const row = { ...model("alpha"), inputModalities: ["text"] as const, supportedEfforts: [{ value: "focused", description: "" }] };
  const h = registration("thread-catalog", s => {
    s.selectedModel = "alpha";
    s.listModels = async request => { ids.push(request?.threadId); return { data: request?.threadId === "1" ? [row] : [], nextCursor: null }; };
    Object.assign(s, { steerTurn: async () => "turn" });
  }, flags);
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({ model: "alpha" });
    expect((await conversation.listModels({ threadId })).data).toEqual([row]);
    expect((await conversation.getThreadEffort(threadId)).inputModalities).toEqual(["text"]);
    await conversation.resumeThread(threadId, { effort: "focused" });
    await conversation.setThreadEffort(threadId, "focused");
    await conversation.submitTurn(threadId, { input: [{ type: "text", text: "hello" }], model: "alpha" });
    for (const call of [() => conversation.submitTurn(threadId, { input: [{ type: "image", url: "data:image/png;base64,eA==" }] }),
      () => conversation.steerTurn(threadId, { input: [{ type: "image", url: "data:image/png;base64,eA==" }] })]) {
      await expect(call()).rejects.toThrow("does not support image");
    }
    await conversation.steerTurn(threadId, { input: [{ type: "text", text: "follow up" }] });
    expect(ids.length).toBeGreaterThan(5); expect(ids.every(id => id === "1")).toBe(true);
  } finally { conversation.stopAll(); }
});

for (const defaultEffort of ["normal", null]) test(`model selection preserves automatic effort management with default ${defaultEffort}`, async () => {
  const h = registration("automatic-effort", s => {
    s.selectedModel = "alpha";
    s.rows = [{ ...model("alpha"), supportedEfforts: [{ value: "focused", description: "" }] },
      { ...model("beta"), defaultEffort, supportedEfforts: defaultEffort ? [{ value: defaultEffort, description: "" }] : [] }];
    s.startThread = async () => ({ threadId: "1", cwd: "/tmp", model: "alpha", effort: "focused" });
  }, { ...capabilities, modelCatalog: true, modelSelection: true });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({});
    conversation.setThreadModel(threadId, "beta");
    const native = h.sessions[0]!; const start = native.startTurn.bind(native);
    native.startTurn = async () => { throw new Error("Native model rejected"); };
    await expect(conversation.submitTurn(threadId, { input: [] })).rejects.toThrow("Native model rejected");
    expect((await conversation.getThreadEffort(threadId)).currentEffort).toBe("focused");
    native.startTurn = start;
    await conversation.submitTurn(threadId, { input: [] });
    expect(native.calls).toEqual([{ model: "beta", effort: undefined }]);
    expect((await conversation.getThreadEffort(threadId)).currentEffort).toBeNull();
    await expect(conversation.submitTurn(threadId, { input: [], effort: "normal" })).rejects.toThrow("effortSelection");
    await expect(conversation.submitTurn(threadId, { input: [], effort: null })).rejects.toThrow("effortSelection");
  } finally { conversation.stopAll(); }
});

for (const terminal of ["turn.completed", "turn.failed"] as const) test(`${terminal} expires permissions, publishes replayable expiry and preserves newer interactions`, async () => {
  const h = registration("terminal-approvals");
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({}); const native = h.sessions[0]!;
    const publish = (approvalId: string, turnId: string | null) => {
      native.activeTurnId = turnId;
      native.eventBus.publish({ id: approvalId, type: "approval.requested", threadId: "1", sessionId: native.sessionId, ts: "now",
        payload: { approvalId, kind: "permission", prompt: "Run?", detail: null, choices: [{ value: "allow", label: "Allow", intent: "allow" }] } });
    };
    publish("old", "old-turn"); publish("new", "new-turn");
    const [old, newer] = conversation.listApprovals(threadId).map(approval => approval.approvalId);
    const events: string[] = [];
    conversation.subscribeToThreadEvents(threadId, event => { if (event.type === "approval.expired") events.push(event.payload.approvalId); }, { replay: false });
    native.eventBus.publish({ id: "terminal", type: terminal, threadId: "1", sessionId: native.sessionId, ts: "now", payload: { turnId: "old-turn", message: "failed" } });
    expect(conversation.listApprovals(threadId).map(a => [a.approvalId, a.status])).toEqual([[old, "expired"], [newer, "pending"]]);
    expect(events).toEqual([old!]);
    await expect(conversation.applyApprovalDecision(threadId, old!, { decision: "allow" })).rejects.toThrow("already expired");
    expect(native.decisions).toEqual([]);
    const replay: string[] = [];
    conversation.subscribeToThreadEvents(threadId, event => { if (event.type === "approval.expired") replay.push(event.payload.approvalId); });
    expect(replay).toEqual([old!]);
    // Repeated completion cannot expire or resurrect other approvals.
    native.eventBus.publish({ id: "terminal-again", type: terminal, threadId: "1", sessionId: native.sessionId, ts: "now", payload: { turnId: "old-turn", message: "failed" } });
    expect(events).toEqual([old!]);
    await conversation.applyApprovalDecision(threadId, newer!, { decision: "allow" });
    expect(native.decisions).toEqual(["new"]);
  } finally { conversation.stopAll(); }
});

test("explicit null telemetry clears measurements while unrelated events preserve them", async () => {
  const h = registration("telemetry"); const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({}); const native = h.sessions[0]!;
    const usage: ThreadTokenUsage = { last: null, total: { inputTokens: null, outputTokens: null, totalTokens: 42,
      cacheReadInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null }, contextWindow: null };
    for (const tokenUsage of [usage, null, usage]) {
      native.eventBus.publish({ id: crypto.randomUUID(), type: "thread.tokenUsage.updated", threadId: "1", sessionId: native.sessionId, ts: "now", payload: { turnId: null, tokenUsage } });
      expect((await conversation.readThreadTokenUsage(threadId)).tokenUsage).toEqual(tokenUsage);
      native.eventBus.publish({ id: crypto.randomUUID(), type: "turn.completed", threadId: "1", sessionId: native.sessionId, ts: "now", payload: { turnId: null } });
      expect((await conversation.readThreadTokenUsage(threadId)).tokenUsage).toEqual(tokenUsage);
    }
  } finally { conversation.stopAll(); }
});

for (const explicitDefaults of [true, false]) test(`registration normalizes optional catalog defaults with explicit registration=${explicitDefaults}`, async () => {
  const base = { ...capabilities, modelCatalog: true };
  const defaults = { ...base, modelCatalogScope: "conversation" as const, modelCatalogAuthoritative: false };
  const entry = registration("catalog-defaults", () => {}, explicitDefaults ? defaults : base);
  const create = entry.entry.create;
  entry.entry.create = (policy, tools, provider) => { const session = create(policy, tools, provider); return Object.assign(session, { capabilities: explicitDefaults ? base : defaults }); };
  const conversation = new ConversationService({ providers: assembleProviderServices([entry.entry], directory(), entry.entry.id) });
  try { const { threadId } = await conversation.createThread({}); expect(conversation.getThreadProvider(threadId)).toBe(entry.entry.id); }
  finally { conversation.stopAll(); }
});

test("capability normalization still rejects different catalog scope and authority", async () => {
  for (const changed of [{ modelCatalogScope: "provider" as const }, { modelCatalogAuthoritative: true }]) {
    const entry = registration("mismatch", () => {}, { ...capabilities, modelCatalog: true }); const create = entry.entry.create;
    entry.entry.create = (policy, tools, provider) => Object.assign(create(policy, tools, provider), { capabilities: { ...entry.entry.capabilities, ...changed } });
    const conversation = new ConversationService({ providers: assembleProviderServices([entry.entry], directory(), entry.entry.id) });
    try { await expect(conversation.createThread({})).rejects.toThrow("capability contract mismatch"); expect(entry.sessions[0]!.stopped).toBe(true); }
    finally { conversation.stopAll(); }
  }
});

test("a provider with unknown effort metadata preserves inherited effort and accepts native effort values", async () => {
  const h = registration("unknown-effort", session => {
    session.selectedModel = "native";
    session.rows = claudeModelCatalog([{ value: "native", displayName: "Native", description: "" }], { model: "native", effort: "high" });
    session.startThread = async () => ({ threadId: "1", cwd: "/tmp", model: "native", effort: "high" });
  }, { ...capabilities, modelCatalog: true, effortSelection: true });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({});
    await conversation.submitTurn(threadId, { input: [] });
    expect(h.sessions[0]!.calls[0]!.effort).toBeUndefined();
    expect((await conversation.getThreadEffort(threadId)).currentEffort).toBe("high");
    await conversation.setThreadEffort(threadId, "OpaqueEffort"); await conversation.submitTurn(threadId, { input: [] });
    expect(h.sessions[0]!.calls[1]!.effort).toBe("OpaqueEffort");
  } finally { conversation.stopAll(); }
});

for (const id of ["vendor/agent", "agent:variant", "agent with spaces", "代理"]) test(`opaque provider ${id} can be the configured default`, async () => {
  const { readProviderDefaults } = await import("../server/runtime/provider_defaults.js");
  const requested = readProviderDefaults({ SHEPHERD_DEFAULT_PROVIDER: id });
  expect(requested.defaultProvider).toBe(id);
  const h = registration(id); const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), requested.defaultProvider!) });
  try { const { threadId } = await conversation.createThread({}); expect(conversation.getThreadProvider(threadId)).toBe(id); }
  finally { conversation.stopAll(); }
  expect(() => assembleProviderServices([h.entry], directory(), "not-registered")).toThrow("not registered");
});

test("independent provider null-ID completion releases consecutive real signal turns", async () => {
  const { ConversationSignalExecutor } = await import("../server/core/conversation_signal_executor.js");
  let turns = 0;
  const h = registration("signal-provider", session => {
    session.startTurn = async () => {
      const turnId = `turn-${++turns}`;
      session.activeTurnId = turnId;
      queueMicrotask(() => {
        session.activeTurnId = null;
        session.eventBus.publish({ id: `done-${turns}`, type: "turn.completed", threadId: "1", sessionId: session.sessionId, ts: "now", payload: { turnId: null } });
      });
      return turnId;
    };
  });
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({});
    const executor = new ConversationSignalExecutor(conversation);
    for (let index = 0; index < 2; index++) {
      await executor.executeTurn({ threadId, cwd: "/tmp" }, [{ type: "text", text: "Inspect" }]);
      await executor.waitUntilIdle({ threadId, cwd: "/tmp" });
    }
    expect(turns).toBe(2);
  } finally { conversation.stopAll(); }
});

test("stale Discord controls cannot authorize a newer occurrence of a reused native approval ID", async () => {
  const { encodeApprovalButtonId } = await import("../server/adapters/discord/message_renderer.js");
  const { handleInteraction } = await import("../server/adapters/discord/interactions.js");
  const h = registration("reused-approvals");
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({}); const native = h.sessions[0]!;
    const publish = (id: string, turnId: string, prompt: string) => {
      native.activeTurnId = turnId;
      native.eventBus.publish({ id, threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.requested", payload: { approvalId: "1", kind: "permission", prompt, detail: null, choices: [{ value: "allow", label: "Allow", intent: "allow" }] } });
    };
    publish("old", "old-turn", "Old permission");
    const old = conversation.listApprovals(threadId)[0]!;
    const button = encodeApprovalButtonId(threadId, old.approvalId, "allow");
    publish("new", "new-turn", "New permission");
    const newer = conversation.listApprovals(threadId)[1]!;
    const replies: unknown[] = [];
    await handleInteraction({ customId: button, reply: async payload => { replies.push(payload); } } as never, conversation as never);
    expect(replies).toHaveLength(1);
    expect(native.decisions).toEqual([]);
    expect(conversation.listApprovals(threadId)[1]!.status).toBe("pending");
    await expect(conversation.applyApprovalDecision(threadId, "1", { decision: "allow" })).rejects.toThrow("not found");
    // Replayed requests preserve the original application identity.
    publish("new", "new-turn", "New permission");
    expect(conversation.listApprovals(threadId)).toHaveLength(2);
    const replay: Array<{ type: string; approvalId: string }> = [];
    conversation.subscribeToThreadEvents(threadId, event => { if ("approvalId" in event.payload) replay.push({ type: event.type, approvalId: event.payload.approvalId }); });
    expect(replay).toEqual([{ type: "approval.requested", approvalId: old.approvalId }, { type: "approval.expired", approvalId: old.approvalId }, { type: "approval.requested", approvalId: newer.approvalId }]);
    await conversation.applyApprovalDecision(threadId, newer.approvalId, { decision: "allow" });
    expect(native.decisions).toEqual(["1"]);
  } finally { conversation.stopAll(); }
});

test("late native lifecycle events and in-flight decisions cannot mutate reused approvals", async () => {
  const h = registration("approval-races");
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({}); const native = h.sessions[0]!;
    const request = (id: string) => {
      native.activeTurnId = "same-turn";
      native.eventBus.publish({ id, threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.requested", payload: { approvalId: "1", kind: "permission", prompt: id, detail: null, choices: [{ value: "allow", label: "Allow", intent: "allow" }] } });
    };
    request("old"); const old = conversation.listApprovals(threadId)[0]!;
    let finish!: () => void;
    native.applyApprovalDecision = async id => { await new Promise<void>(resolve => { finish = resolve; }); return { approvalId: id }; };
    const pending = conversation.applyApprovalDecision(threadId, old.approvalId, { decision: "allow" });
    request("new"); const newer = conversation.listApprovals(threadId)[1]!;
    native.eventBus.publish({ id: "late", threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.expired", payload: { approvalId: "1" } });
    expect(conversation.listApprovals(threadId)[1]!.status).toBe("pending");
    finish(); await pending;
    expect(conversation.listApprovals(threadId).map(a => a.status)).toEqual(["applied", "pending"]);
    native.eventBus.publish({ id: "new-expiry", threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.expired", payload: { approvalId: "1", requestEventId: "new" } });
    expect(conversation.listApprovals(threadId)[1]).toMatchObject({ approvalId: newer.approvalId, status: "expired" });
  } finally { conversation.stopAll(); }
});

test("rejected question IDs can be reused by permissions without accepting delayed question events", async () => {
  const h = registration("rejected-reuse");
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({}); const native = h.sessions[0]!;
    native.activeTurnId = "question-turn";
    native.eventBus.publish({ id: "question", threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.requested", payload: { approvalId: "1", kind: "question", prompt: "Unsupported", detail: null, choices: [{ value: "cancel", label: "Cancel", intent: "cancel" }] } });
    await new Promise(resolve => setTimeout(resolve, 0));
    native.activeTurnId = "permission-turn";
    native.eventBus.publish({ id: "permission", threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.requested", payload: { approvalId: "1", kind: "permission", prompt: "Run?", detail: null, choices: [{ value: "allow", label: "Allow", intent: "allow" }] } });
    for (const payload of [{ approvalId: "1" }, { approvalId: "1", turnId: "question-turn" }, { approvalId: "1", requestEventId: "question" }]) {
      native.eventBus.publish({ id: crypto.randomUUID(), threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.expired", payload });
    }
    expect(conversation.listApprovals(threadId)).toHaveLength(1);
    expect(conversation.listApprovals(threadId)[0]!.status).toBe("pending");
    await conversation.applyApprovalDecision(threadId, conversation.listApprovals(threadId)[0]!.approvalId, { decision: "allow" });
    expect(native.decisions).toEqual(["1", "1"]);
  } finally { conversation.stopAll(); }
});

test("native turn correlation resolves approval lifecycle events after cross-turn reuse", async () => {
  const h = registration("correlated-reuse");
  const conversation = new ConversationService({ providers: assembleProviderServices([h.entry], directory(), h.entry.id) });
  try {
    const { threadId } = await conversation.createThread({}); const native = h.sessions[0]!;
    for (const turnId of ["old", "new"]) {
      native.activeTurnId = turnId;
      native.eventBus.publish({ id: turnId, threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.requested", payload: { approvalId: "1", kind: "permission", prompt: turnId, detail: null, choices: [] } });
    }
    native.eventBus.publish({ id: "failed", threadId: "1", sessionId: native.sessionId, ts: "now", type: "approval.failed", payload: { approvalId: "1", turnId: "new", message: "Cancelled upstream" } });
    expect(conversation.listApprovals(threadId).map(a => a.status)).toEqual(["expired", "failed"]);
  } finally { conversation.stopAll(); }
});
