import { useEffect, useId, useRef, useState } from "react";
import type { WebConversation } from "../../../shared/protocol/web";
import { ConversationActions } from "./ConversationActions";
import { ConversationSettings } from "./ConversationSettings";
import { Icon } from "./Icon";

export function ConversationMenu({ conversation, title, status, disabled, active, activeTurnId, detaching, onHistoryChange, onRename, onArchive, onFork, onDetach }: {
  conversation: WebConversation; title: string; status: string; disabled: boolean; active: boolean; activeTurnId: string | null; detaching: boolean;
  onHistoryChange: () => Promise<void>; onRename: (name: string) => void; onArchive: () => void;
  onFork: (conversation: WebConversation) => void; onDetach: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"details" | "settings" | "actions" | null>(null);
  const menuId = useId();
  const firstFocus = useRef<"first" | "last">("first");
  const statusTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDialogElement>(null);
  function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
  function show(next: typeof panel) { returnFocus.current = document.activeElement === statusTrigger.current ? statusTrigger.current : trigger.current; close(); setPanel(next); }
  function closePanel() { setPanel(null); (returnFocus.current ?? trigger.current)?.focus(); }
  useEffect(() => {
    if (panel === "details") details.current?.showModal(); else details.current?.close();
  }, [panel]);
  useEffect(() => {
    if (!open) return;
    const items = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    (firstFocus.current === "last" ? items.at(-1) : items[0])?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <>
    <div role="status" aria-label={status} aria-live="polite" className="shrink-0">
      <button ref={statusTrigger} className="icon-button" aria-label={`Connection details: ${status}`} title={status} onClick={() => show("details")}>
        <span className={`status-dot ${status === "Working" ? "working-dot" : status === "Connected" ? "" : "status-dot-muted"}`} />
        <span className="sr-only">{status}</span>
      </button>
    </div>
    <div ref={root} className="relative shrink-0">
      <button ref={trigger} className="icon-button" aria-label="Conversation menu" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => { firstFocus.current = "first"; setOpen(!open); }}
        onKeyDown={(event) => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); firstFocus.current = event.key === "ArrowUp" ? "last" : "first"; setOpen(true); } }}><Icon name="more" /></button>
      {open && <div ref={menu} id={menuId} role="menu" aria-label="Conversation options" className="conversation-menu" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); close(true); return; }
        if (event.key === "Tab") { close(true); return; }
        const items = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
        if (next !== null) { event.preventDefault(); items[next]?.focus(); }
      }}>
        <button role="menuitem" tabIndex={-1} onClick={() => show("details")}><Icon name="folder" /><span>Conversation details</span></button>
        <button role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => show("settings")}><Icon name="settings" /><span>Conversation settings</span></button>
        <button role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => show("actions")}><Icon name="chat" /><span>Conversation actions</span></button>
        <div role="separator" className="my-1 border-t border-line" />
        <button role="menuitem" tabIndex={-1} disabled={detaching} onClick={() => { close(); onDetach(); }}><Icon name="detach" /><span>Detach conversation<span className="mt-0.5 block text-[11px] text-dim">Keep agent work running</span></span></button>
      </div>}
    </div>
    <dialog ref={details} className="project-dialog settings-dialog" aria-labelledby="conversation-details-title" onCancel={closePanel} onClose={() => { if (panel === "details") closePanel(); }}>
      <div className="mb-5 flex items-center justify-between gap-3"><h2 id="conversation-details-title" className="text-lg font-medium">Conversation details</h2><button className="icon-button" aria-label="Close conversation details" onClick={closePanel}><Icon name="close" /></button></div>
      <p className="mb-5 break-words text-sm font-medium">{title}</p>
      <dl className="space-y-4 text-sm"><div><dt className="mb-1 text-xs text-dim">Connection</dt><dd>{panel === "details" ? status : null}</dd></div><div><dt className="mb-1 text-xs text-dim">Project</dt><dd className="break-all">{conversation.project}</dd></div><div><dt className="mb-1 text-xs text-dim">Conversation ID</dt><dd className="break-all font-mono text-xs">{conversation.threadId}</dd></div></dl>
    </dialog>
    <ConversationActions conversation={conversation} title={title} disabled={disabled} active={active} open={panel === "actions"} onOpenChange={(value) => { if (!value) closePanel(); }} onHistoryChange={onHistoryChange} onRename={onRename} onArchive={onArchive} onFork={onFork} />
    <ConversationSettings id={conversation.id} activeTurnId={activeTurnId} disabled={disabled} open={panel === "settings"} onOpenChange={(value) => { if (!value) closePanel(); }} />
  </>;
}
