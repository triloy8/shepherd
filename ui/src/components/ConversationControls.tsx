import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { WebConversation, WebContextResponse, WebSettingsResponse } from "../../../shared/protocol/web";
import { api, explainError } from "../api";
import { Icon } from "./Icon";
import { ContextUsage } from "./Usage";

const ConversationSettings = lazy(() => import("./ConversationSettings").then((module) => ({ default: module.ConversationSettings })));
const ConversationActions = lazy(() => import("./ConversationActions").then((module) => ({ default: module.ConversationActions })));

export function ConversationControls({ conversation, activeTurnId, disabled, active, onHistoryChange }: {
  conversation: WebConversation; activeTurnId: string | null; disabled: boolean; active: boolean; onHistoryChange: () => Promise<void>;
}) {
  const [panel, setPanel] = useState<"model" | "context" | "compact" | null>(null);
  const [settings, setSettings] = useState<WebSettingsResponse | null>(null);
  const [context, setContext] = useState<WebContextResponse | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const contextDialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const contextTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (disabled) return;
    const abort = new AbortController();
    setErrors({});
    void api.settings(conversation.id, abort.signal).then(value => { if (!abort.signal.aborted) setSettings(value); })
      .catch(error => { if (!abort.signal.aborted) { setSettings(null); setErrors(current => ({ ...current, settings: explainError(error) })); } });
    void api.context(conversation.id, abort.signal).then(value => { if (!abort.signal.aborted) setContext(value); })
      .catch(error => { if (!abort.signal.aborted) { setContext(null); setErrors(current => ({ ...current, context: explainError(error) })); } });
    return () => abort.abort();
  }, [conversation.id, activeTurnId, disabled, revision]);
  useEffect(() => {
    if (panel === "context") contextDialog.current?.showModal(); else contextDialog.current?.close();
    if (panel === null) { returnFocus.current?.focus(); returnFocus.current = null; }
  }, [panel]);
  function show(next: "model" | "context") {
    returnFocus.current = next === "model" ? modelTrigger.current : contextTrigger.current;
    setRevision(value => value + 1);
    setPanel(next);
  }
  function close() { setPanel(null); setRevision(value => value + 1); }
  const model = settings?.model.pendingModel ?? settings?.model.currentModel ?? settings?.effort.model;
  const effort = settings?.effort.pendingEffort ?? settings?.effort.currentEffort ?? settings?.effort.defaultEffort;
  const usage = context?.tokenUsage;
  const percent = usage && usage.modelContextWindow && usage.modelContextWindow > 0 ? Math.round(100 * usage.last.totalTokens / usage.modelContextWindow) : null;
  return <>
    <div className="mt-1 flex min-w-0 items-center justify-between gap-2" aria-label="Next turn controls">
      <button ref={modelTrigger} className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted hover:bg-panel hover:text-ink" aria-label="Model and effort" title={model ? `${model} · ${effort ?? "Default effort"} — applies to the next turn` : "Choose model and effort for the next turn"} disabled={disabled} onClick={() => show("model")}>
        <span className="truncate">{model ? `${model} · ${effort ?? "Default effort"}` : "Model and effort"}</span><Icon name="down" className="size-3" />
      </button>
      <button ref={contextTrigger} className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-dim hover:bg-panel hover:text-ink" aria-label="Conversation context" title="View context usage" disabled={disabled} onClick={() => show("context")}><Icon name="usage" className="size-3.5" /><span>{percent === null ? "Context" : `${percent}% context`}</span></button>
    </div>
    {panel === "model" && <Suspense fallback={null}><ConversationSettings id={conversation.id} activeTurnId={activeTurnId} disabled={disabled} open onOpenChange={value => { if (!value) close(); }} onSaved={() => setRevision(value => value + 1)} /></Suspense>}
    <dialog ref={contextDialog} className="project-dialog settings-dialog" aria-labelledby="context-title" onCancel={close} onClose={() => { if (panel === "context") close(); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id="context-title" className="text-lg font-medium">Conversation context</h2><button className="icon-button" aria-label="Close context" onClick={close}><Icon name="close" /></button></div>
      {errors.context ? <p role="alert" className="notice">{errors.context}</p> : context ? <ContextUsage usage={context.tokenUsage} /> : <p className="text-xs text-muted">Loading context…</p>}
      <div className="mt-5 flex flex-wrap gap-2"><button className="button-secondary" disabled={disabled || active} onClick={() => setPanel("compact")}>Compact conversation</button><button className="button-secondary" disabled={disabled} onClick={() => setRevision(value => value + 1)}>Refresh context</button></div>
      {active && <p className="mt-3 text-xs text-muted">Compaction is available after the current turn and approvals finish.</p>}
    </dialog>
    {panel === "compact" && <Suspense fallback={null}><ConversationActions action="compact" conversation={conversation} title="" disabled={disabled} active={active} onOpenChange={value => { if (!value) close(); }} onHistoryChange={onHistoryChange} onRename={() => {}} onArchive={() => {}} /></Suspense>}
  </>;
}
