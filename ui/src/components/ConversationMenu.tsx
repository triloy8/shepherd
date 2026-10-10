import type { AgentProvider } from "../../../shared/protocol/requests";
import type { ProviderCapabilities } from "../../../shared/protocol/provider_capabilities";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import type { WebConversation } from "../../../shared/protocol/web";
import { Icon } from "./Icon";
import { HostBattery } from "./HostBattery";
import { api, explainError } from "../api";

const ConversationActions = lazy(() => import("./ConversationActions").then((module) => ({ default: module.ConversationActions })));
const ConversationSkills = lazy(() => import("./ConversationSkills").then((module) => ({ default: module.ConversationSkills })));

export function ConversationMenu({ provider, capabilities, conversation, title, status, disabled, active, detaching, onHistoryChange, onRename, onArchive, onFork, onDetach }: {
  provider?: AgentProvider; capabilities?: ProviderCapabilities; conversation: WebConversation; title: string; status: string; disabled: boolean; active: boolean; detaching: boolean;
  onHistoryChange: () => Promise<void>; onRename: (name: string) => void; onArchive: () => void;
  onFork: (conversation: WebConversation) => void; onDetach: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"details" | "skills" | "rename" | "archive" | "compact" | null>(null);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const forkLock = useRef(false);
  const titleTrigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const firstFocus = useRef<"first" | "last">("first");
  const statusTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDialogElement>(null);
  const skills = useRef<HTMLDialogElement>(null);
  function close(focus = false) { setOpen(false); if (focus) trigger.current?.focus(); }
  function show(next: typeof panel) { returnFocus.current = document.activeElement === statusTrigger.current ? statusTrigger.current : document.activeElement === titleTrigger.current ? titleTrigger.current : trigger.current; close(); setPanel(next); }
  function closePanel() { setPanel(null); }
  useEffect(() => {
    if (panel === "details") details.current?.showModal(); else details.current?.close();
    if (panel === "skills") skills.current?.showModal(); else skills.current?.close();
    if (panel === null) { returnFocus.current?.focus(); returnFocus.current = null; }
  }, [panel]);
  useEffect(() => {
    if (!open) return;
    const items = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    (firstFocus.current === "last" ? items.at(-1) : items[0])?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  async function fork() {
    if (forkLock.current || disabled || active) return;
    forkLock.current = true; setForking(true); setForkError(null);
    try { onFork(await api.fork(conversation.id)); close(); }
    catch (error) { setForkError(`${explainError(error)} If the connection dropped, the fork may have succeeded. Refresh the conversation list before retrying.`); }
    finally { forkLock.current = false; setForking(false); }
  }
  return <>
    <div className="min-w-0 flex-1"><h1 aria-label={title} className="min-w-0 text-sm font-medium"><button ref={titleTrigger} className="block min-h-11 w-full truncate rounded-lg text-left hover:text-accent" title={`${title} — Rename conversation`} aria-label="Rename conversation" disabled={disabled || forking} onClick={() => show("rename")}>{title}</button></h1></div>
    <HostBattery />
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
        {capabilities?.skills && <button role="menuitem" tabIndex={-1} disabled={disabled || forking} onClick={() => show("skills")}><Icon name="skills" /><span>Skills</span></button>}
        {capabilities?.fork && <button role="menuitem" tabIndex={-1} disabled={disabled || active || forking} onClick={() => void fork()}><Icon name="fork" /><span>{forking ? "Forking conversation…" : "Fork conversation"}</span></button>}
        {capabilities?.compact && <button role="menuitem" tabIndex={-1} disabled={disabled || active || forking} onClick={() => show("compact")}><Icon name="compact" /><span>Compact conversation</span></button>}
        <div role="separator" className="my-1 border-t border-line" />
        <button role="menuitem" tabIndex={-1} disabled={detaching || forking} onClick={() => { close(); onDetach(); }}><Icon name="detach" /><span>Detach conversation<span className="mt-0.5 block text-[11px] text-dim">Keep agent work running</span></span></button>
        <button role="menuitem" tabIndex={-1} disabled={disabled || active || forking} onClick={() => show("archive")}><Icon name="archive" /><span>Archive conversation</span></button>
        {forkError && <p role="alert" className="notice mt-2">{forkError}</p>}
      </div>}
    </div>
    <dialog ref={details} className="project-dialog settings-dialog" aria-labelledby="conversation-details-title" onCancel={closePanel} onClose={() => { if (panel === "details") closePanel(); }}>
      <div className="mb-5 flex items-center justify-between gap-3"><h2 id="conversation-details-title" className="text-lg font-medium">Conversation details</h2><button className="icon-button" aria-label="Close conversation details" onClick={closePanel}><Icon name="close" /></button></div>
      <p className="mb-5 break-words text-sm font-medium">{title}</p>
      <dl className="space-y-4 text-sm">{provider && <div><dt className="mb-1 text-xs text-dim">Provider</dt><dd>{provider === "claude" ? "Claude" : "Codex"}</dd></div>}<div><dt className="mb-1 text-xs text-dim">Connection</dt><dd>{panel === "details" ? status : null}</dd></div><div><dt className="mb-1 text-xs text-dim">Project</dt><dd className="break-all">{conversation.project}</dd></div><div><dt className="mb-1 text-xs text-dim">Conversation ID</dt><dd className="break-all font-mono text-xs">{conversation.threadId}</dd></div></dl>
    </dialog>
    {(panel === "rename" || panel === "archive" || panel === "compact") && <Suspense fallback={null}><ConversationActions action={panel} conversation={conversation} title={title} disabled={disabled} active={active} onOpenChange={(value) => { if (!value) closePanel(); }} onHistoryChange={onHistoryChange} onRename={onRename} onArchive={onArchive} /></Suspense>}
    <dialog ref={skills} className="project-dialog settings-dialog" aria-labelledby="skills-title" onCancel={closePanel} onClose={() => { if (panel === "skills") closePanel(); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id="skills-title" className="text-lg font-medium">Skills</h2><button className="icon-button" aria-label="Close skills" onClick={closePanel}><Icon name="close" /></button></div>
      {panel === "skills" && <Suspense fallback={<p className="text-xs text-muted">Loading skills…</p>}><ConversationSkills id={conversation.id} disabled={disabled || forking} /></Suspense>}
    </dialog>
  </>;
}
