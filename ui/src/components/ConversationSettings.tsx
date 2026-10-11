import { useEffect, useRef, useState } from "react";
import type { WebSettingsResponse } from "../../../shared/protocol/web";
import type { ModelSummary } from "../../../shared/protocol/requests";
import { api, explainError } from "../api";
import { Icon } from "./Icon";

export function ConversationSettings({ id, activeTurnId, disabled, open: controlledOpen, onOpenChange, onSaved }: { id: string; activeTurnId: string | null; disabled: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; onSaved?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const [settings, setSettings] = useState<WebSettingsResponse | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const seenCursors = useRef(new Set<string>());
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [paging, setPaging] = useState(false);
  const [saving, setSaving] = useState(false);
  const mutation = useRef(false);
  const edits = useRef({ model: 0, effort: 0 });
  const dirty = useRef({ model: false, effort: false });
  const session = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { session.current++; dirty.current = { model: false, effort: false }; setNotice(null); }, [id, open]);

  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true);
    setErrors((current) => { const { settings: _settings, ...rest } = current; return rest; });
    const fail = (key: string, error: unknown) => { if (!abort.signal.aborted) setErrors((current) => ({ ...current, [key]: explainError(error) })); };
    void api.settings(id, abort.signal).then((value) => {
        if (abort.signal.aborted) return;
        setSettings(value);
        if (!dirty.current.model) setModel(value.model.pendingModel ?? value.model.currentModel ?? value.effort.model);
        if (!dirty.current.effort) setEffort(value.effort.pendingEffort ?? value.effort.currentEffort ?? "default");
      }).catch((error) => { if (!abort.signal.aborted) setSettings(null); fail("settings", error); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [id, open, revision, activeTurnId]);

  useEffect(() => {
    generation.current++;
    if (!open) return;
    const abort = new AbortController();
    setModelsLoading(true); setModels([]); setCursor(null); setPaging(false);
    seenCursors.current.clear();
    setErrors((current) => { const { models: _models, ...rest } = current; return rest; });
    void api.models(id, undefined, abort.signal).then((value) => {
      if (!abort.signal.aborted) { setModels(value.data); setCursor(value.nextCursor); }
    }).catch((error) => { if (!abort.signal.aborted) setErrors((current) => ({ ...current, models: explainError(error) })); })
      .finally(() => { if (!abort.signal.aborted) setModelsLoading(false); });
    return () => abort.abort();
  }, [id, open, revision]);

  async function loadMore() {
    if (!cursor || paging) return;
    const version = generation.current; const next = cursor;
    setPaging(true);
    try {
      const page = await api.models(id, next);
      if (version !== generation.current) return;
      seenCursors.current.add(next);
      setModels((current) => [...new Map([...current, ...page.data].map((model) => [model.id, model])).values()]);
      setCursor(page.nextCursor && !seenCursors.current.has(page.nextCursor) ? page.nextCursor : null);
    } catch (error) { if (version === generation.current) setErrors((current) => ({ ...current, models: explainError(error) })); }
    finally { if (version === generation.current) setPaging(false); }
  }
  async function save(kind: "model" | "effort") {
    if (mutation.current) return;
    const version = session.current;
    const edit = edits.current[kind];
    mutation.current = true; setSaving(true); setNotice(null);
    setErrors((current) => { const { save, ...rest } = current; return rest; });
    try {
      if (kind === "model") await api.setModel(id, model); else await api.setEffort(id, effort);
      if (version !== session.current) return;
      if (edit === edits.current[kind]) dirty.current[kind] = false;
      onSaved?.();
      setNotice("Saved. Applies to the next new turn and subsequent turns.");
      setRevision((value) => value + 1);
    } catch (error) { if (version === session.current) setErrors((current) => ({ ...current, save: explainError(error) })); }
    finally { mutation.current = false; setSaving(false); }
  }
  const blocked = disabled || saving || loading || modelsLoading;
  const effectiveModel = settings?.model.pendingModel ?? settings?.model.currentModel ?? settings?.effort.model;
  const supported = settings?.effort.supportedEfforts ?? [];
  const defaultSupported = supported.some((option) => option.value === settings?.effort.defaultEffort);
  return <>
    {controlledOpen === undefined && <button className="icon-button" aria-label="Conversation settings" disabled={disabled} onClick={() => setOpen(true)}><Icon name="settings" /></button>}
    <dialog ref={dialog} className="project-dialog settings-dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="settings-title">
      <div className="mb-5 flex items-center justify-between"><h2 id="settings-title" className="text-lg font-medium">Model and effort</h2><button className="icon-button" aria-label="Close settings" onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      <p className="mb-5 text-xs text-muted">Model and effort changes apply to the next new turn, including while a response is running.</p>
      {notice && <p role="status" className="mb-4 text-xs text-muted">{notice}</p>}
      {errors.save && <p role="alert" className="notice mb-4">{errors.save}</p>}
      <section className="space-y-3" aria-label="Model settings">
        <h3 className="text-sm font-medium">Model</h3>
        {errors.settings && <p role="alert" className="notice">{errors.settings}</p>}
        {errors.models && <p role="alert" className="notice">{errors.models}</p>}
        <label className="block text-xs text-muted">Model for next turn<select aria-label="Model for next turn" value={model} disabled={blocked} onChange={(event) => { edits.current.model++; dirty.current.model = true; setModel(event.target.value); }}>
          <option value="" disabled>{modelsLoading ? "Loading models…" : "Choose a model"}</option>
          {model && !models.some((item) => item.id === model) && <option value={model}>{model}</option>}
          {models.map((item) => <option key={item.id} value={item.id}>{item.displayName || item.id}</option>)}
        </select></label>
        <div className="flex flex-wrap gap-2"><button className="button-secondary" disabled={blocked || !model || model === effectiveModel} onClick={() => void save("model")}>Use model</button>{cursor && <button className="button-secondary" disabled={blocked || paging} onClick={() => void loadMore()}>{paging ? "Loading…" : "More models"}</button>}</div>
      </section>
      <section className="mt-6 space-y-3" aria-label="Reasoning effort">
        <h3 className="text-sm font-medium">Reasoning effort</h3>
        {model !== effectiveModel && <p className="text-xs text-muted">Apply the model change first to see its effort options.</p>}
        <label className="block text-xs text-muted">Effort for next turn<select aria-label="Effort for next turn" value={effort} disabled={blocked || !settings || !supported.length || model !== effectiveModel} onChange={(event) => { edits.current.effort++; dirty.current.effort = true; setEffort(event.target.value); }}>
          <option value="" disabled>Choose effort</option>{effort && effort !== "default" && !supported.some((option) => option.value === effort) && <option value={effort} disabled>{effort} (not supported)</option>}{defaultSupported && <option value="default">Model default ({settings?.effort.defaultEffort})</option>}
          {supported.map((option) => <option key={option.value} value={option.value}>{option.value}</option>)}
        </select></label>
        {settings?.effort.pendingEffort && !supported.some((option) => option.value === settings.effort.pendingEffort) && <p className="notice">The pending effort is not supported by the next model. Choose a supported effort before starting the next turn.</p>}
        {!supported.length && !loading && <p className="text-xs text-muted">No effort controls available for this model.</p>}
        <button className="button-secondary" disabled={blocked || !settings || !supported.length || model !== effectiveModel || !(effort === "default" ? defaultSupported : supported.some((option) => option.value === effort))} onClick={() => void save("effort")}>Use effort</button>
      </section>
      {settings && <details className="mt-5 border-t border-line pt-4"><summary className="cursor-pointer text-xs text-muted">Current and pending values</summary><dl className="settings-facts mt-3"><dt>Current model</dt><dd>{settings.model.currentModel ?? "Default"}</dd><dt>Next model</dt><dd>{settings.model.pendingModel ?? "Unchanged"}</dd><dt>Current effort</dt><dd>{settings.effort.currentEffort ?? "Unknown"}</dd><dt>Next effort</dt><dd>{settings.effort.pendingEffort ?? "Unchanged"}</dd><dt>Default effort</dt><dd>{settings.effort.defaultEffort ?? "Unknown"}</dd></dl></details>}
      <button className="button-secondary mt-5" disabled={saving || loading} onClick={() => setRevision((value) => value + 1)}>Refresh settings</button>
    </dialog>
  </>;
}
