import { useEffect, useRef, useState } from "react";
import type { WebSettingsResponse, WebContextResponse, WebLimitsResponse } from "../../../shared/protocol/web";
import type { ModelSummary } from "../../../shared/protocol/requests";
import { api, explainError } from "../api";
import { Icon } from "./Icon";
import { AccountLimits, ContextUsage } from "./Usage";

export function ConversationSettings({ id, activeTurnId, disabled }: { id: string; activeTurnId: string | null; disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const [settings, setSettings] = useState<WebSettingsResponse | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const seenCursors = useRef(new Set<string>());
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [context, setContext] = useState<WebContextResponse | null>(null);
  const [limits, setLimits] = useState<WebLimitsResponse | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [paging, setPaging] = useState(false);
  const [saving, setSaving] = useState(false);
  const mutation = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => {
    generation.current++;
    if (!open) return;
    const abort = new AbortController();
    setLoading(true); setModels([]); setCursor(null); setPaging(false); setErrors({}); setContext(null); setLimits(null);
    seenCursors.current.clear();
    const fail = (key: string, error: unknown) => { if (!abort.signal.aborted) setErrors((current) => ({ ...current, [key]: explainError(error) })); };
    void Promise.allSettled([
      api.settings(id, abort.signal).then((value) => {
        if (abort.signal.aborted) return;
        setSettings(value); setModel(value.model.pendingModel ?? value.model.currentModel ?? value.effort.model);
        setEffort(value.effort.pendingEffort ?? value.effort.currentEffort ?? "default");
      }).catch((error) => { if (!abort.signal.aborted) setSettings(null); fail("settings", error); }),
      api.models(id, undefined, abort.signal).then((value) => { if (!abort.signal.aborted) { setModels(value.data); setCursor(value.nextCursor); } }).catch((error) => fail("models", error)),
    ]).then(() => { if (!abort.signal.aborted) setLoading(false); });
    void api.context(id, abort.signal).then((value) => { if (!abort.signal.aborted) setContext(value); }).catch((error) => fail("context", error));
    void api.limits(abort.signal).then((value) => { if (!abort.signal.aborted) setLimits(value); }).catch((error) => fail("limits", error));
    return () => abort.abort();
  }, [id, open, revision, activeTurnId]);

  async function loadMore() {
    if (!cursor || paging) return;
    const version = generation.current; const next = cursor;
    setPaging(true);
    try {
      const page = await api.models(id, next);
      if (version !== generation.current) return;
      seenCursors.current.add(next);
      setModels((current) => [...new Map([...current, ...page.data].map((model) => [model.model, model])).values()]);
      setCursor(page.nextCursor && !seenCursors.current.has(page.nextCursor) ? page.nextCursor : null);
    } catch (error) { if (version === generation.current) setErrors((current) => ({ ...current, models: explainError(error) })); }
    finally { if (version === generation.current) setPaging(false); }
  }
  async function save(kind: "model" | "effort") {
    if (mutation.current) return;
    mutation.current = true; setSaving(true); setNotice(null);
    setErrors((current) => { const { save, ...rest } = current; return rest; });
    try {
      if (kind === "model") await api.setModel(id, model); else await api.setEffort(id, effort);
      setNotice("Saved. Applies to the next new turn and subsequent turns.");
      setRevision((value) => value + 1);
    } catch (error) { setErrors((current) => ({ ...current, save: explainError(error) })); }
    finally { mutation.current = false; setSaving(false); }
  }
  const blocked = disabled || saving || loading;
  const effectiveModel = settings?.model.pendingModel ?? settings?.model.currentModel ?? settings?.effort.model;
  const supported = settings?.effort.supportedEfforts ?? [];
  const defaultSupported = supported.some((option) => option.reasoningEffort === settings?.effort.defaultEffort);
  return <>
    <button className="icon-button" aria-label="Conversation settings" disabled={disabled} onClick={() => setOpen(true)}><Icon name="settings" /></button>
    <dialog ref={dialog} className="project-dialog settings-dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="settings-title">
      <div className="mb-5 flex items-center justify-between"><h2 id="settings-title" className="text-lg font-medium">Conversation settings</h2><button className="icon-button" aria-label="Close settings" onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      <p className="mb-5 text-xs text-muted">Model and effort changes apply to the next new turn, including while a response is running.</p>
      {notice && <p role="status" className="mb-4 text-xs text-muted">{notice}</p>}
      {errors.save && <p role="alert" className="notice mb-4">{errors.save}</p>}
      <section className="space-y-3" aria-label="Model settings">
        <h3 className="text-sm font-medium">Model</h3>
        {settings && <dl className="settings-facts"><dt>Current</dt><dd>{settings.model.currentModel ?? "Default"}</dd><dt>Next turn</dt><dd>{settings.model.pendingModel ?? "Unchanged"}</dd></dl>}
        {errors.settings && <p role="alert" className="notice">{errors.settings}</p>}
        {errors.models && <p role="alert" className="notice">{errors.models}</p>}
        <label className="block text-xs text-muted">Model for next turn<select aria-label="Model for next turn" value={model} disabled={blocked} onChange={(event) => setModel(event.target.value)}>
          <option value="" disabled>{loading ? "Loading models…" : "Choose a model"}</option>
          {model && !models.some((item) => item.model === model) && <option value={model}>{model}</option>}
          {models.map((item) => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}
        </select></label>
        <div className="flex flex-wrap gap-2"><button className="button-secondary" disabled={blocked || !model || model === effectiveModel} onClick={() => void save("model")}>Use model</button>{cursor && <button className="button-secondary" disabled={blocked || paging} onClick={() => void loadMore()}>{paging ? "Loading…" : "More models"}</button>}</div>
      </section>
      <section className="mt-6 space-y-3" aria-label="Reasoning effort">
        <h3 className="text-sm font-medium">Reasoning effort</h3>
        {settings && <><p className="text-xs text-muted">Options for {settings.effort.model}. Apply a model change first to update these options.</p><dl className="settings-facts"><dt>Current</dt><dd>{settings.effort.currentEffort ?? "Unknown"}</dd><dt>Next turn</dt><dd>{settings.effort.pendingEffort ?? "Unchanged"}</dd><dt>Model default</dt><dd>{settings.effort.defaultEffort ?? "Unknown"}</dd></dl></>}
        <label className="block text-xs text-muted">Effort for next turn<select aria-label="Effort for next turn" value={effort} disabled={blocked || !settings || !supported.length || model !== effectiveModel} onChange={(event) => setEffort(event.target.value)}>
          <option value="" disabled>Choose effort</option>{effort && effort !== "default" && !supported.some((option) => option.reasoningEffort === effort) && <option value={effort} disabled>{effort} (not supported)</option>}{defaultSupported && <option value="default">Model default ({settings?.effort.defaultEffort})</option>}
          {supported.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
        </select></label>
        {settings?.effort.pendingEffort && !supported.some((option) => option.reasoningEffort === settings.effort.pendingEffort) && <p className="notice">The pending effort is not supported by the next model. Choose a supported effort before starting the next turn.</p>}
        {!supported.length && !loading && <p className="text-xs text-muted">No effort controls available for this model.</p>}
        <button className="button-secondary" disabled={blocked || !settings || !supported.length || model !== effectiveModel || !(effort === "default" ? defaultSupported : supported.some((option) => option.reasoningEffort === effort))} onClick={() => void save("effort")}>Use effort</button>
      </section>
      <details className="mt-6 border-t border-line pt-4"><summary className="cursor-pointer text-sm">Usage and account limits</summary><div className="mt-4 space-y-5">
        <section><h3 className="mb-2 text-sm">Conversation context</h3>{errors.context ? <p role="alert" className="notice">{errors.context}</p> : context ? <ContextUsage usage={context.tokenUsage} /> : <p className="text-xs text-muted">Loading context…</p>}</section>
        <section><h3 className="mb-2 text-sm">Account limits · shared across conversations</h3>{errors.limits ? <p role="alert" className="notice">{errors.limits}</p> : limits ? <AccountLimits value={limits.rateLimits} /> : <p className="text-xs text-muted">Loading limits…</p>}</section>
      </div></details>
      <button className="button-secondary mt-5" disabled={saving || loading} onClick={() => setRevision((value) => value + 1)}>Refresh settings and usage</button>
    </dialog>
  </>;
}
