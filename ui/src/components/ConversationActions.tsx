import { useEffect, useRef, useState } from "react";
import type { WebConversation } from "../../../shared/protocol/web";
import { api, explainError } from "../api";
import { Icon } from "./Icon";

export function ConversationActions({ conversation, title, disabled, active, onHistoryChange, onRename, onArchive, onFork, open: controlledOpen, onOpenChange }: {
  conversation: WebConversation; title: string; disabled: boolean; active: boolean;
  open?: boolean; onOpenChange?: (open: boolean) => void;
  onHistoryChange: () => Promise<void>;
  onRename: (name: string) => void; onArchive: () => void; onFork: (conversation: WebConversation) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [name, setName] = useState(title);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setName(title); setError(null); setConfirmArchive(false); setNotice(null); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [open]);
  async function run(action: "rename" | "archive" | "fork" | "compact") {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice(null); setOperation(action);
    try {
      if (action === "rename") { await api.rename(conversation.id, name.trim()); onRename(name.trim()); }
      if (action === "archive") { await api.archive(conversation.id); onArchive(); }
      if (action === "fork") onFork(await api.fork(conversation.id));
      if (action === "compact") {
        await api.compact(conversation.id);
        await onHistoryChange();
        setNotice("Compaction started. Follow its activity in the conversation.");
      } else setOpen(false);
    } catch (error) {
      if (action === "compact") setUncertain(true);
      setError(`${explainError(error)} If the connection dropped, the action may have succeeded. Reload and check the conversation before retrying.`);
    }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    {controlledOpen === undefined && <button className="icon-button" aria-label="Conversation actions" disabled={disabled} onClick={() => setOpen(true)}><Icon name="more" /></button>}
    <dialog ref={dialog} className="project-dialog" aria-labelledby="actions-title" onCancel={(event) => { if (busy) event.preventDefault(); else setOpen(false); }} onClose={() => { if (!busy) setOpen(false); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id="actions-title" className="text-lg font-medium">Conversation actions</h2><button className="icon-button" aria-label="Close conversation actions" disabled={busy} onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      {confirmArchive ? <><p className="mb-5 text-sm text-muted">Archive this conversation? It will leave the active list and detach from the web UI. You can restore it from Archived.</p><div className="flex gap-2"><button className="button-secondary" disabled={busy} onClick={() => setConfirmArchive(false)}>Cancel</button><button className="button-primary" disabled={busy || active || disabled} onClick={() => void run("archive")}>Confirm archive</button></div></> : <>
        <form onSubmit={(event) => { event.preventDefault(); void run("rename"); }}><label htmlFor="conversation-name" className="mb-2 block text-sm">Conversation name</label><input id="conversation-name" value={name} maxLength={200} required disabled={busy || disabled} onChange={(event) => setName(event.target.value)} /><button className="button-secondary mt-3" disabled={busy || disabled || !name.trim()}>Save name</button></form>
        <div className="mt-6 flex flex-wrap gap-2"><button className="button-secondary" disabled={busy || active || disabled} onClick={() => void run("fork")}>Fork conversation</button><button className="button-secondary" disabled={busy || active || disabled} onClick={() => setConfirmArchive(true)}>Archive conversation</button></div>
        <p className="mt-3 text-xs leading-6 text-muted">Fork creates a separate conversation from this history and switches to it. The original remains available.</p>
        <section className="mt-6 space-y-3 border-t border-line pt-4" aria-label="History controls">
          <button className="button-secondary" disabled={busy || active || disabled || uncertain} onClick={() => void run("compact")}>Compact conversation</button>
          <p className="text-xs text-muted">Reduce the context used by the conversation. Compaction runs asynchronously; watch its activity after starting.</p>
        </section>
        {active && <p className="mt-2 text-xs text-muted">Stop the active turn and resolve approvals before archiving, forking, or compacting.</p>}
      </>}
      {busy && <p role="status" className="mt-4 text-xs text-muted">{operation === "compact" ? "Starting compaction…" : "Updating conversation…"}</p>}
      {notice && <p role="status" className="mt-4 text-xs text-muted">{notice}</p>}
      {uncertain && <button className="button-secondary mt-4" disabled={busy} onClick={() => { setOpen(false); setUncertain(false); void onHistoryChange(); }}>Reload conversation to check outcome</button>}
      {error && <p role="alert" className="notice mt-4">{error}</p>}
    </dialog>
  </>;
}
