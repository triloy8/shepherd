import { encodeApprovalButtonId } from "../server/adapters/discord/message_renderer";
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexSession } from "../server/providers/codex/session.js";
import { ApprovalsStore } from "../server/core/approvals";
import type { ApprovalRequestPayload, ApprovalRecord } from "../shared/protocol/approvals";
import type { BridgeEvent } from "../shared/protocol/events";
import { UserQuestions } from "../ui/src/components/UserQuestions";
import { webHarness } from "./helpers/web_harness";
import { parseUserQuestionRequest, validateUserQuestionAnswers } from "../shared/protocol/user_questions";

export const input = {
  threadId: "thread-1", turnId: "turn-1", itemId: "question-1", isBlocking: true,
  questions: [
    { id: "provider", header: "Provider", question: "How should users select the agent provider?", isOther: true, isSecret: false, options: [
      { label: "Select per conversation (Recommended)", description: "Keep Codex as the default and choose Claude when creating a conversation." },
      { label: "Set one provider for the entire server", description: "All conversations use the same provider." },
    ] },
    { id: "notes", header: "Notes", question: "Any other requirements?", isOther: true, isSecret: false, options: null },
  ],
};
const answers = { provider: { answers: [input.questions[0]!.options![0]!.label] }, notes: { answers: ["Remember my last choice."] } };
function sessionHarness() {
  const session = new CodexSession("never");
  session.threadId = input.threadId; session.activeTurnId = input.turnId;
  const raw = session as unknown as {
    writeLine: (payload: unknown) => void;
    onServerRequest: (request: { id: number; method: string; params: unknown }) => void;
    onNotification: (method: string, params: unknown) => void;
  };
  const writes: unknown[] = [];
  const events: BridgeEvent[] = [];
  raw.writeLine = p => writes.push(p);
  session.eventBus.subscribe(e => events.push(e), { replay: false });
  const store = new ApprovalsStore();
  raw.onServerRequest({ id: 7, method: "item/tool/requestUserInput", params: input });
  const request = events.find(e => e.type === "approval.requested")!.payload as ApprovalRequestPayload;
  const record = store.create(request, { threadId: input.threadId, sessionId: session.sessionId });
  return { session, raw, writes, events, request, record, store };
}

test("questions stay pending without a JSON-RPC response until the human submits", async () => {
  const h = sessionHarness();
  expect(h.writes).toEqual([]);
  expect(h.record.userInput).toEqual(input);
  expect(h.store.listPending()).toHaveLength(1);
  h.store.markDecided(input.threadId, h.request.approvalId, { decision: h.request.choices.find(choice => choice.intent === "answer")!.value, answers });
  await h.session.applyApprovalDecision(h.request.approvalId, { decision: h.request.choices.find(choice => choice.intent === "answer")!.value, answers });
  expect(h.writes).toEqual([{ id: 7, result: { answers } }]);
  await expect(h.session.applyApprovalDecision(h.request.approvalId, { decision: h.request.choices.find(choice => choice.intent === "answer")!.value, answers })).rejects.toThrow("Unknown approval");
});

test("missing, extra, empty and invalid choice answers leave questions pending for retry", () => {
  const h = sessionHarness();
  for (const invalid of [undefined, {}, { ...answers, extra: { answers: ["extra"] } }, { ...answers, notes: { answers: [""] } }]) {
    expect(() => h.store.markDecided(input.threadId, h.request.approvalId, { decision: h.request.choices.find(choice => choice.intent === "answer")!.value, answers: invalid })).toThrow();
    expect(h.store.listPending()).toHaveLength(1);
  }
  const restricted = structuredClone(h.record);
  restricted.approvalId = "restricted";
  restricted.userInput!.questions[0]!.isOther = false;
  h.store.create(restricted, { threadId: input.threadId, sessionId: h.session.sessionId });
  expect(() => h.store.markDecided(input.threadId, "restricted", { decision: h.request.choices.find(choice => choice.intent === "answer")!.value, answers: { ...answers, provider: { answers: ["Unknown provider"] } } })).toThrow("offered");
  expect(h.writes).toEqual([]);
});

test("explicit skip returns no answers, never the recommended choice", async () => {
  const h = sessionHarness();
  await h.session.applyApprovalDecision(h.request.approvalId, { decision: h.request.choices.find(choice => choice.intent === "cancel")!.value });
  expect(h.writes).toEqual([{ id: 7, result: { answers: {} } }]);
});

test("resolved or ended questions cannot send a stale response", async () => {
  for (const method of ["serverRequest/resolved", "turn/completed"]) {
    const h = sessionHarness();
    h.raw.onNotification(method, { threadId: input.threadId, requestId: 7, turn: { id: input.turnId, status: "completed" } });
    await expect(h.session.applyApprovalDecision(h.request.approvalId, { decision: h.request.choices.find(choice => choice.intent === "answer")!.value, answers })).rejects.toThrow("Unknown approval");
    expect(h.writes).toEqual([]);
    if (method === "serverRequest/resolved") expect(h.events.at(-1)?.type).toBe("approval.expired");
  }
});

test("invalid or foreign requests produce a protocol error and no question card", () => {
  const h = sessionHarness();
  const before = h.events.length;
  h.raw.onServerRequest({ id: 8, method: "item/tool/requestUserInput", params: { ...input, threadId: "other" } });
  h.raw.onServerRequest({ id: 9, method: "item/tool/requestUserInput", params: { ...input, questions: [null] } });
  expect(h.events).toHaveLength(before);
  expect(h.writes).toHaveLength(2);
  expect(h.writes[0]).toMatchObject({ id: 8, error: { code: -32602 } });
  expect(parseUserQuestionRequest({ ...input, isBlocking: undefined }).isBlocking).toBe(true);
});

test("web API accepts answers, rejects incomplete submissions and duplicate decisions", async () => {
  const h = webHarness();
  try {
    const c = await h.create();
    const request = sessionHarness().request;
    h.approvals.create({ ...request, userInput: { ...input, threadId: c.threadId } }, { threadId: c.threadId, sessionId: "session" });
    const path = `/conversations/${c.id}/approvals/${request.approvalId}`;
    expect((await h.request(path, "POST", { decision: request.choices.find(choice => choice.intent === "answer")!.value, answers: {} })).status).toBe(400);
    const pending = await (await h.request(`/conversations/${c.id}/approvals`)).json();
    expect(pending.approvals[0].status).toBe("pending");
    expect((await h.request(path, "POST", { decision: request.choices.find(choice => choice.intent === "answer")!.value, answers })).status).toBe(200);
    expect((await h.request(path, "POST", { decision: request.choices.find(choice => choice.intent === "answer")!.value, answers })).status).toBe(409);
  } finally { h.api.dispose(); }
});

test("UI renders accessible questions with no automatic choice and masks secret answers", () => {
  const h = sessionHarness();
  const render = (record: ApprovalRecord) => renderToStaticMarkup(createElement(UserQuestions, { request: record, busy: false, decide() {} }));
  const html = render(h.record);
  expect(html).toContain("Waiting for your answer");
  expect(html).toContain("Select per conversation");
  expect(html).toContain("Write another answer");
  expect(html).not.toContain('checked=""');
  expect(html).toContain('type="submit"');
  expect(html).toContain('disabled=""');
  h.record.userInput!.questions = [{ id: "token", header: "Token", question: "Enter token", isOther: true, isSecret: true, options: null }];
  expect(render(h.record)).toContain('type="password"');
  h.record.userInput!.isBlocking = false;
  expect(render(h.record)).toContain("while Shepherd continues working");
});

test("Discord answer buttons open a form without answering, then modal submission sends answers", async () => {
  const { handleInteraction, handleModalInteraction } = await import("../server/adapters/discord/interactions");
  const h = sessionHarness();
  const decisions: unknown[] = [];
  const conversation = {
    listApprovals: () => [h.record],
    async applyApprovalDecision(threadId: string, id: string, decision: unknown) { decisions.push(decision); },
  };
  let modal: { toJSON(): { components: unknown[] } } | undefined;
  const customId = encodeApprovalButtonId(input.threadId, h.request.approvalId, h.request.choices.find(choice => choice.intent === "answer")!.value);
  await handleInteraction({ customId, async showModal(value: typeof modal) { modal = value; } } as never, conversation as never);
  expect(modal!.toJSON().components).toHaveLength(2);
  expect(decisions).toEqual([]);
  const replies: unknown[] = [];
  await handleModalInteraction({ customId, fields: { getTextInputValue(id: string) { return id === "answer-0" ? answers.provider.answers[0] : answers.notes.answers[0]; } }, async reply(value: unknown) { replies.push(value); } } as never, conversation as never);
  expect(decisions).toEqual([{ decision: h.request.choices.find(choice => choice.intent === "answer")!.value, answers }]);
  expect(replies).toHaveLength(1);
});

test("Discord directs secret questions to masked fields in the web UI", async () => {
  const { handleInteraction } = await import("../server/adapters/discord/interactions");
  const h = sessionHarness();
  h.record.userInput!.questions[0]!.isSecret = true;
  let modal = false;
  let reply = false;
  await handleInteraction({ customId: encodeApprovalButtonId(input.threadId, h.request.approvalId, h.request.choices.find(choice => choice.intent === "answer")!.value), async showModal() { modal = true; }, async reply() { reply = true; } } as never,
    { listApprovals: () => [h.record] } as never);
  expect(modal).toBe(false);
  expect(reply).toBe(true);
});

test("waiting questions replace working and writing indicators in the timeline", async () => {
  const { Timeline } = await import("../ui/src/components/Timeline");
  const { emptyChat } = await import("../ui/src/chat-state");
  const chat = emptyChat();
  chat.activeTurnId = "turn-1";
  chat.messages = [{ id: "partial", turnId: "turn-1", role: "assistant", phase: "commentary", text: "I have a question", complete: false }];
  const html = renderToStaticMarkup(createElement(Timeline, { chat, waitingForAnswer: true }));
  expect(html).toContain("Waiting for your answer");
  expect(html).not.toContain("Writing…");
  expect(html).not.toContain("Working…");
});

test("SessionManager expires pending questions when the turn ends or the session stops", async () => {
  const { SessionManager } = await import("../server/core/session_manager");
  for (const end of ["turn", "stop"] as const) {
    let raw!: ReturnType<typeof sessionHarness>["raw"];
    const manager = new SessionManager(undefined, policy => {
      const session = new CodexSession(policy);
      session.threadId = input.threadId;
      session.activeTurnId = input.turnId;
      raw = session as unknown as typeof raw;
      raw.writeLine = () => {};
      session.startThread = async () => ({ threadId: input.threadId, reasoningEffort: null, model: "test", modelProvider: "openai", approvalPolicy: policy });
      return session;
    });
    try {
      await manager.createThread({ approvalPolicy: "never" });
      raw.onNotification("turn/started", { threadId: input.threadId, turn: { id: input.turnId } });
      raw.onServerRequest({ id: 7, method: "item/tool/requestUserInput", params: input });
      expect(manager.listApprovals(input.threadId)[0]?.status).toBe("pending");
      if (end === "turn") raw.onNotification("turn/completed", { threadId: input.threadId, turn: { id: input.turnId, status: "interrupted" } });
      else manager.stopAll();
      expect(manager.listApprovals(input.threadId)[0]?.status).toBe("expired");
    } finally { manager.stopAll(); }
  }
});

test("multiple-choice questions render checkboxes and validate several distinct answers", () => {
  const question = { id: "parts", header: "Parts", question: "Which parts?", isOther: false, isSecret: false, multiSelect: true, options: [{ label: "API", description: "Server" }, { label: "UI", description: "Browser" }] };
  validateUserQuestionAnswers([question], { parts: { answers: ["API", "UI"] } });
  expect(() => validateUserQuestionAnswers([question], { parts: { answers: ["API", "API"] } })).toThrow();
  expect(() => validateUserQuestionAnswers([question], { parts: { answers: ["other"] } })).toThrow();
  expect(() => validateUserQuestionAnswers([{ ...question, multiSelect: false }], { parts: { answers: ["API", "UI"] } })).toThrow();

});
