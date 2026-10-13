import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConversationService } from "../server/core/conversation_service.js";
import { SurfaceConversationOrchestrator } from "../server/core/surface_conversation_orchestrator.js";
import { SurfaceStateService } from "../server/core/surface_state_service.js";
import { WorkspaceProvisioner } from "../server/core/workspace_provisioner.js";
import { assembleProviderServices } from "../server/runtime/provider_registration.js";
import { scopedThreadId } from "../server/runtime/provider_thread_identity.js";
import { LocalSession, capabilities } from "./helpers/portable_provider.js";
import { webHarness } from "./helpers/web_harness.js";
import type { BridgeEvent } from "../shared/protocol/events.js";

/** The HTTP transport uses real registration, ownership, sessions and surface orchestration. */
function webRuntime(conversation: ConversationService, workspace: string) {
  const h = webHarness(); const state = new SurfaceStateService();
  const surface = new SurfaceConversationOrchestrator(conversation, state, new WorkspaceProvisioner(), { adapter: "web" });
  h.application.conversation = conversation as never;
  Object.assign(h.application, {
    getSurfaceThreadId: (id: string) => surface.getSurfaceThread(id),
    getSurfaceProject: (id: string) => surface.getSurfaceProjectDisplay(id),
    async setSurfaceProject(id: string) {
      state.setProjectTarget("web", id, { kind: "local", rootPath: workspace, display: "fixture", appendWorkspaceId: false });
      return { repoSlug: "fixture" };
    },
    createSurfaceThread: (id: string, provider?: string) => surface.createAndBindSurfaceThread(id, event => h.publish(id, event), provider),
    switchSurfaceThread: (id: string, threadId: string) => surface.switchSurfaceThread(id, threadId, event => h.publish(id, event)),
    disposeSurface: (id: string) => surface.disposeSurface(id),
  });
  h.context.ingress.getThreadState = conversation.getThreadState.bind(conversation);
  h.context.ingress.submitTurn = conversation.submitTurn.bind(conversation);
  h.context.ingress.steerTurn = conversation.steerTurn.bind(conversation);
  h.context.approvals.listApprovals = conversation.listApprovals.bind(conversation);
  h.context.approvals.applyApprovalDecision = conversation.applyApprovalDecision.bind(conversation);
  return h;
}

test("web reopens registered native identities after detach and restart without interpreting them as paths", async () => {
  const root = mkdtempSync("/tmp/shepherd-web-provider-"); const sessions: LocalSession[] = [];
  const nativeId = "native/path:α"; const id = scopedThreadId("third", nativeId);
  const services = () => assembleProviderServices([{
    id: "third", displayName: "Third", capabilities, hasStoredThreads: () => true, ownsStoredThread: value => value === nativeId,
    create: () => {
      const s = new LocalSession(capabilities);
      s.startThread = async () => ({ threadId: nativeId, cwd: root, model: null, effort: null });
      s.resumeThread = async value => { s.readIds.push(value); return s.startThread(); };
      s.readThread = async value => { s.readIds.push(value); return { thread: { id: value, cwd: root } }; };
      s.listStoredThreads = async () => ({ data: [{ id: nativeId, cwd: root }], nextCursor: null });
      sessions.push(s); return s;
    },
  }], join(root, "state"), "third");
  let conversation = new ConversationService({ providers: services() }); let h = webRuntime(conversation, root);
  try {
    const first = await h.create({ project: "fixture", provider: "third" }); expect(first.threadId).toBe(id);
    expect((await h.request(`/conversations/${first.id}`, "DELETE")).status).toBe(200);
    expect((await h.create({ threadId: id })).threadId).toBe(id);
    h.api.dispose(); conversation.stopAll();
    conversation = new ConversationService({ providers: services() }); h = webRuntime(conversation, root);
    const listed = await (await h.request("/threads")).json(); expect(listed.threads[0].threadId).toBe(id);
    const resumed = await h.create({ threadId: listed.threads[0].threadId });
    expect(resumed.threadId).toBe(id); expect(sessions.at(-1)!.readIds).toContain(nativeId);
    expect((await h.request(`/conversations/${resumed.id}/turns`)).status).toBe(200);
    expect((await h.request(`/conversations/${resumed.id}/messages`, "POST", { text: "Hello" })).status).toBe(200);
    expect(conversation.getThreadProvider(id)).toBe("third");
    // A filesystem-looking client value has no ownership and never reaches a provider or workspace operation.
    const before = sessions.length;
    const error = console.error; console.error = () => {};
    try { expect((await h.request("/conversations", "POST", { threadId: "../../escape" })).status).toBe(502); }
    finally { console.error = error; }
    expect(sessions).toHaveLength(before);
  } finally { h.api.dispose(); conversation.stopAll(); rmSync(root, { recursive: true, force: true }); }
});

test("web sees terminal approval expiry through SSE and null context telemetry through its shared controls", async () => {
  const root = mkdtempSync("/tmp/shepherd-web-events-"); let native!: LocalSession;
  const conversation = new ConversationService({ providers: assembleProviderServices([{
    id: "third", displayName: "Third", capabilities, hasStoredThreads: () => false,
    create: () => { native = new LocalSession(capabilities); return native; },
  }], join(root, "state"), "third") });
  const h = webRuntime(conversation, root);
  try {
    const c = await h.create({ project: "fixture" }); const path = `/conversations/${c.id}`;
    const emit = (event: BridgeEvent) => native.eventBus.publish({ ...event, threadId: "1", sessionId: native.sessionId });
    const envelope = { id: "event", threadId: "1", sessionId: native.sessionId, ts: "now" };
    native.activeTurnId = "turn";
    emit({ ...envelope, type: "approval.requested", payload: { approvalId: "permission", kind: "permission", prompt: "Run?", detail: null, choices: [{ value: "allow", intent: "allow", label: "Allow" }] } });
    expect((await (await h.request(`${path}/approvals`)).json()).approvals[0].status).toBe("pending");
    native.activeTurnId = null;
    emit({ ...envelope, id: "end", type: "turn.failed", payload: { turnId: "turn", message: "Interrupted" } });
    expect((await (await h.request(`${path}/approvals`)).json()).approvals[0].status).toBe("expired");
    expect((await h.request(`${path}/approvals/permission`, "POST", { decision: "allow" })).status).toBe(409);
    const stream = await h.request(`${path}/events`); const reader = stream.body!.getReader();
    let replay = "";
    for (let i = 0; i < 3 && !replay.includes('"type":"approval.expired"'); i++) replay += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel(); expect(replay).toContain('"type":"approval.expired"');
    const usage = { last: null, total: { inputTokens: null, outputTokens: null, totalTokens: 42, cacheReadInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null }, contextWindow: null };
    for (const tokenUsage of [usage, null]) {
      emit({ ...envelope, id: crypto.randomUUID(), type: "thread.tokenUsage.updated", payload: { turnId: null, tokenUsage } });
      expect((await (await h.request(`${path}/context`)).json()).tokenUsage).toEqual(tokenUsage);
    }
  } finally { h.api.dispose(); conversation.stopAll(); rmSync(root, { recursive: true, force: true }); }
});
