import { useEffect, useRef, useState } from "react";
import type { WebConversation } from "../../../shared/protocol/web";
import { api, explainError } from "../api";
import { Icon } from "./Icon";

export function ConversationActions({ conversation, title, disabled, active, onHistoryChange, onRename, onArchive, onFork }: {
  conversation: WebConversation; title: string; disabled: boolean; active: boolean;
  onHistoryChange: () => Promise<void>;
  onRename: (name: string) => void; onArchive: () => void; onFork: (conversation: WebConversation) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(title);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [numTurns, setNumTurns] = useState("1");
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const count = Number(numTurns);
  const validCount = Number.isSafeInteger(count) && count > 0;
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  async function run(action: "rename" | "archive" | "fork" | "compact" | "rollback") {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice(null); setOperation(action);
    try {
      if (action === "rename") { await api.rename(conversation.id, name.trim()); onRename(name.trim()); }
      if (action === "archive") { await api.archive(conversation.id); onArchive(); }
      if (action === "fork") onFork(await api.fork(conversation.id));
      if (action === "compact" || action === "rollback") {
        if (action === "compact") await api.compact(conversation.id);
        else await api.rollback(conversation.id, count);
        await onHistoryChange();
        setConfirmRollback(false);
        setNotice(action === "compact" ? "Compaction started. Follow its activity in the conversation." : `Rolled back ${count} ${count === 1 ? "turn" : "turns"}. Files were not changed.`);
      } else setOpen(false);
    } catch (error) {
      if (action === "compact" || action === "rollback") setUncertain(true);
      setError(`${explainError(error)} If the connection dropped, the action may have succeeded. Reload and check the conversation before retrying.`);
    }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <button className="icon-button" aria-label="Conversation actions" disabled={disabled} onClick={() => { setName(title); setError(null); setConfirmArchive(false); setConfirmRollback(false); setNotice(null); setOpen(true); }}><Icon name="more" /></button>
    <dialog ref={dialog} className="project-dialog" aria-labelledby="actions-title" onCancel={(event) => { if (busy) event.preventDefault(); else setOpen(false); }} onClose={() => { if (!busy) setOpen(false); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id="actions-title" className="text-lg font-medium">Conversation actions</h2><button className="icon-button" aria-label="Close conversation actions" disabled={busy} onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      {confirmRollback ? <>
        <p className="mb-3 text-sm">Remove the last {count} {count === 1 ? "turn" : "turns"} from this conversation?</p>
        <p className="mb-5 text-sm text-muted">This removes conversation history. It does not undo file edits, commands, or other side effects. Fork first if you want to keep this history.</p>
        <div className="flex gap-2"><button className="button-secondary" disabled={busy} onClick={() => setConfirmRollback(false)}>Cancel rollback</button><button className="button-primary" disabled={busy || active || disabled || !validCount || uncertain} onClick={() => void run("rollback")}>Confirm rollback</button></div>
      </> : confirmArchive ? <><p className="mb-5 text-sm text-muted">Archive this conversation? It will leave the active list and detach from the web UI. You can restore it from Archived.</p><div className="flex gap-2"><button className="button-secondary" disabled={busy} onClick={() => setConfirmArchive(false)}>Cancel</button><button className="button-primary" disabled={busy || active || disabled} onClick={() => void run("archive")}>Confirm archive</button></div></> : <>
        <form onSubmit={(event) => { event.preventDefault(); void run("rename"); }}><label htmlFor="conversation-name" className="mb-2 block text-sm">Conversation name</label><input id="conversation-name" value={name} maxLength={200} required disabled={busy || disabled} onChange={(event) => setName(event.target.value)} /><button className="button-secondary mt-3" disabled={busy || disabled || !name.trim()}>Save name</button></form>
        <div className="mt-6 flex flex-wrap gap-2"><button className="button-secondary" disabled={busy || active || disabled} onClick={() => void run("fork")}>Fork conversation</button><button className="button-secondary" disabled={busy || active || disabled} onClick={() => setConfirmArchive(true)}>Archive conversation</button></div>
        <p className="mt-3 text-xs leading-6 text-muted">Fork creates a separate conversation from this history and switches to it. The original remains available.</p>
        <section className="mt-6 space-y-3 border-t border-line pt-4" aria-label="History controls">
          <button className="button-secondary" disabled={busy || active || disabled || uncertain} onClick={() => void run("compact")}>Compact conversation</button>
          <p className="text-xs text-muted">Reduce the context used by the conversation. Compaction runs asynchronously; watch its activity after starting.</p>
          <label className="block text-sm" htmlFor="rollback-count">Recent turns to remove</label><input id="rollback-count" type="number" min="1" step="1" max={Number.MAX_SAFE_INTEGER} value={numTurns} disabled={busy} onChange={(event) => setNumTurns(event.target.value)} />
          <button className="button-secondary" disabled={busy || active || disabled || !validCount || uncertain} onClick={() => setConfirmRollback(true)}>Roll back conversation</button>
        </section>
        {active && <p className="mt-2 text-xs text-muted">Stop the active turn and resolve approvals before archiving, forking, compacting, or rolling back.</p>}
      </>}
      {busy && <p role="status" className="mt-4 text-xs text-muted">{operation === "compact" ? "Starting compaction…" : operation === "rollback" ? "Rolling back conversation…" : "Updating conversation…"}</p>}
      {notice && <p role="status" className="mt-4 text-xs text-muted">{notice}</p>}
      {uncertain && <button className="button-secondary mt-4" disabled={busy} onClick={() => { setOpen(false); setUncertain(false); void onHistoryChange(); }}>Reload conversation to check outcome</button>}
      {error && <p role="alert" className="notice mt-4">{error}</p>}
    </dialog>
  </>;
}
