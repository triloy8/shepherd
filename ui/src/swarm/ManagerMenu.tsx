import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import type { ProviderCapabilities } from "../../../shared/protocol/provider_capabilities";
import type { WebConversation } from "../../../shared/protocol/web";
import { Icon } from "../components/Icon";

const ConversationSkills = lazy(() => import("../components/ConversationSkills").then(module => ({ default: module.ConversationSkills })));
const ConversationActions = lazy(() => import("../components/ConversationActions").then(module => ({ default: module.ConversationActions })));

export function ManagerMenu({ conversation, capabilities, disabled, active, onHistoryChange }: {
  conversation: WebConversation; capabilities: ProviderCapabilities | null; disabled: boolean; active: boolean;
  onHistoryChange: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"skills" | "compact" | null>(null);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const skills = useRef<HTMLDialogElement>(null);
  const menuId = useId(), skillsId = useId();
  const returnFocus = useRef(false), lastItem = useRef(false);
  function closePanel() { setPanel(null); }
  function show(next: typeof panel) { returnFocus.current = true; setOpen(false); setPanel(next); }
  useEffect(() => {
    if (panel === "skills") skills.current?.showModal(); else skills.current?.close();
    if (panel === null && returnFocus.current) { trigger.current?.focus(); returnFocus.current = false; }
  }, [panel]);
  useEffect(() => {
    if (!open) return;
    const items = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    (lastItem.current ? items.at(-1) : items[0])?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <>
    <div ref={root} className="swarm-conversation-actions" onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); } }}>
      <button ref={trigger} className="icon-button" aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => { lastItem.current = false; setOpen(!open); }} onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); lastItem.current = event.key === "ArrowUp"; setOpen(true); }
        }}><Icon name="more" /></button>
      {open && <div ref={menu} id={menuId} role="menu" aria-label="Manager options" className="swarm-action-panel" onKeyDown={event => {
        if (event.key === "Tab") { setOpen(false); return; }
        const items = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
        if (next !== null) { event.preventDefault(); items[next]?.focus(); }
      }}>
        <button role="menuitem" tabIndex={-1} disabled={disabled || !capabilities?.skills} title={!capabilities?.skills ? "Skill controls are unavailable for this manager" : undefined} onClick={() => show("skills")}><Icon name="skills" /><span>Manager skills</span></button>
        <button role="menuitem" tabIndex={-1} disabled={disabled || active || !capabilities?.compact} title={!capabilities?.compact ? "Compaction is unavailable for this manager" : active ? "Wait for the manager to finish and resolve approvals first" : undefined} onClick={() => show("compact")}><Icon name="compact" /><span>Compact manager conversation</span></button>
      </div>}
    </div>
    <dialog ref={skills} className="project-dialog settings-dialog" aria-labelledby={skillsId} onCancel={closePanel} onClose={() => { if (panel === "skills") closePanel(); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id={skillsId} className="text-lg font-medium">Manager skills</h2><button className="icon-button" aria-label="Close manager skills" onClick={closePanel}><Icon name="close" /></button></div>
      {panel === "skills" && <Suspense fallback={<p className="text-xs text-muted">Loading skills…</p>}><ConversationSkills id={conversation.id} disabled={disabled} configSupported={capabilities?.skillConfig === true} /></Suspense>}
    </dialog>
    {panel === "compact" && <Suspense fallback={null}><ConversationActions action="compact" conversation={conversation} title="Manager conversation" disabled={disabled} active={active} onHistoryChange={onHistoryChange} onOpenChange={value => { if (!value) closePanel(); }} onRename={() => {}} onArchive={() => {}} /></Suspense>}
  </>;
}
