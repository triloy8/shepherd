import { expect, test } from "bun:test";
import { ConversationService } from "../server/core/conversation_service";
import { memoryProviderDirectory } from "../server/core/provider_directory";
import { EventBus } from "../server/core/event_bus";
import type { ProviderSession } from "../server/ports/provider_session";
import type { ProviderServices } from "../server/ports/provider_services";
import type { ProviderDescriptor } from "../shared/protocol/providers";
import type { UserInput } from "../shared/protocol/user_input";
import type { HistoryTurn } from "../shared/protocol/requests";
import { toTextUserInput } from "../shared/protocol/user_input";
import { CodexSession } from "../server/providers/codex/session";
import { CodexAccount } from "../server/providers/codex/account";
import { codexInput } from "../server/providers/codex/input";
import { historyItem } from "../server/providers/codex/history";
import { webHarness } from "./helpers/web_harness";
import { account } from "./helpers/account";

import { descriptor, IndependentSession } from "./helpers/independent_provider.js";

test("an independent provider uses production orchestration, settings, events, history and ownership without native shims", async () => {
  const sessions: IndependentSession[] = [];
  const services: ProviderServices = { descriptors: [descriptor], providers: [descriptor.id], accounts: new Map([[descriptor.id, { read: async () => account(descriptor.id) }]]), directory: memoryProviderDirectory(descriptor.id), hasStoredThreads: () => true, createSession: (_policy, _tools, provider) => { expect(provider).toBe(descriptor.id); const session = new IndependentSession(); sessions.push(session); return session; } };
  const conversation = new ConversationService({ providers: services });
  try {
    const { threadId } = await conversation.createThread({ cwd: "/tmp" });
    expect(conversation.getThreadProvider(threadId)).toBe(descriptor.id);
    expect(conversation.listProviders()).toEqual([descriptor]);
    expect((await conversation.getThreadEffort(threadId)).supportedEfforts[0]!.reasoningEffort).toBe("focused");
    const events: import("../shared/protocol/events").BridgeEvent[] = [];
    conversation.subscribeToThreadEvents(threadId, event => events.push(event));
    await conversation.submitTurn(threadId, { input: [toTextUserInput("Hello")] });
    expect(events.find(event => event.type === "turn.stream.delta")!.payload).toMatchObject({ kind: "assistant_text", textDelta: "Third provider answer" });
    expect(sessions[0]!.inputs).toEqual([{ type: "text", text: "Hello" }]);
    expect((await conversation.listThreadTurns(threadId, { sortDirection: "desc" })).data[0]!.items[0]!.text).toBe("Third provider answer");
    expect((await conversation.readAccount(descriptor.id)).provider).toBe(descriptor.id);
    await expect(conversation.listSkills(threadId, {})).rejects.toThrow("support");
    await expect(conversation.compactThread(threadId)).rejects.toThrow("support");
    await expect(conversation.revertThread(threadId, { beforeTurnId: "opaque-turn" })).rejects.toThrow("support");
    await expect(conversation.forkThread(threadId, {})).rejects.toThrow("support");
    await conversation.interruptTurn(threadId);
    expect(conversation.getThreadState(threadId).activeTurnId).toBeNull();
  } finally { conversation.stopAll(); }
  expect(sessions.every(session => session.stopped)).toBe(true);
});

test("web discovers and routes an arbitrary provider; retired API prefixes have no aliases", async () => {
  const h = webHarness(), calls: string[] = [];
  Object.assign(h.application.conversation, { listProviders: () => [descriptor], readAccount: async (provider: string) => { calls.push(provider); return account(provider); }, listModels: async (request: { provider?: string }) => ({ data: [{ id: request.provider }], nextCursor: null }) });
  h.application.createSurfaceThread = async (_id, provider?: string) => { calls.push(provider!); return "arbitrary-thread"; };
  try {
    expect((await (await h.request("/providers")).json()).providers).toEqual([descriptor]);
    expect((await h.request("/conversations", "POST", { provider: descriptor.id, project: "~" })).status).toBe(201);
    expect((await (await h.request(`/limits?provider=${descriptor.id}`)).json()).provider).toBe(descriptor.id);
    expect(calls).toEqual([descriptor.id, descriptor.id]);
    expect((await (await h.request(`/models?provider=${descriptor.id}`)).json()).data[0].id).toBe(descriptor.id);
    expect((await h.request("/limits?provider=unregistered")).status).toBe(400);
    expect((await h.request("/limits/reset", "POST", { provider: descriptor.id, idempotencyKey: "attempt" })).status).toBe(422);
    for (const retired of ["v1", "v2"]) expect((await h.api.fetch(new Request(`http://localhost/api/${retired}/health`))).status).toBe(404);
  } finally { h.api.dispose(); }
});

test("account reset calls preserve adapter method ownership and decode native outcomes", async () => {
  const session = new CodexSession("review_sensitive"); session.initialize = async () => {};
  const seen: unknown[] = [];
  Object.assign(session, { sendRequest: async (method: string, params: unknown) => { seen.push({ method, params }); return { outcome: "alreadyRedeemed" }; } });
  const reader = new CodexAccount(() => session);
  const services = { descriptors: [], providers: [], accounts: new Map([["anything", reader]]), createSession: () => session, hasStoredThreads: () => false, directory: memoryProviderDirectory() } satisfies ProviderServices;
  const conversation = new ConversationService({ providers: services });
  try {
    expect(await conversation.resetAccount("anything", { idempotencyKey: "stable-key" })).toEqual({ outcome: "already_redeemed" });
    expect(seen).toEqual([{ method: "account/rateLimitResetCredit/consume", params: { idempotencyKey: "stable-key" } }]);
  } finally { conversation.stopAll(); reader.stop(); }
  await expect(reader.read()).rejects.toThrow("stopped");
});

test("native input and history fields are encoded and sanitized inside adapters", () => {
  expect(codexInput([{ type: "text", text: "hi", annotations: [{ byteRange: { start: 0, end: 2 }, placeholder: null }] }])).toEqual([{ type: "text", text: "hi", text_elements: [{ byteRange: { start: 0, end: 2 }, placeholder: null }] }]);
  const item = historyItem({ id: "tool", type: "commandExecution", command: "bun test", status: "completed", nativeSecret: "private", aggregatedOutput: "private" }, "turn");
  expect(item).toMatchObject({ id: "tool", type: "activity", activity: { kind: "command", status: "completed", detail: "bun test" } });
  expect(JSON.stringify(item)).not.toContain("nativeSecret"); expect(JSON.stringify(item)).not.toContain("aggregatedOutput");
});

test("opaque permission options retain native policy amendments and reject stale ownership", async () => {
  const session = new CodexSession("review_sensitive"); session.threadId = "thread"; session.activeTurnId = "turn";
  const writes: unknown[] = [], requests: import("../shared/protocol/approvals").ApprovalRequestPayload[] = [];
  const raw = session as unknown as { writeLine(value: unknown): void; onServerRequest(value: unknown): void; onNotification(method: string, value: unknown): void };
  raw.writeLine = value => writes.push(value);
  session.eventBus.subscribe(event => { if (event.type === "approval.requested") requests.push(event.payload as typeof requests[number]); }, { replay: false });
  raw.onServerRequest({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", command: "bun test", proposedExecpolicyAmendment: ["bun", "test"] } });
  const request = requests[0]!;
  expect(request.choices.every(choice => !["accept", "decline", "cancel"].includes(choice.value))).toBe(true);
  await expect(session.applyApprovalDecision(request.approvalId, { decision: "accept" })).rejects.toThrow("offered option");
  const permanent = request.choices.find(choice => choice.label.startsWith("Always allow commands"))!;
  await session.applyApprovalDecision(request.approvalId, { decision: permanent.value });
  expect(writes).toEqual([{ id: 1, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["bun", "test"] } } } }]);
  raw.onNotification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  raw.onServerRequest({ id: 2, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn" } });
  expect(requests).toHaveLength(1); expect(writes.at(-1)).toMatchObject({ id: 2, error: { code: -32602 } });
  session.stop();
});
