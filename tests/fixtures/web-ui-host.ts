// Local browser-test fixture. Never imported by production entrypoints.
import { createWebAdapter } from "../../server/adapters/web/server.js";
import { webHarness } from "../helpers/web_harness.js";
import type { HistoryTurn, StoredThreadSummary } from "../../shared/protocol/requests.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";

const h = webHarness();
const histories = new Map<string, HistoryTurn[]>([["stored", [{ id: "past", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1000, items: [
  { id: "question", type: "userMessage", content: [{ type: "text", text: "Where did we leave off?" }] },
  { id: "answer", type: "agentMessage", text: "The shared API is ready. Next, we’re building a **private workspace** for conversations, live responses, and approvals.\n\nEverything runs in the same Shepherd host." },
] }]]]);
const stored = (): StoredThreadSummary[] => [...histories.entries()].map(([threadId, turns]) => ({ threadId, name: threadId === "stored" ? "A new home for Shepherd" : null, preview: String((turns[0]?.items[0]?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "New conversation"), archived: false, cwd: "~", createdAt: 1, updatedAt: 2, source: "appServer" }));
h.application.conversation.listStoredThreads = async () => ({ threads: stored(), nextCursor: null, backwardsCursor: null });
h.application.conversation.listThreadTurns = async (threadId) => ({ data: [...(histories.get(threadId) ?? [])].reverse(), nextCursor: null, backwardsCursor: null });
let sequence = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
const publish = (threadId: string, type: BridgeEvent["type"], payload: unknown) => {
  const id = [...h.bindings].find(([, thread]) => thread === threadId)?.[0];
  if (id) h.publish(id, { id: `fixture-${++sequence}`, type, threadId, sessionId: "fixture", ts: new Date().toISOString(), payload });
};
function later(ms: number, run: () => void) { const timer = setTimeout(() => { timers.delete(timer); run(); }, ms); timers.add(timer); }
function finish(threadId: string) {
  const history = histories.get(threadId)!;
  const turn = history.at(-1)!;
  turn.status = "completed";
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
  const response = "Let’s make it happen.\n\nI’ll keep the UI connected to the same shared core, with a clear path back to your conversation if the connection drops.\n\n```ts\nconst surface = \"web\";\n```";
  later(120, () => { if (h.active.get(threadId) === turnId) publish(threadId, "turn.stream.delta", { method: "item/agentMessage/delta", itemId, turnId, textDelta: "Let’s make it happen." }); });
  later(650, () => {
    if (!h.active.get(threadId)) return;
    turn.items.push({ id: itemId, type: "agentMessage", text: response });
    publish(threadId, "turn.message.completed", { itemId, turnId, text: response });
    if (text.includes("approval")) {
      const approval = { approvalId: `approval-${sequence}`, method: "test", prompt: "Allow Shepherd to run the project’s test suite?", choices: [{ value: "accept", label: "Allow once" }, { value: "decline", label: "Decline" }], params: { command: "bun test", cwd: "~/project" } };
      h.approvals.create(approval, { threadId, sessionId: "fixture" });
      publish(threadId, "approval.requested", approval);
    } else finish(threadId);
  });
  return { ok: true, turnId };
};
h.application.conversation.interruptTurn = async (threadId) => finish(threadId);
h.context.approvals.applyApprovalDecision = async (threadId, id, decision) => {
  h.approvals.markDecided(threadId, id, decision); h.approvals.markApplied(threadId, id);
  publish(threadId, "approval.applied", { approvalId: id }); finish(threadId);
};
const adapter = createWebAdapter(h.context, { ...h.config, port: Number(process.env.UI_TEST_PORT ?? 8799) });
await adapter.start();
console.log(adapter.url());
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  for (const timer of timers) clearTimeout(timer);
  await adapter.stop(); h.api.dispose(); process.exit(0);
});
