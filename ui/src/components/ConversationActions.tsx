import { useEffect, useRef, useState } from "react";
import type { WebConversation } from "../../../shared/protocol/web";
import { api, explainError } from "../api";
import { Icon } from "./Icon";

export function ConversationActions({ conversation, title, disabled, active, action, onHistoryChange, onRename, onArchive, onOpenChange }: {
  conversation: WebConversation; title: string; disabled: boolean; active: boolean;
  action: "rename" | "archive" | "compact"; onOpenChange: (open: boolean) => void;
  onHistoryChange: () => Promise<void>;
  onRename: (name: string) => void; onArchive: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const setOpen = onOpenChange;
  const heading = action === "rename" ? "Rename conversation" : action === "archive" ? "Archive conversation" : "Compact conversation";
  const [name, setName] = useState(title);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function run() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice(null); setOperation(action);
    try {
      if (action === "rename") { await api.rename(conversation.id, name.trim()); onRename(name.trim()); }
      if (action === "archive") { await api.archive(conversation.id); onArchive(); }
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
  return <dialog ref={dialog} className="project-dialog" aria-labelledby="actions-title" onCancel={(event) => { if (busy) event.preventDefault(); else setOpen(false); }} onClose={() => { if (!busy) setOpen(false); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id="actions-title" className="text-lg font-medium">{heading}</h2><button className="icon-button" aria-label={`Close ${heading.toLowerCase()}`} disabled={busy} onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      {action === "rename" ? <form onSubmit={(event) => { event.preventDefault(); void run(); }}><label htmlFor="conversation-name" className="mb-2 block text-sm">Conversation name</label><input id="conversation-name" value={name} maxLength={200} required disabled={busy || disabled} onChange={(event) => setName(event.target.value)} /><button className="button-primary mt-4" disabled={busy || disabled || !name.trim()}>Save name</button></form>
        : <>
          <p className="mb-5 text-sm leading-6 text-muted">{action === "archive" ? "Archive this conversation? It will leave the active list and detach from the web UI. You can restore it from Archived." : "Reduce the context used by this conversation. Compaction runs in the background; follow its activity in the conversation."}</p>
          <div className="flex gap-2"><button className="button-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button className="button-primary" disabled={busy || active || disabled || uncertain || !!notice} onClick={() => void run()}>{action === "archive" ? "Confirm archive" : "Compact conversation"}</button></div>
          {active && <p className="mt-3 text-xs text-muted">Stop the active turn and resolve approvals first.</p>}
        </>}
      {busy && <p role="status" className="mt-4 text-xs text-muted">{operation === "compact" ? "Starting compaction…" : "Updating conversation…"}</p>}
      {notice && <p role="status" className="mt-4 text-xs text-muted">{notice}</p>}
      {uncertain && <button className="button-secondary mt-4" disabled={busy} onClick={() => { setOpen(false); setUncertain(false); void onHistoryChange(); }}>Reload conversation to check outcome</button>}
      {error && <p role="alert" className="notice mt-4">{error}</p>}
    </dialog>;
}
