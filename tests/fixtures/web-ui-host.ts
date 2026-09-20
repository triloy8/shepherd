import { installWebSkills } from "../helpers/web_skills_harness";
import { installWebSettings } from "../helpers/web_settings_harness";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
const imageDir = await mkdtemp(join(tmpdir(), "shepherd-ui-fixture-"));
const imagePath = join(imageDir, "generated.png");
await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"));
const histories = new Map<string, HistoryTurn[]>([["stored", [{ id: "past", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1000, items: [
  { id: "question", type: "userMessage", content: [{ type: "text", text: "Where did we leave off?" }] },
  { id: "answer", type: "agentMessage", text: "The shared API is ready. Next, we’re building a **private workspace** for conversations, live responses, and approvals.\n\nEverything runs in the same Shepherd host." },
] }]]]);
const names = new Map<string, string>();
const archivedIds = new Set<string>();
const stored = (): StoredThreadSummary[] => [...histories.entries()].map(([threadId, turns]) => ({ threadId, name: names.get(threadId) ?? (threadId === "stored" ? "A new home for Shepherd" : null), preview: String((turns[0]?.items[0]?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "New conversation"), archived: archivedIds.has(threadId), cwd: "~", createdAt: 1, updatedAt: 2, source: "appServer" }));
h.application.conversation.listStoredThreads = async (request) => ({ threads: stored().filter((thread) => thread.archived === Boolean((request as { archived?: boolean }).archived)), nextCursor: null, backwardsCursor: null });
h.application.conversation.listThreadTurns = async (threadId) => ({ data: [...(histories.get(threadId) ?? [])].reverse(), nextCursor: null, backwardsCursor: null });
let sequence = 0;
Object.assign(h.application, {
  clearSurfaceThread: (id: string) => h.bindings.delete(id),
  async forkSurfaceThread(id: string, source: string) {
    const threadId = `fork-${++sequence}`;
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
  const text = String((request.input[0] as { text: string }).text);
  const turnId = `turn-${++sequence}`;
  const itemId = `agent-${sequence}`;
  const turn: HistoryTurn = { id: turnId, status: "inProgress", itemsView: "full", error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null, items: [{ id: `user-${sequence}`, type: "userMessage", content: [{ type: "text", text }] }] };
  histories.set(threadId, [...(histories.get(threadId) ?? []), turn]);
  h.active.set(threadId, turnId); publish(threadId, "turn.started", { turnId });
  const progress = { id: `progress-${sequence}`, type: "agentMessage", phase: "commentary", text: "I’ll check the project first." };
  turn.items.push(progress);
  publish(threadId, "turn.message.completed", { itemId: progress.id, turnId, phase: progress.phase, text: progress.text });
  const response = "Let’s make it happen.\n\nI’ll keep the UI connected to the same shared core, with a clear path back to your conversation if the connection drops.\n\n```ts\nconst surface = \"web\";\n```";
  later(120, () => { if (h.active.get(threadId) === turnId) publish(threadId, "turn.stream.delta", { method: "item/agentMessage/delta", itemId, turnId, phase: "final_answer", textDelta: "Let’s make it happen." }); });
  later(650, () => {
    if (!h.active.get(threadId)) return;
    turn.items.push({ id: itemId, type: "agentMessage", phase: "final_answer", text: response });
    publish(threadId, "turn.message.completed", { itemId, turnId, phase: "final_answer", text: response });
    if (text.includes("parity")) {
      const tool = { id: `tool-${sequence}`, type: "commandExecution", command: "bun test", status: "failed" };
      turn.items.push(tool);
      publish(threadId, "turn.activity", { itemId: tool.id, turnId, kind: "command", label: "Running command", detail: tool.command, status: "failed" });
      const image = { id: `image-${sequence}`, type: "imageGeneration", status: "completed", savedPath: imagePath, revisedPrompt: "Fixture image" };
      turn.items.push(image);
      publish(threadId, "turn.image.generated", { itemId: image.id, turnId, path: imagePath, revisedPrompt: image.revisedPrompt });
      const final = { id: `final-${sequence}`, type: "agentMessage", phase: "final_answer", text: "Second final answer part." };
      turn.items.push(final);
      publish(threadId, "turn.message.completed", { itemId: final.id, turnId, phase: final.phase, text: final.text });
    }
    if (text.includes("approval")) {
      const approval = { approvalId: `approval-${sequence}`, method: "test", prompt: "Allow Shepherd to run the project’s test suite?", choices: [{ value: "accept", label: "Allow once" }, { value: "decline", label: "Decline" }], params: { command: "bun test", cwd: "~/project" } };
      h.approvals.create(approval, { threadId, sessionId: "fixture" });
      publish(threadId, "approval.requested", approval);
    } else finish(threadId);
  });
  return { ok: true, turnId };
};
Object.assign(h.application.conversation, {
  async rollbackThread(threadId: string, { numTurns }: { numTurns: number }) {
    histories.set(threadId, (histories.get(threadId) ?? []).slice(0, -numTurns));
    return { thread: { id: threadId } };
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
h.application.conversation.interruptTurn = async (threadId) => finish(threadId, "interrupted");
h.context.approvals.applyApprovalDecision = async (threadId, id, decision) => {
  h.approvals.markDecided(threadId, id, decision); h.approvals.markApplied(threadId, id);
  publish(threadId, "approval.applied", { approvalId: id }); finish(threadId);
};
const adapter = createWebAdapter(h.context, { ...h.config, port: Number(process.env.UI_TEST_PORT ?? 8799) });
await adapter.start();
console.log(adapter.url());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  for (const timer of timers) clearTimeout(timer);
  await adapter.stop(); h.api.dispose(); await rm(imageDir, { recursive: true, force: true }); process.exit(0);
});
