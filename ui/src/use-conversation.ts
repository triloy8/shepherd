import { useEffect, useRef, useState } from "react";
import type { ApprovalRecord } from "../../shared/protocol/approvals";
import type { WebConversation } from "../../shared/protocol/web";
import { api, ApiError, explainError, streamConversation } from "./api";
import { emptyChat, mergeHistory, reduceBridge, type ChatState } from "./chat-state";

export type Connection = "connecting" | "online" | "reconnecting" | "detached";
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal.addEventListener("abort", finish, { once: true });
  if (signal.aborted) finish();
});

export function useConversation(conversation: WebConversation | null) {
  const [chat, setChat] = useState<ChatState>(emptyChat);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const identity = useRef(conversation?.id);
  identity.current = conversation?.id;
  const actionRef = useRef(false);
  const historyEpoch = useRef(0);
  const historyRevision = useRef<number | null>(null);
  const historyExpanded = useRef(false);

  useEffect(() => {
    historyEpoch.current++; historyRevision.current = null;
    setChat(emptyChat()); setApprovals([]); setError(null); setHistoryCursor(null);
    setConnection("connecting"); setBusy(false); actionRef.current = false;
    setLoadingHistory(false); historyExpanded.current = false;
    if (!conversation) { refreshRef.current = async () => {}; return; }
    const id = conversation.id;
    const abort = new AbortController();
    let cursor: string | null = null;
    let transport: AbortController | undefined;
    const offline = () => { transport?.abort(); setConnection("reconnecting"); };
    window.addEventListener("offline", offline);
    let snapshot: Promise<void> | null = null;
    let refreshAgain = false;
    let turnRevision = 0;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const missing = (error: unknown) => {
      if (error instanceof ApiError && error.code === "conversation_not_found") {
        setConnection("detached"); setError(explainError(error)); abort.abort(); return true;
      }
      return false;
    };
    const refresh = (): Promise<void> => {
      if (snapshot) { refreshAgain = true; return snapshot; }
      return snapshot = (async () => {
        const revision = turnRevision;
        const epoch = historyEpoch.current;
        try {
          const [state, history, pending] = await Promise.all([
            api.state(id, abort.signal), api.history(id, undefined, abort.signal), api.approvals(id, abort.signal),
          ]);
          if (abort.signal.aborted) return;
          if (epoch !== historyEpoch.current) { refreshAgain = true; return; }
          const replaced = historyRevision.current !== null && historyRevision.current !== history.revision;
          if (replaced) { historyEpoch.current++; historyExpanded.current = false; setLoadingHistory(false); }
          historyRevision.current = history.revision;
          setChat((current) => ({ ...mergeHistory(replaced ? emptyChat() : current, history.data), activeTurnId: revision === turnRevision ? state.state.activeTurnId : current.activeTurnId }));
          setApprovals(pending.approvals.filter((approval) => approval.status === "pending"));
          if (!historyExpanded.current) setHistoryCursor(history.nextCursor);
        } catch (error) {
          if (!abort.signal.aborted) {
            if (error instanceof ApiError && error.code === "history_changed") refreshAgain = true;
            else if (!missing(error)) setError(explainError(error));
          }
        } finally {
          snapshot = null;
          if (refreshAgain && !abort.signal.aborted) { refreshAgain = false; void refresh(); }
        }
      })();
    };
    refreshRef.current = refresh;
    const soon = () => {
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => { void refresh(); }, 150);
    };
    void (async () => {
      let failures = 0;
      while (!abort.signal.aborted) {
        if (!navigator.onLine) { setConnection("reconnecting"); await delay(1000, abort.signal); continue; }
        transport = new AbortController();
        try {
          await streamConversation(id, cursor, AbortSignal.any([abort.signal, transport.signal]), () => {
            failures = 0; setConnection("online"); void refresh();
          }, (event) => {
            if (event.id) cursor = event.id;
            if (event.type === "bridge") {
              if (["turn.started", "turn.completed", "turn.failed"].includes(event.data.type)) turnRevision++;
              setChat((current) => reduceBridge(current, event.data));
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
          if (abort.signal.aborted || missing(error)) break;
          if (error instanceof ApiError && error.code === "event_cursor_expired") cursor = null;
          else if (error instanceof ApiError && error.status === 403) { setError(explainError(error)); setConnection("detached"); break; }
        }
        if (!abort.signal.aborted) { setConnection("reconnecting"); await delay(Math.min(1000 * 2 ** failures++, 10_000), abort.signal); }
      }
    })();
    const poll = setInterval(() => { if (!abort.signal.aborted) void refresh(); }, 15_000);
    return () => { abort.abort(); window.removeEventListener("offline", offline); clearInterval(poll); if (scheduled) clearTimeout(scheduled); };
  }, [conversation?.id]);

  async function action(operation: (id: string) => Promise<unknown>): Promise<boolean> {
    const id = conversation?.id;
    if (!id || actionRef.current || connection !== "online") return false;
    actionRef.current = true; setBusy(true); setError(null);
    try { await operation(id); if (identity.current === id) await refreshRef.current(); return identity.current === id; }
    catch (error) { if (identity.current === id) setError(explainError(error)); return false; }
    finally { if (identity.current === id) { actionRef.current = false; setBusy(false); } }
  }
  async function send(text: string, images: string[] = []) {
    const id = conversation?.id;
    const successful = await action(async (id) => {
      const response = await api.send(id, text, images);
      if (identity.current !== id) return;
      setChat((current) => ({ ...current, activeTurnId: response.turnId && !current.endedTurns.includes(response.turnId) ? response.turnId : current.activeTurnId, messages: [...current.messages, {
        id: `local:${crypto.randomUUID()}`, turnId: response.turnId ?? "", role: "user", text, attachments: images, complete: true,
      }] }));
    });
    if (!successful && identity.current === id) setError((current) => `${current ?? "Message not sent."} Your draft is kept. Check the conversation before sending again.`);
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
  return { chat, approvals, connection, error, busy, historyCursor, loadingHistory, send, loadOlder,
    interrupt: () => action((id) => api.interrupt(id)),
    decide: (approvalId: string, decision: string) => action((id) => api.decide(id, approvalId, decision)),
    refresh: () => refreshRef.current(),
  };
}
