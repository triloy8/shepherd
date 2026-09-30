import { useEffect, useId, useRef, useState } from "react";
import type { ChatMessage } from "../chat-state";
import { ApiError, explainError } from "../api";
import { Icon } from "./Icon";

/** One confirmation per conversation; uncertainty survives closing and reopening. */
export function RevertDialog({ target, disabled, available, onClose, revert, reload }: {
  target: ChatMessage | null; disabled: boolean; available: boolean;
  onClose: () => void; revert: (turnId: string) => Promise<void>; reload: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (target) { setError(null); setNotice(null); dialog.current?.showModal(); cancelButton.current?.focus(); }
    else dialog.current?.close();
  }, [target]);
  async function run(recover = false) {
    if (lock.current || !target || (!recover && (disabled || !available || uncertain))) return;
    lock.current = true; setPending(true); setError(null);
    try {
      if (recover) { await reload(); setUncertain(false); onClose(); }
      else { await revert(target.turnId); setNotice("Conversation reverted. Files were not changed."); onClose(); }
    } catch (error) {
      // Validation/idle guards fail before mutation. Other failures can leave
      // the provider changed even though the browser never saw a response.
      if (!(error instanceof ApiError && [400, 403, 404, 409, 415].includes(error.status))) setUncertain(true);
      setError(explainError(error));
    } finally { lock.current = false; setPending(false); }
  }
  return <>
    {notice && <p role="status" className="mt-4 text-xs text-muted">{notice}</p>}
    <dialog ref={dialog} className="project-dialog max-h-[85dvh] overflow-y-auto" aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={(event) => { if (lock.current) event.preventDefault(); else onClose(); }}
      onClose={() => { if (!lock.current) onClose(); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id={titleId} className="text-lg font-medium">Revert conversation</h2><button className="icon-button" aria-label="Close revert confirmation" disabled={pending} onClick={onClose}><Icon name="close" /></button></div>
      <p className="mb-3 text-sm">Remove this turn and all later turns?</p>
      <blockquote className="mb-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line p-3 text-sm text-muted">{target?.text.slice(0, 1000) || "[Image message]"}{target && target.text.length > 1000 ? "…" : ""}</blockquote>
      <p id={descriptionId} className="mb-5 text-sm text-muted">This removes conversation history, including the selected message and its response. It does not undo file edits, commands, or other side effects. Fork the conversation first to keep a copy.</p>
      {!available && target && !pending && <p role="alert" className="notice mb-4">This turn is no longer in the displayed history. Reload the conversation and select a turn again.</p>}
      {disabled && !pending && <p className="mb-4 text-xs text-muted">Connect, stop the active turn, and resolve pending approvals before reverting.</p>}
      {uncertain && <p className="notice mb-4">The action may have succeeded. Reload and check the conversation before trying again.</p>}
      {error && <p role="alert" className="notice mb-4">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button ref={cancelButton} className="button-secondary" disabled={pending} onClick={onClose}>Cancel</button>
        <button className="button-primary" disabled={pending || disabled || !available || uncertain} onClick={() => void run()}>Confirm revert</button>
        {(uncertain || !available) && <button className="button-secondary" disabled={pending} onClick={() => void run(true)}>Reload conversation to check outcome</button>}
      </div>
      {pending && <p role="status" className="mt-4 text-xs text-muted">{uncertain ? "Reloading conversation…" : "Reverting conversation…"}</p>}
    </dialog>
  </>;
}
