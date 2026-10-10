import { useEffect, useRef, useState } from "react";
import type { WebConversation } from "../../shared/protocol/web";
import type { BridgeEvent } from "../../shared/protocol/v2/events";
import type { ConversationInput } from "../../shared/protocol/v2/conversation_items";
import type { UserQuestionAnswers } from "../../shared/protocol/user_questions";
import { api, ApiError, explainError, streamNeutralConversation } from "./api";
import { recaptureNeutral, mergeNeutralHistory, neutralTimeline, reduceNeutralEvent, type NeutralChatState } from "./neutral-chat-state";

export type Connection = "connecting" | "online" | "reconnecting" | "detached";
const delay = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish();
});

/** The default chat consumes neutral records and core versions for every provider. */
export function useConversation(conversation: WebConversation | null) {
  const [model, setModel] = useState<NeutralChatState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null), [loadingHistory, setLoadingHistory] = useState(false);
  const historyCursorRef = useRef<string | null>(null);
  const [stateId, setStateId] = useState(conversation?.id);
  const identity = useRef(conversation?.id); identity.current = conversation?.id;
  const modelRef = useRef(model); modelRef.current = model;
  const actionLock = useRef(false), actionEpoch = useRef(0), historyEpoch = useRef(0);
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);

  useEffect(() => {
    const id = conversation?.id;
    actionEpoch.current++; historyEpoch.current++; actionLock.current = false;
    setStateId(id); setModel(null); modelRef.current = null; setBusy(false); setError(null); setHistoryCursor(null); historyCursorRef.current = null; setLoadingHistory(false); setConnection("connecting");
    if (!conversation || !id) { refreshRef.current = async () => false; return; }
    const abort = new AbortController(), current = () => !abort.signal.aborted && identity.current === id;
    let cursor: string | null = null, transport: AbortController | undefined;
    let state: NeutralChatState | null = null, pending: BridgeEvent[] = [], bufferedBytes = 0, overflow = false;
    let refreshing: Promise<boolean> | null = null;
    const publish = (next: NeutralChatState) => { if (current()) { state = next; modelRef.current = next; setModel(next); } };
    const missing = (failure: unknown) => {
      if (failure instanceof ApiError && failure.code === "conversation_not_found") { setConnection("detached"); setError(explainError(failure)); abort.abort(); return true; }
      return false;
    };
    const refresh = (): Promise<boolean> => {
      if (!current()) return Promise.resolve(false);
      if (refreshing) return refreshing;
      state = modelRef.current;
      setConnection(current => current === "detached" ? current : "reconnecting");
      const attached = transport;
      pending = []; bufferedBytes = 0; overflow = false; historyEpoch.current++;
      refreshing = (async () => {
        try {
          const snapshot = await api.snapshot(id, abort.signal), pages = [];
          let nextCursor = snapshot.itemsNextCursor;
          const seen = new Set<string>();
          while (nextCursor) {
            if (seen.has(nextCursor)) throw new Error("Snapshot pagination did not progress."); seen.add(nextCursor);
            const page = await api.snapshotItems(id, nextCursor, abort.signal); pages.push(page); nextCursor = page.nextCursor;
          }
          let next = recaptureNeutral(state, snapshot, pages);
          const retainedHistory = state?.epoch === next.epoch && state.historyRevision === next.historyRevision;
          const history = await api.items(id, undefined, abort.signal);
          next = mergeNeutralHistory(next, history);
          for (const event of pending) if (event.epoch !== next.epoch || event.sequence > snapshot.throughSequence) next = reduceNeutralEvent(next, event);
          if (!current()) return false;
          if (overflow || next.needsResync) { cursor = null; transport?.abort(); return false; }
          pending = []; bufferedBytes = 0;
          cursor = `${next.epoch}:${next.sequence}`;
          if (!retainedHistory) historyCursorRef.current = history.nextCursor;
          setHistoryCursor(historyCursorRef.current); publish(next); setError(null);
          if (attached && transport === attached && !attached.signal.aborted) setConnection("online");
          return true;
        } catch (failure) {
          if (current() && !missing(failure)) { setError(explainError(failure)); cursor = null; transport?.abort(); }
          return false;
        } finally { refreshing = null; }
      })();
      return refreshing;
    };
    refreshRef.current = refresh;
    const receive = (event: BridgeEvent) => {
      if (!current() || event.threadId !== conversation.threadId) return;
      if (refreshing || !state) {
        bufferedBytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
        if (bufferedBytes > 1.25 * 1024 * 1024) { overflow = true; cursor = null; transport?.abort(); return; }
        pending.push(event); return;
      }
      state = modelRef.current ?? state;
      const next = reduceNeutralEvent(state, event);
      publish(next);
      if (next.needsResync) { cursor = null; void refresh(); }
      else cursor = event.id;
    };
    const reconnect = () => { if (current()) { transport?.abort(); setConnection("reconnecting"); } };
    const visible = () => { if (current() && document.visibilityState === "visible" && navigator.onLine) void refresh(); };
    window.addEventListener("offline", reconnect); window.addEventListener("online", reconnect); document.addEventListener("visibilitychange", visible);
    void (async () => {
      let failures = 0;
      while (current()) {
        if (!navigator.onLine) { setConnection("reconnecting"); await delay(1000, abort.signal); continue; }
        transport = new AbortController();
        try {
          await streamNeutralConversation(id, cursor, AbortSignal.any([abort.signal, transport.signal]), () => {
            failures = 0;
            const attached = transport;
            void refresh().then(ok => { if (current() && ok && transport === attached && !attached?.signal.aborted) setConnection("online"); });
          }, receive);
        } catch (failure) {
          if (!current() || missing(failure)) break;
          if (failure instanceof ApiError && failure.code === "projection_resync_required") cursor = null;
          if (failure instanceof ApiError && failure.status === 403) { setConnection("detached"); setError(explainError(failure)); break; }
        }
        transport?.abort();
        if (current()) { setConnection("reconnecting"); await delay(Math.min(1000 * 2 ** failures++, 10_000), abort.signal); }
      }
    })();
    const poll = setInterval(visible, 60_000);
    return () => { abort.abort(); transport?.abort(); clearInterval(poll); window.removeEventListener("offline", reconnect); window.removeEventListener("online", reconnect); document.removeEventListener("visibilitychange", visible); };
  }, [conversation?.id]);

  async function action(operation: (id: string) => Promise<unknown>, refresh = true): Promise<boolean> {
    const id = conversation?.id, epoch = actionEpoch.current;
    if (!id || actionLock.current || connection !== "online") return false;
    const current = () => identity.current === id && actionEpoch.current === epoch;
    actionLock.current = true; setBusy(true); setError(null);
    try { await operation(id); if (refresh && current()) await refreshRef.current(); return current(); }
    catch (failure) { if (current()) setError(explainError(failure)); return false; }
    finally { if (current()) { actionLock.current = false; setBusy(false); } }
  }
  async function send(text: string, images: string[] = []) {
    const successful = await action(async id => {
      const input: ConversationInput = text.trim() ? [{ type: "text", text }] : [];
      for (const image of images) { const asset = await api.upload(id, image); input.push({ type: "asset", assetId: asset.id, media: "image" }); }
      await api.submit(id, input);
    }, false);
    if (!successful && identity.current === conversation?.id) setError(value => `${value ?? "Message not sent."} Your draft is kept. Check the conversation before sending again.`);
    return successful;
  }
  async function loadOlder() {
    const id = conversation?.id, cursor = historyCursor, epoch = historyEpoch.current;
    if (!id || !cursor || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const page = await api.items(id, cursor);
      if (identity.current !== id || historyEpoch.current !== epoch || !modelRef.current) return;
      const next = mergeNeutralHistory(modelRef.current, page);
      if (next.needsResync) await refreshRef.current(); else { modelRef.current = next; setModel(next); historyCursorRef.current = page.nextCursor; setHistoryCursor(page.nextCursor); }
    } catch (failure) { if (identity.current === id && historyEpoch.current === epoch) setError(explainError(failure)); }
    finally { if (identity.current === id) setLoadingHistory(false); }
  }
  const selected = stateId === conversation?.id, visible = selected ? model : null;
  const items = visible ? neutralTimeline(visible) : [];
  return { capabilities: visible?.capabilities, backgroundTaskCount: visible?.conversation.backgroundTaskCount ?? 0,
    chat: { activeTurnId: visible?.conversation.activeTurnId ?? null, items, endedTurns: visible?.endedTurns ?? [], activity: null, error: visible?.error ?? null },
    approvals: visible ? [...visible.interactions.values()] : [], connection: selected ? connection : "connecting" as Connection,
    error: selected ? error : null, busy: selected && busy, historyCursor: selected ? historyCursor : null, loadingHistory: selected && loadingHistory,
    send, loadOlder, interrupt: () => action(id => api.interrupt(id)),
    decide: (requestId: string, optionId: string, answers?: UserQuestionAnswers) => action(id => api.reply(id, requestId, optionId, answers)),
    revert: async (turnId: string) => { if (!await action(id => api.revert(id, turnId))) throw new Error("Revert failed."); },
    recoverHistory: async () => { if (!await refreshRef.current()) throw new Error("History recovery failed."); },
    refresh: async () => { await refreshRef.current(); },
  };
}
