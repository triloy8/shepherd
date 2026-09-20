import { useEffect, useRef, useState } from "react";
import type { WebConversation } from "../../../shared/protocol/web";
import { api, explainError } from "../api";
import { Icon } from "./Icon";

export function ConversationActions({ conversation, title, disabled, active, onRename, onArchive, onFork }: {
  conversation: WebConversation; title: string; disabled: boolean; active: boolean;
  onRename: (name: string) => void; onArchive: () => void; onFork: (conversation: WebConversation) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(title);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  async function run(action: "rename" | "archive" | "fork") {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      if (action === "rename") { await api.rename(conversation.id, name.trim()); onRename(name.trim()); }
      if (action === "archive") { await api.archive(conversation.id); onArchive(); }
      if (action === "fork") onFork(await api.fork(conversation.id));
      setOpen(false);
    } catch (error) { setError(`${explainError(error)} Refresh the conversation list before retrying if the connection dropped.`); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <button className="icon-button" aria-label="Conversation actions" disabled={disabled} onClick={() => { setName(title); setError(null); setConfirmArchive(false); setOpen(true); }}><Icon name="more" /></button>
    <dialog ref={dialog} className="project-dialog" aria-labelledby="actions-title" onCancel={(event) => { if (busy) event.preventDefault(); else setOpen(false); }} onClose={() => { if (!busy) setOpen(false); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id="actions-title" className="text-lg font-medium">Conversation actions</h2><button className="icon-button" aria-label="Close conversation actions" disabled={busy} onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      {confirmArchive ? <><p className="mb-5 text-sm text-muted">Archive this conversation? It will leave the active list and detach from the web UI. You can restore it from Archived.</p><div className="flex gap-2"><button className="button-secondary" disabled={busy} onClick={() => setConfirmArchive(false)}>Cancel</button><button className="button-primary" disabled={busy || active || disabled} onClick={() => void run("archive")}>Confirm archive</button></div></> : <>
        <form onSubmit={(event) => { event.preventDefault(); void run("rename"); }}><label htmlFor="conversation-name" className="mb-2 block text-sm">Conversation name</label><input id="conversation-name" value={name} maxLength={200} required disabled={busy || disabled} onChange={(event) => setName(event.target.value)} /><button className="button-secondary mt-3" disabled={busy || disabled || !name.trim()}>Save name</button></form>
        <div className="mt-6 flex flex-wrap gap-2"><button className="button-secondary" disabled={busy || active || disabled} onClick={() => void run("fork")}>Fork conversation</button><button className="button-secondary" disabled={busy || active || disabled} onClick={() => setConfirmArchive(true)}>Archive conversation</button></div>
        <p className="mt-3 text-xs leading-6 text-muted">Fork creates a separate conversation from this history and switches to it. The original remains available.</p>
        {active && <p className="mt-2 text-xs text-muted">Stop the active turn and resolve approvals before archiving or forking.</p>}
      </>}
      {busy && <p role="status" className="mt-4 text-xs text-muted">Updating conversation…</p>}
      {error && <p role="alert" className="notice mt-4">{error}</p>}
    </dialog>
  </>;
}
