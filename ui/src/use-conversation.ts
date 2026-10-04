import { useEffect, useRef, useState } from "react";
import type { ApprovalRecord } from "../../shared/protocol/approvals";
import type { WebConversation } from "../../shared/protocol/web";
import { api, ApiError, explainError, streamConversation } from "./api";
import { acceptUserMessage, emptyChat, mergeHistory, reduceBridge, type ChatState } from "./chat-state";

export type Connection = "connecting" | "online" | "reconnecting" | "detached";
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal.addEventListener("abort", finish, { once: true });
  if (signal.aborted) finish();
});

export function useConversation(conversation: WebConversation | null) {
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [stateId, setStateId] = useState(conversation?.id);
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);
  const identity = useRef(conversation?.id);
  identity.current = conversation?.id;
  const actionRef = useRef(false);
  const actionEpoch = useRef(0);
  const historyEpoch = useRef(0);
  const historyRevision = useRef<number | null>(null);
  const historyExpanded = useRef(false);

  useEffect(() => {
    actionEpoch.current++;
    setStateId(conversation?.id);
    historyEpoch.current++; historyRevision.current = null;
    setChat(emptyChat()); setApprovals([]); setError(null); setHistoryCursor(null);
    setConnection("connecting"); setBusy(false); actionRef.current = false;
    setLoadingHistory(false); historyExpanded.current = false;
    if (!conversation) { refreshRef.current = async () => false; return; }
    const id = conversation.id;
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && identity.current === id;
    let cursor: string | null = null;
    let transport: AbortController | undefined;
    const offline = () => { if (!current()) return; transport?.abort(); setConnection("reconnecting"); };
    window.addEventListener("offline", offline);
    let snapshot: Promise<boolean> | null = null;
    let refreshAgain = false;
    let turnRevision = 0;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const missing = (error: unknown) => {
      if (!current()) return false;
      if (error instanceof ApiError && error.code === "conversation_not_found") {
        setConnection("detached"); setError(explainError(error)); abort.abort(); return true;
      }
      return false;
    };
    // A caller awaiting recovery must wait through stale snapshots too, rather
    // than returning while a replacement refresh is still running in the background.
    const refresh = (): Promise<boolean> => {
      if (!current()) return Promise.resolve(false);
      if (snapshot) { refreshAgain = true; return snapshot; }
      return snapshot = (async () => {
        let successful = false;
        try {
          do {
            refreshAgain = false;
            const revision = turnRevision;
            const epoch = historyEpoch.current;
            try {
              const [state, history, pending] = await Promise.all([
                api.state(id, abort.signal), api.history(id, undefined, abort.signal), api.approvals(id, abort.signal),
              ]);
              if (!current()) return false;
              if (epoch !== historyEpoch.current) { refreshAgain = true; continue; }
              const replaced = historyRevision.current !== null && historyRevision.current !== history.revision;
              if (replaced) { historyEpoch.current++; historyExpanded.current = false; setLoadingHistory(false); }
              historyRevision.current = history.revision;
              setChat((chat) => current() ? ({ ...mergeHistory(replaced ? emptyChat() : chat, history.data), activeTurnId: revision === turnRevision ? state.state.activeTurnId : chat.activeTurnId }) : chat);
              setApprovals(pending.approvals.filter((approval) => approval.status === "pending"));
              if (!historyExpanded.current) setHistoryCursor(history.nextCursor);
              successful = true;
            } catch (error) {
              successful = false;
              if (current()) {
                if (error instanceof ApiError && error.code === "history_changed") refreshAgain = true;
                else if (!missing(error)) setError(explainError(error));
              }
            }
          } while (refreshAgain && current());
          return successful;
        } finally { snapshot = null; }
      })();
    };
    refreshRef.current = refresh;
    const soon = () => {
      if (!current()) return;
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => { void refresh(); }, 150);
    };
    void (async () => {
      let failures = 0;
      while (current()) {
        if (!navigator.onLine) { setConnection("reconnecting"); await delay(1000, abort.signal); continue; }
        transport = new AbortController();
        try {
          await streamConversation(id, cursor, AbortSignal.any([abort.signal, transport.signal]), () => {
            if (!current()) return;
            failures = 0; setConnection("online"); void refresh();
          }, (event) => {
            if (!current()) return;
            if (event.type === "bridge" && event.data.threadId !== conversation.threadId) return;
            if (event.id) cursor = event.id;
            if (event.type === "bridge") {
              if (["turn.started", "turn.completed", "turn.failed"].includes(event.data.type)) turnRevision++;
              setChat((chat) => current() ? reduceBridge(chat, event.data) : chat);
              if (event.data.type.startsWith("approval.") || ["turn.started", "turn.completed", "turn.failed", "turn.message.completed"].includes(event.data.type)) soon();
            } else {
              if (event.type === "reset" && event.data.reason === "history_changed") {
                historyEpoch.current++; historyRevision.current = null; historyExpanded.current = false;
                setChat(emptyChat()); setHistoryCursor(null); setLoadingHistory(false);
              }
              soon();
            }
          });
        } catch (error) {
          if (!current() || missing(error)) break;
          if (error instanceof ApiError && error.code === "event_cursor_expired") cursor = null;
          else if (error instanceof ApiError && error.status === 403) { setError(explainError(error)); setConnection("detached"); break; }
        }
        if (current()) { setConnection("reconnecting"); await delay(Math.min(1000 * 2 ** failures++, 10_000), abort.signal); }
      }
    })();
    const poll = setInterval(() => { if (current()) void refresh(); }, 15_000);
    return () => { abort.abort(); window.removeEventListener("offline", offline); clearInterval(poll); if (scheduled) clearTimeout(scheduled); };
  }, [conversation?.id]);

  async function action(operation: (id: string) => Promise<unknown>, refresh = true): Promise<boolean> {
    const id = conversation?.id;
    if (!id || actionRef.current || connection !== "online") return false;
    const epoch = actionEpoch.current;
    const current = () => identity.current === id && actionEpoch.current === epoch;
    actionRef.current = true; setBusy(true); setError(null);
    try {
      await operation(id);
      if (refresh && current()) await refreshRef.current();
      return !refresh || current();
    }
    catch (error) { if (current()) setError(explainError(error)); return false; }
    finally { if (current()) { actionRef.current = false; setBusy(false); } }
  }
  async function send(text: string, images: string[] = []) {
    const id = conversation?.id;
    const epoch = actionEpoch.current;
    const current = () => identity.current === id && actionEpoch.current === epoch;
    const beforeSend = chatRef.current.messages;
    const successful = await action(async (id) => {
      const response = await api.send(id, text, images);
      if (!current()) return;
      setChat((state) => current() ? ({ ...acceptUserMessage(state, {
        id: `local:${crypto.randomUUID()}`, turnId: response.turnId ?? "", role: "user", text, attachments: images, complete: true,
      }, beforeSend), activeTurnId: response.turnId && !state.endedTurns.includes(response.turnId) ? response.turnId : state.activeTurnId }) : state);
    }, false);
    // Acceptance of the POST clears the submitted draft immediately. History
    // recovery can be slow or finish after the user selects another chat.
    if (successful && current()) void refreshRef.current();
    if (!successful && current()) setError((error) => `${error ?? "Message not sent."} Your draft is kept. Check the conversation before sending again.`);
    return successful;
  }
  async function loadOlder() {
    const id = conversation?.id;
    if (!id || !historyCursor || loadingHistory) return;
    const epoch = historyEpoch.current;
    setLoadingHistory(true); historyExpanded.current = true;
    try {
      const history = await api.history(id, historyCursor);
      if (identity.current !== id || epoch !== historyEpoch.current) return;
      if (historyRevision.current !== history.revision) { await refreshRef.current(); return; }
      setChat((current) => mergeHistory(current, history.data, true)); setHistoryCursor(history.nextCursor);
    } catch (error) { if (identity.current === id && epoch === historyEpoch.current) setError(explainError(error)); }
    finally { if (identity.current === id && epoch === historyEpoch.current) setLoadingHistory(false); }
  }
  // Selection renders before effect cleanup/reset; never show the previous
  // conversation's messages or enabled controls under the new chat's title.
  const selected = stateId === conversation?.id;
  return { chat: selected ? chat : emptyChat(), approvals: selected ? approvals : [], connection: selected ? connection : "connecting" as Connection,
    error: selected ? error : null, busy: selected && busy, historyCursor: selected ? historyCursor : null, loadingHistory: selected && loadingHistory, send, loadOlder,
    interrupt: () => action((id) => api.interrupt(id)),
    decide: (approvalId: string, decision: string) => action((id) => api.decide(id, approvalId, decision)),
    revert: async (beforeTurnId: string) => {
      const id = conversation?.id;
      if (!id || actionRef.current || connection !== "online" || chat.activeTurnId || approvals.length) {
        throw new ApiError(409, "conversation_active", "Wait until the conversation is connected, idle, and has no pending approvals.");
      }
      actionRef.current = true; setBusy(true); setError(null);
      try {
        await api.revert(id, beforeTurnId);
        if (identity.current !== id) return;
        // Also reset locally if the response arrives before the SSE notification.
        historyEpoch.current++; historyRevision.current = null; historyExpanded.current = false;
        setChat(emptyChat()); setHistoryCursor(null); setLoadingHistory(false);
        if (!await refreshRef.current()) throw new Error("History recovery failed.");
        setError(null);
      } finally { if (identity.current === id) { actionRef.current = false; setBusy(false); } }
    },
    recoverHistory: async () => {
      if (!await refreshRef.current()) throw new Error("History recovery failed.");
      setError(null);
    },
    refresh: async () => { await refreshRef.current(); },
  };
}
