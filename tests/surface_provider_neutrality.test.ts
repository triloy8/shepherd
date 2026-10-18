import { afterEach, expect, test } from "bun:test";
import { sessionProvider } from "./helpers/session_providers.js";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationService } from "../server/core/conversation/conversation_service.js";
import { SurfaceConversationOrchestrator } from "../server/core/surface/surface_conversation_orchestrator.js";
import { SurfaceStateService } from "../server/core/surface/surface_state_service.js";
import { WorkspaceProvisioner } from "../server/core/workspace/workspace_provisioner.js";
import { assembleProviderServices } from "../server/runtime/provider_registration.js";
import { EventBus } from "../server/ports/event_bus.js";
import type { ProviderSession, ThreadBootstrapInfo } from "../server/ports/provider_session.js";
import type { CreateThreadRequest, ResumeThreadRequest, ForkThreadRequest } from "../shared/protocol/requests.js";
import { descriptor } from "./helpers/independent_provider.js";
import { account } from "./helpers/account.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function harness(options: { fork?: boolean; github?: boolean; sharedDirectory?: boolean; cloneFails?: boolean; workspaceChange?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "shepherd-surface-provider-")); roots.push(root);
  const capabilities = { ...descriptor.capabilities, workspaceChange: options.workspaceChange ?? false, modelCatalog: false, modelSelection: false,
    effortSelection: false, steer: false, interrupt: false, rename: false, archive: false, unarchive: false,
    questions: false, fork: options.fork ?? true, inputKinds: ["text"] as const, approvalModes: ["provider_default"] as const };
  const saved = new Map<string, ThreadBootstrapInfo>();
  const requests: Array<{ operation: string; request: CreateThreadRequest }> = [];
  let failBootstrap = false;
  let clones = 0;
  class MinimalSession implements ProviderSession {
    capabilities = capabilities;
    sessionId = crypto.randomUUID();
    eventBus = new EventBus();
    activeTurnId = null;
    approvalPolicy = "provider_default" as const;
    initialize = async () => {};
    startTurn = async () => null;
    applyApprovalDecision = async (approvalId: string) => ({ approvalId });
    stop() {}
    setCwd = capabilities.workspaceChange ? (_cwd: string) => {} : undefined;
    async startThread(request: CreateThreadRequest) { return this.bootstrap("create", request); }
    async resumeThread(threadId: string, request: ResumeThreadRequest) {
      requests.push({ operation: "resume", request });
      return { ...saved.get(threadId)!, cwd: request.cwd ?? saved.get(threadId)!.cwd };
    }
    forkThread = capabilities.fork ? async (_id: string, request: ForkThreadRequest) => this.bootstrap("fork", request) : undefined;
    private bootstrap(operation: string, request: CreateThreadRequest) {
      requests.push({ operation, request });
      if (failBootstrap) { writeFileSync(join(request.cwd!, "partial-provider-file"), "partial"); throw new Error("bootstrap failed"); }
      const result = { threadId: crypto.randomUUID(), cwd: request.cwd ?? root, model: null, effort: null };
      saved.set(result.threadId, result);
      return result;
    }
    async readThread(threadId: string) { return { thread: { id: threadId, cwd: saved.get(threadId)!.cwd } }; }
    async listStoredThreads() { return { data: [], nextCursor: null }; }
    async listThreadTurns() { return { data: [], nextCursor: null, backwardsCursor: null }; }
    async listThreadItems() { return { data: [], nextCursor: null, backwardsCursor: null }; }
  }
  const provisioner = new WorkspaceProvisioner({ homedirPath: root, cloneGithubRepo: async (_slug, cwd) => {
    clones++; mkdirSync(join(cwd, ".git"), { recursive: true });
    if (options.cloneFails) { writeFileSync(join(cwd, "partial-clone"), "partial"); throw new Error("clone failed"); }
  } });
  const projectRoot = options.github ? join(root, ".agent-workspaces", "repo") : join(root, "projects");
  const service = () => new ConversationService({
    providers: assembleProviderServices([{ threadIdentity: "application", id: descriptor.id, displayName: descriptor.displayName, capabilities,
      provider: sessionProvider(() => new MinimalSession(), capabilities), account: { read: async () => account(descriptor.id) }, hasStoredThreads: () => saved.size > 0,
    }], join(root, "state"), descriptor.id),
    // The least restrictive defaults fall back to the provider's own; restrictive ones would be refused.
    threadDefaults: { sandbox: "unrestricted", approvalPolicy: "bypass" },
  });
  const surface = (conversation: ConversationService, adapter: string) => {
    const state = new SurfaceStateService();
    state.setProjectTarget(adapter, "surface", options.github
      ? { kind: "github", slug: "owner/repo", display: "owner/repo" }
      : { kind: "local", rootPath: projectRoot, display: "test", appendWorkspaceId: !options.sharedDirectory });
    return new SurfaceConversationOrchestrator(conversation, state, provisioner, { adapter });
  };
  return { projectRoot, requests, service, surface, get clones() { return clones; }, setFailBootstrap() { failBootstrap = true; } };
}

for (const adapter of ["web", "discord"]) test(`${adapter} creates, forks and resumes a minimal provider in its effective workspace`, async () => {
  const h = harness(); let conversation = h.service();
  try {
    let surface = h.surface(conversation, adapter);
    const threadId = await surface.createAndBindSurfaceThread("surface", () => {});
    const cwd = await conversation.resolveThreadCwd(threadId);
    expect(cwd.startsWith(h.projectRoot)).toBe(true);
    expect(h.requests.at(-1)!.request).toEqual({ cwd, profile: null });
    expect((await conversation.listLoadedThreads({})).threadIds).toEqual([threadId]);
    const forkId = await surface.forkSurfaceThread("surface", threadId, () => {});
    expect(await conversation.resolveThreadCwd(forkId)).not.toBe(cwd);
    expect(h.requests.at(-1)!.request).not.toHaveProperty("sandbox");
    conversation.stopAll(); conversation = h.service(); surface = h.surface(conversation, adapter);
    expect(await surface.resumeSurfaceThread("surface", threadId, () => {})).toBe(threadId);
    expect(await conversation.resolveThreadCwd(threadId)).toBe(cwd);
    expect(surface.getSurfaceThread("surface")).toBe(threadId);
    expect(h.requests.at(-1)).toEqual({ operation: "resume", request: { cwd, profile: null } });
  } finally { conversation.stopAll(); }
});

test("unsupported forks fail before cloning or creating another workspace", async () => {
  const h = harness({ fork: false, github: true }); const conversation = h.service();
  try {
    const surface = h.surface(conversation, "discord");
    const threadId = await surface.createAndBindSurfaceThread("surface", () => {});
    const before = readdirSync(h.projectRoot);
    await expect(surface.forkSurfaceThread("surface", threadId, () => {})).rejects.toThrow("does not support fork");
    expect(h.clones).toBe(1);
    expect(readdirSync(h.projectRoot)).toEqual(before);
    expect(surface.getSurfaceThread("surface")).toBe(threadId);
  } finally { conversation.stopAll(); }
});

test("failed create and fork bootstrap clean their dedicated workspaces and preserve the current binding", async () => {
  const h = harness({ github: true }); const conversation = h.service();
  try {
    const surface = h.surface(conversation, "web");
    const threadId = await surface.createAndBindSurfaceThread("surface", () => {});
    const before = readdirSync(h.projectRoot); h.setFailBootstrap();
    await expect(surface.createAndBindSurfaceThread("surface", () => {})).rejects.toThrow("bootstrap failed");
    await expect(surface.forkSurfaceThread("surface", threadId, () => {})).rejects.toThrow("bootstrap failed");
    expect(readdirSync(h.projectRoot)).toEqual(before);
    expect(surface.getSurfaceThread("surface")).toBe(threadId);
  } finally { conversation.stopAll(); }
});

for (const workspaceChange of [false, true]) test(`a partial clone is cleaned with workspaceChange=${workspaceChange}`, async () => {
  const h = harness({ github: true, cloneFails: true, workspaceChange }); const conversation = h.service();
  try {
    await expect(h.surface(conversation, "web").createAndBindSurfaceThread("surface", () => {})).rejects.toThrow("clone failed");
    expect(readdirSync(h.projectRoot)).toEqual([]);
    expect(h.requests).toHaveLength(workspaceChange ? 1 : 0);
  } finally { conversation.stopAll(); }
});

test("bootstrap rollback never removes a configured shared project directory", async () => {
  const h = harness({ sharedDirectory: true }); const conversation = h.service();
  mkdirSync(h.projectRoot); writeFileSync(join(h.projectRoot, "user-file"), "keep"); h.setFailBootstrap();
  try {
    await expect(h.surface(conversation, "web").createAndBindSurfaceThread("surface", () => {})).rejects.toThrow("bootstrap failed");
    expect(readFileSync(join(h.projectRoot, "user-file"), "utf8")).toBe("keep");
  } finally { conversation.stopAll(); }
});
