import { historyItem } from "../../server/providers/history_mapper";
import { installWebSkills } from "../helpers/web_skills_harness";
import { installWebSettings } from "../helpers/web_settings_harness";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Local browser-test fixture. Never imported by production entrypoints.
import { createWebAdapter } from "../../server/adapters/web/server.js";
import { webHarness } from "../helpers/web_harness.js";
import type { HistoryTurn, StoredThreadSummary } from "../../shared/protocol/requests.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";

const h = webHarness();
installWebSettings(h);
installWebSkills(h);
const threadProviders = new Map<string, string>();
const createThread = h.application.createSurfaceThread;
h.application.createSurfaceThread = async (id, provider = "codex") => { const threadId = await createThread(id); threadProviders.set(threadId, provider); return threadId; };
Object.assign(h.application.conversation, {
  listProviders: () => [
    { id: "codex", displayName: "Codex", capabilities: { questions: true, skills: true, compact: true, revert: true, fork: true, sandboxModes: ["read_only", "workspace_write", "unrestricted"], approvalModes: ["provider_default", "review_sensitive", "review_untrusted", "bypass"], inputKinds: ["text", "image", "localImage", "audio", "localAudio", "skill", "mention"], textAnnotations: true, imageDetail: true, ephemeralThreads: true, resets: true } },
    { id: "claude", displayName: "Claude", capabilities: { questions: true, skills: false, compact: false, revert: false, fork: true, sandboxModes: ["unrestricted"], approvalModes: ["provider_default", "review_sensitive", "bypass"], inputKinds: ["text", "image"], textAnnotations: false, imageDetail: false, ephemeralThreads: false, resets: false } },
    { id: "fixture-text-only", displayName: "Text agent", capabilities: { questions: false, skills: false, compact: false, revert: false, fork: false, sandboxModes: [], approvalModes: ["provider_default", "review_sensitive"], inputKinds: ["text"], textAnnotations: false, imageDetail: false, ephemeralThreads: false, resets: false } },
  ],
  getThreadProvider: (threadId: string) => threadProviders.get(threadId) ?? "codex",
  async readAccount(provider: string) {
    return { provider, account: { plan: provider === "claude" ? "Max" : "Pro", authentication: "subscription", signedIn: true }, availability: "available", source: "provider", checkedAt: Date.now() / 1000, stale: false, ordinaryUsageAllowed: true,
      windows: [{ id: "session", groupId: null, label: "Session allowance", subtitle: "Five-hour window", durationMinutes: 300, usedPercent: provider === "claude" ? 37 : 25, resetsAt: 2000000000, status: "available", observedAt: Date.now() / 1000, stale: false }],
      extraUsage: null, spendControls: [], resets: { supported: provider === "codex", availableCount: provider === "codex" ? 2 : null, credits: null }, message: null };
  },
  async resetAccount() { return { outcome: "reset" }; },
});
const imageDir = await mkdtemp(join(tmpdir(), "shepherd-ui-fixture-"));
const imagePath = join(imageDir, "generated.png");
await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64"));
// Named local files used by the browser attachment tests.
const viewedImagePath = join(imageDir, "desktop-screenshot.png");
await writeFile(viewedImagePath, await readFile(process.env.UI_TEST_SCREENSHOT ?? imagePath));
const generatedImagePath = join(imageDir, "unicorn.png");
await writeFile(generatedImagePath, await readFile(process.env.UI_TEST_GENERATED_IMAGE ?? imagePath));
const uploadDir = join(tmpdir(), "shepherd-image-input-fixtures");
await mkdir(uploadDir, { recursive: true });
for (const name of ["first.png", "second.png", "only.png", "2.png", "3.png", "4.png", "5.png"]) await writeFile(join(uploadDir, name), await readFile(imagePath));
await writeFile(join(uploadDir, "bad.svg"), "<svg/>");
const histories = new Map<string, HistoryTurn[]>([["stored", [{ id: "past", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1000, items: [
  { id: "question", type: "userMessage", content: [{ type: "text", text: "Where did we leave off?" }] },
  { id: "answer", type: "agentMessage", text: "The shared API is ready. Next, we’re building a **private workspace** for conversations, live responses, and approvals.\n\nEverything runs in the same Shepherd host." },
] }]]]);
const names = new Map<string, string>();
const archivedIds = new Set<string>();
const stored = (): StoredThreadSummary[] => [...histories.entries()].map(([threadId, turns]) => ({ threadId, name: names.get(threadId) ?? (threadId === "stored" ? "A new home for Shepherd" : null), preview: String((turns[0]?.items[0]?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "New conversation"), archived: archivedIds.has(threadId), cwd: "~", createdAt: 1, updatedAt: 2, source: "appServer" }));
h.application.conversation.listStoredThreads = async (request) => ({ threads: stored().filter((thread) => thread.archived === Boolean((request as { archived?: boolean }).archived)), nextCursor: null, backwardsCursor: null });
histories.set("paged", Array.from({ length: 35 }, (_, index): HistoryTurn => ({ id: `paged-${index}`, status: "completed", itemsView: "full", error: null, startedAt: index, completedAt: index + 1, durationMs: 1000, items: [
  { id: `paged-user-${index}`, type: "userMessage", content: [{ type: "text", text: `History turn ${index}` }] },
  { id: `paged-agent-${index}`, type: "agentMessage", phase: "final_answer", text: `History response ${index}` },
] })));
names.set("paged", "Paginated history");
h.application.conversation.listThreadTurns = async (threadId, request) => {
  const turns = [...(histories.get(threadId) ?? [])].reverse();
  const offset = Number(request.cursor?.replace("fixture:", "") ?? 0);
  const end = offset + (request.limit ?? 30);
  return { data: turns.slice(offset, end), nextCursor: end < turns.length ? `fixture:${end}` : null, backwardsCursor: null };
};
let sequence = 0;
Object.assign(h.application, {
  clearSurfaceThread: (id: string) => h.bindings.delete(id),
  async forkSurfaceThread(id: string, source: string) {
    const threadId = `fork-${++sequence}`;
    threadProviders.set(threadId, threadProviders.get(source) ?? "codex");
    histories.set(threadId, structuredClone(histories.get(source) ?? []));
    names.set(threadId, "Fork copy"); h.bindings.set(id, threadId); h.active.set(threadId, null);
    return threadId;
  },
});
Object.assign(h.application.conversation, {
  async setThreadName(threadId: string, { name }: { name: string }) { names.set(threadId, name); return { ok: true }; },
  async archiveThread(threadId: string) { archivedIds.add(threadId); return { ok: true }; },
  async unarchiveThread(threadId: string) { archivedIds.delete(threadId); return { ok: true }; },
});
const timers = new Set<ReturnType<typeof setTimeout>>();
const publish = (threadId: string, type: BridgeEvent["type"], payload: unknown) => {
  const id = [...h.bindings].find(([, thread]) => thread === threadId)?.[0];
  if (id) h.publish(id, { id: `fixture-${++sequence}`, type, threadId, sessionId: "fixture", ts: new Date().toISOString(), payload });
};
function later(ms: number, run: () => void) { const timer = setTimeout(() => { timers.delete(timer); run(); }, ms); timers.add(timer); }
function finish(threadId: string, status: "completed" | "interrupted" = "completed") {
  const history = histories.get(threadId)!;
  const turn = history.at(-1)!;
  turn.status = status;
  turn.durationMs = 1000;
  h.active.set(threadId, null);
  publish(threadId, "turn.completed", { turnId: turn.id });
}
h.context.ingress.submitTurn = async (threadId, request) => {
  const text = request.input.filter((item) => item.type === "text").map((item) => (item as { text: string }).text).join("\n");
  const turnId = `turn-${++sequence}`;
  const itemId = `agent-${sequence}`;
  const turn: HistoryTurn = { id: turnId, status: "inProgress", itemsView: "full", error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null, items: [{ id: `user-${sequence}`, type: "userMessage", content: structuredClone(request.input) }] };
  histories.set(threadId, [...(histories.get(threadId) ?? []), turn]);
  h.active.set(threadId, turnId); publish(threadId, "turn.started", { turnId });
  const progress = { id: `progress-${sequence}`, type: "agentMessage", phase: "commentary", text: "I’ll check the project first." };
  turn.items.push(progress);
  publish(threadId, "turn.message.completed", { itemId: progress.id, turnId, phase: progress.phase, text: progress.text });
  if (text.includes("provider question")) {
    const userInput = { threadId, turnId, itemId: `question-${sequence}`, isBlocking: true, questions: [{
      id: "provider", header: "Provider", multiSelect: text.includes("multi select"), question: "How should users select the agent provider?", isOther: true, isSecret: false,
      options: [
        { label: "Select per conversation (Recommended)", description: "Keep Codex as the default and choose Claude when creating a conversation." },
        { label: "Set one provider for the entire server", description: "All conversations use the same provider." },
      ],
    }] };
    const approval = { approvalId: `question-${sequence}`, kind: "question", prompt: userInput.questions[0]!.question,
      choices: [{ value: crypto.randomUUID(), label: "Submit answers", intent: "answer" }, { value: crypto.randomUUID(), label: "Skip questions", intent: "cancel" }], detail: null, userInput };
    h.approvals.create(approval, { threadId, sessionId: "fixture" });
    publish(threadId, "approval.requested", approval);
    return { ok: true, turnId };
  }
  const markdownResponse = "## Streaming Markdown\n\n**Formatted while writing.**\n\n```ts\nconst answer = 42;\n```";
  const mermaidResponse = "```mermaid\nflowchart LR\n A[Start] --> B[Ship]\n```";
  const response = text.includes("mermaid streaming") ? mermaidResponse : text.includes("markdown streaming") ? markdownResponse : text.includes("generate unicorn") ? "Your unicorn is ready." : text.includes("answer screenshot")
    ? `Here is the desktop view:\n\n![Desktop view](${viewedImagePath})\n\n[Open the original screenshot](${viewedImagePath})`
    : "Let’s make it happen.\n\nI’ll keep the UI connected to the same shared core, with a clear path back to your conversation if the connection drops.\n\n```ts\nconst surface = \"web\";\n```";
  later(120, () => {
    if (h.active.get(threadId) !== turnId) return;
    if (text.includes("generate unicorn")) {
      const image = { id: `generated-${sequence}`, type: "imageGeneration", status: "completed", savedPath: generatedImagePath, revisedPrompt: "A white unicorn in an enchanted meadow" };
      turn.items.push(historyItem(image, turnId));
      publish(threadId, "turn.image.generated", { itemId: image.id, turnId, path: image.savedPath, revisedPrompt: image.revisedPrompt });
    } else publish(threadId, "turn.stream.delta", { kind: "assistant_text", itemId, turnId, phase: "final_answer", textDelta: text.includes("mermaid streaming") ? mermaidResponse.slice(0, mermaidResponse.indexOf("Ship")) : text.includes("markdown streaming") ? markdownResponse.slice(0, markdownResponse.indexOf("42")) : "Let’s make it happen." });
  });
  if (text.includes("markdown streaming")) later(350, () => {
    if (h.active.get(threadId) === turnId) publish(threadId, "turn.stream.delta", { kind: "assistant_text", itemId, turnId, phase: "final_answer", textDelta: "42;\n" });
  });
  if (text.includes("mermaid streaming")) later(350, () => {
    if (h.active.get(threadId) === turnId) publish(threadId, "turn.stream.delta", { kind: "assistant_text", itemId, turnId, phase: "final_answer", textDelta: "Ship]\n" });
  });
  later(650, () => {
    if (!h.active.get(threadId)) return;
    turn.items.push({ id: itemId, type: "agentMessage", phase: "final_answer", text: response });
    publish(threadId, "turn.message.completed", { itemId, turnId, phase: "final_answer", text: response });
    if (text.includes("view screenshot") || text.includes("answer screenshot")) {
      const image = { id: `view-${sequence}`, type: "imageView", path: viewedImagePath };
      turn.items.push(historyItem(image, turnId));
      publish(threadId, "turn.activity", { itemId: image.id, turnId, kind: "image", label: "Viewing image", detail: image.path, status: "started" });
      publish(threadId, "turn.image.viewed", { itemId: image.id, turnId, path: image.path });
      publish(threadId, "turn.activity", { itemId: image.id, turnId, kind: "image", label: "Viewing image", detail: image.path, status: "completed" });
    }
    if (text.includes("parity")) {
      const tool = { id: `tool-${sequence}`, type: "commandExecution", command: "bun test", status: "failed" };
      turn.items.push(historyItem(tool, turnId));
      publish(threadId, "turn.activity", { itemId: tool.id, turnId, kind: "command", label: "Running command", detail: tool.command, status: "failed" });
      const image = { id: `image-${sequence}`, type: "imageGeneration", status: "completed", savedPath: imagePath, revisedPrompt: "Fixture image" };
      turn.items.push(historyItem(image, turnId));
      publish(threadId, "turn.image.generated", { itemId: image.id, turnId, path: imagePath, revisedPrompt: image.revisedPrompt });
      const final = { id: `final-${sequence}`, type: "agentMessage", phase: "final_answer", text: "Second final answer part." };
      turn.items.push(final);
      publish(threadId, "turn.message.completed", { itemId: final.id, turnId, phase: final.phase, text: final.text });
    }
    if (text.includes("approval")) {
      const approval = { approvalId: `approval-${sequence}`, kind: "permission", prompt: "Allow Shepherd to run the project’s test suite?", choices: [{ value: crypto.randomUUID(), label: "Allow once", intent: "allow" }, { value: crypto.randomUUID(), label: "Decline", intent: "deny" }], detail: "bun test\n~/project" };
      h.approvals.create(approval, { threadId, sessionId: "fixture" });
      publish(threadId, "approval.requested", approval);
    } else finish(threadId);
  });
  return { ok: true, turnId };
};
Object.assign(h.application.conversation, {
  async revertThread(threadId: string, { beforeTurnId }: { beforeTurnId: string }) {
    const turns = histories.get(threadId) ?? [];
    const index = turns.findIndex((turn) => turn.id === beforeTurnId);
    if (index < 0) throw new Error("Unknown revert turn.");
    histories.set(threadId, turns.slice(0, index));
    publish(threadId, "thread.reverted", {});
    return { thread: { id: threadId, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
  },
  async compactThread(threadId: string) {
    const turnId = `compact-${++sequence}`;
    const itemId = `compaction-${sequence}`;
    const turn: HistoryTurn = { id: turnId, status: "inProgress", itemsView: "full", error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null, items: [{ id: itemId, type: "contextCompaction", status: "inProgress" }] };
    histories.set(threadId, [...(histories.get(threadId) ?? []), turn]);
    h.active.set(threadId, turnId);
    publish(threadId, "turn.started", { turnId });
    publish(threadId, "turn.activity", { turnId, itemId, kind: "other", label: "Compacting context", detail: null, status: "started" });
    later(1000, () => {
      turn.items[0]!.status = "completed";
      publish(threadId, "turn.activity", { turnId, itemId, kind: "other", label: "Compacting context", detail: null, status: "completed" });
      finish(threadId);
    });
    return { ok: true };
  },
});
h.application.conversation.interruptTurn = async (threadId) => {
  for (const approval of h.approvals.expireUserInput(threadId)) publish(threadId, "approval.expired", { approvalId: approval.approvalId });
  finish(threadId, "interrupted");
};
h.context.approvals.applyApprovalDecision = async (threadId, id, decision) => {
  const request = h.approvals.listByThread(threadId).find(a => a.approvalId === id);
  h.approvals.markDecided(threadId, id, decision); h.approvals.markApplied(threadId, id);
  if (request?.userInput) {
    const turn = histories.get(threadId)!.at(-1)!;
    const text = request.choices.find(choice => choice.value === decision.decision)?.intent === "cancel" ? "Questions skipped. No provider choice was submitted." : `Thanks. I’ll use your answer: **${decision.answers?.provider?.answers[0]}**.`;
    const message = { id: `answer-${++sequence}`, type: "agentMessage", phase: "final_answer", text };
    turn.items.push(message);
    publish(threadId, "turn.message.completed", { itemId: message.id, turnId: turn.id, phase: "final_answer", text });
  }
  publish(threadId, "approval.applied", { approvalId: id }); finish(threadId);
};
let fixtureCheckout = "fixture-initial";
let fixtureRunning = fixtureCheckout;
let fixtureDeploying = false;
const restartFixture = () => later(250, () => { void (async () => {
  await adapter.stop(); fixtureRunning = fixtureCheckout;
  adapter = createWebAdapter(h.context, { ...h.config, port: Number(process.env.UI_TEST_PORT ?? 8799) });
  await adapter.start();
})(); });
h.application.runtimeLifecycle = {
  async runningCommit() { return fixtureRunning; },
  async deploymentStatus() { return { deployedCommit: fixtureCheckout, matchingRemoteRefs: ["origin/main"], deploymentInProgress: fixtureDeploying }; },
  async restart({ announce }) {
    await announce({ action: "restart" }); restartFixture();
    return { type: "restart-requested", action: "restart" };
  },
  async deploy({ announce, onDeploymentStarted, target = { kind: "main" } }) {
    fixtureDeploying = true; await onDeploymentStarted?.();
    await new Promise((resolve) => setTimeout(resolve, 2500)); fixtureDeploying = false;
    if (target.kind === "branch" && target.branch === "fail-validation") return { type: "deployment-failed", message: "Validation failed: fixture test failed; restored fixture-initial. Shepherd remains online." };
    const deployment = { previousCommit: fixtureCheckout, deployedCommit: "fixture-updated", target, changed: true };
    fixtureCheckout = deployment.deployedCommit;
    await announce({ action: "deploy", deployment }); restartFixture();
    return { type: "restart-requested", action: "deploy", deployment };
  },
};
let adapter = createWebAdapter(h.context, { ...h.config, port: Number(process.env.UI_TEST_PORT ?? 8799) });
await adapter.start();
console.log(adapter.url());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  for (const timer of timers) clearTimeout(timer);
  await adapter.stop(); h.api.dispose(); await rm(imageDir, { recursive: true, force: true }); await rm(uploadDir, { recursive: true, force: true }); process.exit(0);
});
