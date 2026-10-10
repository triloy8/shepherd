import { expect, test } from "bun:test";
import { NativeConversationSource } from "../server/providers/neutral_source.js";
import { NeutralInteractions } from "../server/providers/neutral_interactions.js";
import { assistantItem } from "../server/providers/neutral_items.js";
import { ConversationProjection } from "../server/core/conversation_projection.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { SessionManager } from "../server/core/session_manager.js";
import { capabilities } from "./helpers/provider_v2.js";
import { codexAccount } from "../server/providers/codex/neutral_account.js";
import { claudeAccount } from "../server/providers/claude/neutral_account.js";
import { createProviderServices } from "../server/runtime/provider_services.js";
import { readNeutralEvents } from "./helpers/neutral-event-reader.js";
import { encodeEventFrame } from "../shared/protocol/v2/budgets.js";
import type { InteractionRequest } from "../shared/protocol/v2/interactions.js";
import type { ThreadSettings } from "../shared/protocol/v2/conversations.js";
import type { BridgeEvent } from "../shared/protocol/v2/events.js";
import { webHarness } from "./helpers/web_harness.js";

function actionHarness() {
  const caps = capabilities(); caps.steering = true; caps.inputKinds.push("asset"); caps.inputMedia.push("image");
  const source = new NativeConversationSource(caps, async () => ({ data: [], nextCursor: null })); source.bind("thread");
  const broker = new NeutralInteractions(source, "session"), projection = new ConversationProjection("thread", "session", source);
  let settings: ThreadSettings = { cwd: "/fixture", model: "fixture-model", effort: "normal", approvalMode: "provider_default", sandboxMode: "unrestricted" };
  const submissions: unknown[] = [], steering: unknown[] = [];
  source.controls = {
    settings: () => structuredClone(settings), configure: async patch => settings = { ...settings, ...patch },
    models: async () => ({ data: [{ id: "fixture-model", displayName: "Fixture", description: null, efforts: [{ id: "normal", label: "Normal" }], defaultEffort: "normal" }], nextCursor: null, backwardsCursor: null }),
    context: async () => null, submit: async turn => { submissions.push(turn); source.emit({ type: "turn.started", payload: { turnId: "turn" } }); return "turn"; },
    steer: async (input, turnId) => { steering.push(input); return turnId; }, interrupt: async () => {}, respond: (id, reply) => broker.respond(id, reply),
  };
  return { source, broker, projection, submissions, steering };
}
function question(): Omit<InteractionRequest, "options"> {
  return { id: crypto.randomUUID(), threadId: "thread", turnId: "turn", itemId: null, kind: "user_input", title: "Question", item: null, reason: null, permissions: null,
    questions: { threadId: "thread", turnId: "turn", itemId: "question", isBlocking: true, questions: [{ id: "secret", header: "Secret", question: "Enter a value", isOther: true, isSecret: true, options: null }] } };
}

test("neutral interaction validation leaves invalid answers pending and concurrent replies have one winner", async () => {
  const { source, broker, projection } = actionHarness();
  const request = question(), delivered: unknown[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  broker.request(request, [{ label: "Submit", intent: "submit", scope: null, effect: null, apply: async reply => { delivered.push(reply.answers); await barrier; } }]);
  const initial = projection.snapshot(), optionId = initial.interactions[0].options[0].id;
  expect(optionId).not.toBe("submit");
  await expect(projection.respond(request.id, { optionId, answers: {} })).rejects.toThrow("Answer every question");
  expect(projection.snapshot().interactions[0].status).toBe("pending");
  const reply = projection.respond(request.id, { optionId, answers: { secret: { answers: ["private-answer"] } } });
  await expect(projection.respond(request.id, { optionId })).rejects.toThrow("unavailable");
  release(); await reply;
  expect(delivered).toHaveLength(1); expect(projection.snapshot().interactions).toEqual([]);
  expect(JSON.stringify(projection.eventsAfter({ epoch: initial.epoch, sequence: 0 }))).not.toContain("private-answer");
  projection.close(); source.close();
});

test("expired interactions cannot be resurrected by late completion and failed delivery cannot be retried", async () => {
  const { source, broker, projection } = actionHarness();
  const request = question();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  broker.request(request, [{ label: "Cancel", intent: "cancel", scope: null, effect: null, apply: async () => { await barrier; throw new Error("delivery uncertain"); } }]);
  const snapshot = projection.snapshot(), optionId = snapshot.interactions[0].options[0].id;
  const reply = projection.respond(request.id, { optionId }); broker.expire(request.id); release();
  await expect(reply).rejects.toThrow("uncertain");
  expect(projection.snapshot().interactions).toEqual([]);
  const events = projection.eventsAfter({ epoch: snapshot.epoch, sequence: snapshot.throughSequence });
  expect(events.map(event => event.type)).toEqual(["interaction.decided", "interaction.expired"]);
  await expect(projection.respond(request.id, { optionId })).rejects.toThrow("unavailable");
  projection.close(); source.close();
});

test("Codex opaque options retain structured persistent replies entirely inside its adapter", async () => {
  const session = new CodexSession("on-request"); session.initialize = async () => {};
  const raw = session as unknown as { sendRequest(method: string): Promise<unknown>; onServerRequest(value: unknown): void; writeLine(value: unknown): void };
  raw.sendRequest = async method => { if (method === "thread/start") return { thread: { id: "thread" }, model: "fixture-model" }; throw new Error("Unexpected RPC"); };
  const writes: unknown[] = []; raw.writeLine = value => writes.push(value);
  const manager = new SessionManager(undefined, () => session); await manager.createThread({}); session.activeTurnId = "turn";
  raw.onServerRequest({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "native-command", command: "git status", proposedExecpolicyAmendment: ["git", "status"] } });
  const interaction = manager.readNeutralSnapshot("thread").interactions[0];
  const option = interaction.options.find(option => option.scope === "persistent")!;
  expect(option.effect?.commands[0]).toMatchObject({ match: { text: "git status" }, scope: "persistent" });
  expect(JSON.stringify(interaction)).not.toContain("acceptWithExecpolicyAmendment");
  await manager.respondNeutral("thread", interaction.id, { optionId: option.id });
  expect(writes).toEqual([{ id: 7, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } } } }]);
  expect(manager.listApprovals("thread")[0].status).toBe("applied"); manager.stopAll();
});

test("generic actions use capabilities and source ports for settings, submission, and steering", async () => {
  const { source, projection, submissions, steering } = actionHarness();
  await expect(projection.configure({ sandboxMode: "workspace_write" })).rejects.toThrow("capability");
  await projection.configure({ effort: "normal" });
  expect((await projection.models()).data[0].id).toBe("fixture-model");
  expect(await projection.submit({ input: [{ type: "text", text: "first" }] })).toEqual({ turnId: "turn", steered: false });
  expect(await projection.submit({ input: [{ type: "text", text: "follow-up" }] })).toEqual({ turnId: "turn", steered: true });
  expect(submissions).toHaveLength(1); expect(steering).toHaveLength(1);
  projection.close(); source.close();
});

test("neutral SSE parser handles split Unicode, large message frames, and envelope mismatches", async () => {
  const event: BridgeEvent = { id: "epoch:1", epoch: "epoch", sequence: 1, threadId: "thread", sessionId: "session", ts: 0, type: "session.started", payload: { model: "🦊" } };
  const frame = encodeEventFrame(event), events: BridgeEvent[] = [];
  await readNeutralEvents(new ReadableStream({ start(controller) { for (const byte of frame) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), value => events.push(value));
  expect(events).toEqual([event]);
  const fixture = actionHarness();
  const large: BridgeEvent = { ...event, type: "item.completed", payload: { item: assistantItem(fixture.source, "thread", "turn", "answer", "x".repeat(256 * 1024), "final_answer", "completed"), revision: 1 } };
  const encoded = encodeEventFrame(large); expect(encoded.byteLength).toBeGreaterThan(256 * 1024);
  const parsed: BridgeEvent[] = [];
  await readNeutralEvents(new ReadableStream({ start(controller) { for (let offset = 0; offset < encoded.byteLength; offset += 4096) controller.enqueue(encoded.slice(offset, offset + 4096)); controller.close(); } }), value => parsed.push(value));
  expect(parsed).toEqual([large]);
  fixture.projection.close(); fixture.source.close();
  const bad = new TextEncoder().encode('id: wrong\nevent: session.started\ndata: ' + JSON.stringify(event) + '\n\n');
  await expect(readNeutralEvents(new ReadableStream({ start(controller) { controller.enqueue(bad); controller.close(); } }), () => {})).rejects.toThrow("envelope");
});

test("runtime descriptors and account normalization are shared without exposing native quota shapes", () => {
  const services = createProviderServices();
  expect(services.descriptors?.map(provider => provider.displayName)).toEqual(["Codex", "Claude"]);
  expect(services.descriptors?.find(provider => provider.id === "codex")?.capabilities.resets).toBe(true);
  const value = codexAccount({ rateLimits: { primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1000 } }, rateLimitsByLimitId: null, rateLimitResetCredits: null }, 50);
  expect(value.windows[0]).toMatchObject({ usedPercent: 33, durationMinutes: 300, observedAt: 50 });
  const other = claudeAccount({ provider: "claude", account: { authentication: "api", plan: null, signedIn: true }, availability: "not_applicable", source: "none", checkedAt: null, stale: false, windows: [], extraUsage: null, message: "API account" });
  expect(other.resets.supported).toBe(false); expect(other.message?.text).toBe("API account");
  for (const reader of Object.values(services.accountLimits ?? {})) reader?.stop(); services.shutdown?.();
});

test("v2 HTTP accepts generic inputs and opaque replies, rejecting malformed data before dispatch", async () => {
  const h = webHarness(), conversation = await h.create(), fixture = actionHarness();
  Object.assign(h.application.conversation, {
    neutralSettings: () => fixture.projection.settings(), configureNeutral: (_id: string, value: Partial<ThreadSettings>) => fixture.projection.configure(value),
    neutralModels: () => fixture.projection.models(), neutralContext: () => fixture.projection.context(),
    submitNeutral: (_id: string, value: Parameters<ConversationProjection["submit"]>[0]) => fixture.projection.submit(value), interruptNeutral: () => fixture.projection.interrupt(),
    respondNeutral: (_id: string, requestId: string, reply: Parameters<ConversationProjection["respond"]>[1]) => fixture.projection.respond(requestId, reply),
    uploadNeutralAsset: (_id: string, media: "image" | "audio", data: Parameters<ConversationProjection["uploadAsset"]>[1]) => fixture.projection.uploadAsset(media, data),
  });
  const request = (path: string, data?: unknown) => h.api.fetch(new Request(`http://127.0.0.1/api/v2/conversations/${conversation.id}/${path}`, data === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }));
  try {
    expect((await request("settings")).status).toBe(200);
    expect((await request("messages", { input: [{ type: "text", text: "hello" }] })).status).toBe(200);
    expect((await request("messages", { text: "native input" })).status).toBe(400);
    expect((await request("messages", { input: [{ type: "asset", assetId: "/etc/passwd", media: "image" }] })).status).toBe(400);
    expect((await request("settings", { sandboxMode: "workspace_write" })).status).toBe(422);
    const pending = question(); fixture.broker.request(pending, [{ label: "Skip", intent: "cancel", scope: null, effect: null, apply: async () => {} }]);
    const optionId = fixture.projection.snapshot().interactions[0].options[0].id;
    expect((await request(`interactions/${pending.id}`, { optionId })).status).toBe(200);
    expect((await request(`interactions/${pending.id}`, { optionId })).status).toBe(409);
    expect((await request(`interactions/${pending.id}`, { decision: "accept" })).status).toBe(400);
  } finally { fixture.projection.close(); fixture.source.close(); h.api.dispose(); }
});

test("Codex neutral submissions send the provisioned workspace and restore the original approval policy", async () => {
  const session = new CodexSession("on-request"); session.initialize = async () => {};
  const calls: Array<{ method: string; params: unknown }> = [];
  const raw = session as unknown as { sendRequest(method: string, params?: unknown): Promise<unknown>; onNotification(method: string, params: unknown): void };
  raw.sendRequest = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread", cwd: "/original" }, model: "model" };
    if (method === "turn/start") return { turn: { id: `turn-${calls.length}` } };
    throw new Error(`Unexpected request ${method}`);
  };
  const manager = new SessionManager(undefined, () => session); await manager.createThread({});
  manager.setThreadCwd("thread", "/provisioned");
  await manager.configureNeutral("thread", { approvalMode: "bypass", sandboxMode: "read_only" });
  await manager.submitNeutral("thread", { input: [{ type: "text", text: "first" }] });
  expect(calls.at(-1)).toMatchObject({ method: "turn/start", params: { cwd: "/provisioned", approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } } });
  raw.onNotification("turn/completed", { threadId: "thread", turn: { id: session.activeTurnId, status: "completed" } });
  await manager.configureNeutral("thread", { approvalMode: "provider_default", sandboxMode: "workspace_write" });
  await manager.submitNeutral("thread", { input: [{ type: "text", text: "second" }] });
  expect(calls.at(-1)).toMatchObject({ method: "turn/start", params: { cwd: "/provisioned", approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } } });
  manager.stopAll();
});

test("neutral uploads are scoped to their conversation and v2 does not fall through to native routes", async () => {
  const h = webHarness(), conversation = await h.create(), fixture = actionHarness();
  Object.assign(h.application.conversation, {
    uploadNeutralAsset: (_id: string, media: "image" | "audio", data: Parameters<ConversationProjection["uploadAsset"]>[1]) => fixture.projection.uploadAsset(media, data),
    submitNeutral: (_id: string, input: Parameters<ConversationProjection["submit"]>[0]) => fixture.projection.submit(input),
    listNeutralProviders: () => [],
  });
  const request = (path: string, data?: unknown) => h.api.fetch(new Request(`http://127.0.0.1/api/v2/${path}`, data === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }));
  try {
    const png = "data:image/png;base64," + Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString("base64");
    const response = await request(`conversations/${conversation.id}/assets`, { data: png, name: "prompt.png" });
    expect(response.status).toBe(200); const asset = await response.json();
    expect(asset.id).toMatch(/^[a-f0-9]{64}$/); expect(asset.availability).toBe("available");
    expect((await fixture.source.readAsset(asset.id)).name).toBe("prompt.png");
    const other = actionHarness(); await expect(other.source.readAsset(asset.id)).rejects.toThrow("unavailable"); other.projection.close(); other.source.close();
    expect((await request(`conversations/${conversation.id}/assets`, { data: "data:image/png;base64,c2VjcmV0" })).status).toBe(400);
    expect((await request(`conversations/${conversation.id}/approvals`)).status).toBe(404);
    expect((await request(`conversations/${conversation.id}/model`, { model: "native" })).status).toBe(404);
    expect((await request("health")).status).toBe(200);
    expect(await (await request("health")).json()).toEqual({ ok: true, apiVersion: 2 });
    expect((await request("limits?refresh=maybe")).status).toBe(400);
    expect((await request("limits?refresh=true&refresh=false")).status).toBe(400);
  } finally { fixture.projection.close(); fixture.source.close(); h.api.dispose(); }
});

test("neutral model catalogs use private native cursors and validate later-page settings", async () => {
  const { modelCatalog, configured } = await import("../server/providers/neutral_controls.js");
  const nativeCursors: Array<string | undefined> = [];
  const catalog = modelCatalog(async cursor => {
    nativeCursors.push(cursor);
    return cursor ? { data: [{ model: "later", displayName: "Later", description: "", supportedReasoningEfforts: [{ reasoningEffort: "small", description: "Small" }], defaultReasoningEffort: "small" }], nextCursor: null }
      : { data: [{ model: "first", displayName: "First", description: "" }], nextCursor: "private-native-cursor" };
  });
  const first = await catalog(); expect(first.nextCursor).not.toBe("private-native-cursor");
  const later = await catalog(first.nextCursor!); expect(later.data[0].id).toBe("later");
  await expect(catalog("foreign")).rejects.toThrow("expired");
  const settings: ThreadSettings = { cwd: "/workspace", model: "first", effort: null, approvalMode: "provider_default", sandboxMode: "unrestricted" };
  expect(await configured(settings, { model: "later" }, catalog)).toMatchObject({ model: "later", effort: "small" });
  await expect(configured(settings, { model: "later", effort: "unsupported" }, catalog)).rejects.toThrow("supported");
  expect(nativeCursors).toContain("private-native-cursor");
});

test("account reporting leaves unknown allowance eligibility unknown and falls back from empty grouped quotas", () => {
  const value = codexAccount({ rateLimits: { primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1000 } }, rateLimitsByLimitId: {}, rateLimitResetCredits: null });
  expect(value.windows).toHaveLength(1); expect(value.ordinaryUsageAllowed).toBe(true);
  expect(claudeAccount({ provider: "claude", account: { authentication: "subscription", plan: null, signedIn: true }, availability: "available", source: "events", checkedAt: 0, stale: false, windows: [{ id: "unknown", label: "Unknown", usedPercent: null, resetsAt: null, status: null, observedAt: 0, stale: false }], extraUsage: null, message: null }).ordinaryUsageAllowed).toBeNull();
});

test("image references cannot bypass aggregate input budgets or start work with a foreign asset", async () => {
  const { nativeInput } = await import("../server/providers/neutral_controls.js");
  const { source, projection } = actionHarness();
  const asset = projection.uploadAsset("image", { mimeType: "image/png", name: "image", bytes: new Uint8Array(5 * 1024 * 1024) });
  await expect(nativeInput(source, Array.from({ length: 3 }, () => ({ type: "asset" as const, assetId: asset.id, media: "image" as const })))).rejects.toThrow("10 MiB total");
  await expect(nativeInput(source, [{ type: "asset", assetId: "f".repeat(64), media: "image" }])).rejects.toThrow("Attach the image again");
  projection.close(); source.close();
});

test("Codex refuses approval callbacks for a turn already completed in native notifications", async () => {
  const session = new CodexSession("on-request"); session.initialize = async () => {};
  const raw = session as unknown as { sendRequest(method: string): Promise<unknown>; onNotification(method: string, params: unknown): void; onServerRequest(request: unknown): void; writeLine(reply: unknown): void };
  raw.sendRequest = async () => ({ thread: { id: "thread" } });
  const replies: unknown[] = []; raw.writeLine = reply => replies.push(reply);
  const manager = new SessionManager(undefined, () => session); await manager.createThread({});
  raw.onNotification("turn/completed", { threadId: "thread", turn: { id: "completed", status: "completed" } });
  raw.onServerRequest({ id: 9, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "completed", itemId: "stale", command: "stale" } });
  expect(manager.readNeutralSnapshot("thread").interactions).toEqual([]);
  expect(replies).toEqual([{ id: 9, result: { decision: "cancel" } }]);
  manager.stopAll();
});

test("runtime configuration validates canonical defaults before native startup and ignores overridden aliases", async () => {
  const { readRuntimeConfig } = await import("../server/config/runtime_environment.js");
  expect(() => readRuntimeConfig({ SHEPHERD_APPROVAL_MODE: "invalid" })).toThrow("SHEPHERD_APPROVAL_MODE");
  expect(() => readRuntimeConfig({ SHEPHERD_SANDBOX_MODE: "invalid" })).toThrow("SHEPHERD_SANDBOX_MODE");
  expect(() => readRuntimeConfig({ SHEPHERD_APPROVAL_MODE: "review_sensitive", SHEPHERD_SANDBOX_MODE: "unrestricted", CODEX_APPROVAL_POLICY: "invalid", CODEX_SANDBOX: "invalid" })).not.toThrow();
});

test("session-scoped legacy approvals do not invent a native turn identity", async () => {
  const session = new CodexSession("on-request"); session.initialize = async () => {};
  const raw = session as unknown as { sendRequest(method: string): Promise<unknown>; onServerRequest(request: unknown): void; writeLine(reply: unknown): void };
  raw.sendRequest = async () => ({ thread: { id: "thread" } }); raw.writeLine = () => {};
  const manager = new SessionManager(undefined, () => session); await manager.createThread({});
  raw.onServerRequest({ id: 10, method: "execCommandApproval", params: { command: ["git", "status"] } });
  const snapshot = manager.readNeutralSnapshot("thread");
  expect(snapshot.state.activeTurnId).toBeNull(); expect(snapshot.interactions[0].turnId).toBeNull();
  await manager.respondNeutral("thread", snapshot.interactions[0].id, { optionId: snapshot.interactions[0].options.find(option => option.intent === "cancel")!.id });
  expect(manager.readNeutralSnapshot("thread").interactions).toEqual([]); manager.stopAll();
});
