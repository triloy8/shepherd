import { createPortal } from "react-dom";
import { readAccountReset, writeAccountReset, type PendingAccountReset } from "../account-reset-state";
import { useEffect, useRef, useState } from "react";
import type { ProviderDescriptor } from "../../../shared/protocol/v2/conversations";
import type { ProviderAccountLimits } from "../../../shared/protocol/v2/account_limits";
import { api, explainError } from "../api";
import { Icon } from "./Icon";

export function UsageLimits({ defaultProvider, onOpen, onClosed }: { defaultProvider?: string; onOpen?: () => void; onClosed?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false), [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [provider, setProvider] = useState(defaultProvider ?? ""), [limits, setLimits] = useState<ProviderAccountLimits | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAccountReset | null>(() => readAccountReset(defaultProvider ?? ""));
  const [revision, setRevision] = useState(0);
  const pendingMemory = useRef(new Map<string, PendingAccountReset>());
  const lock = useRef(false), generation = useRef(0);
  useEffect(() => { generation.current++; }, [open, provider]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void api.providers(abort.signal).then(value => { if (!abort.signal.aborted) { setProviders(value.providers); setProvider(current => value.providers.find(entry => pendingMemory.current.has(entry.id) || readAccountReset(entry.id))?.id || value.providers.find(entry => entry.id === defaultProvider)?.id || value.providers.find(entry => entry.id === current)?.id || value.providers[0]?.id || ""); } }).catch(failure => { if (!abort.signal.aborted) setError(explainError(failure)); });
    return () => abort.abort();
  }, [open]);
  useEffect(() => {
    if (!open || !provider) return;
    const abort = new AbortController(); setPending(pendingMemory.current.get(provider) ?? readAccountReset(provider)); setBusy(true); setError(null); setLimits(null); setNotice(null);
    void api.account(provider, abort.signal, revision > 0).then(value => { if (!abort.signal.aborted) setLimits(value); }).catch(failure => { if (!abort.signal.aborted) setError(explainError(failure)); }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [open, provider, revision]);
  async function reset(creditId?: string) {
    if (lock.current || busy || !providers.some(entry => entry.id === provider && entry.capabilities.resets) || (!pending && (!limits?.resets.supported || limits.resets.availableCount === 0))) return;
    const version = generation.current;
    const selected = provider;
    const input = pending ?? { idempotencyKey: crypto.randomUUID(), ...(creditId ? { creditId } : {}) };
    setPending(input); pendingMemory.current.set(selected, input); writeAccountReset(selected, input);
    lock.current = true; setBusy(true); setError(null);
    try {
      const result = await api.resetAccount(selected, input);
      writeAccountReset(selected, null); pendingMemory.current.delete(selected);
      if (version !== generation.current) return;
      setPending(null);
      setNotice({ reset: "Reset used.", already_redeemed: "This reset was already used.", nothing_to_reset: "No usage window is eligible for a reset.", no_credit: "No resets are available." }[result.outcome]);
      try { const next = await api.account(selected); if (version === generation.current) setLimits(next); }
      catch (failure) { if (version === generation.current) setError(`${explainError(failure)} The reset outcome above is recorded; refresh usage to read the allowances.`); }
    } catch (failure) { if (version === generation.current) setError(`${explainError(failure)} Retry to check the same request.`); }
    finally { lock.current = false; if (version === generation.current) setBusy(false); }
  }
  const close = () => { setOpen(false); onClosed?.(); trigger.current?.focus(); };
  return <><button ref={trigger} className="sidebar-control" aria-label="Usage & limits" onClick={() => { setOpen(true); onOpen?.(); }}><Icon name="usage" />Usage</button>
    {typeof document !== "undefined" && createPortal(<dialog ref={dialog} className="project-dialog settings-dialog" onCancel={close} onClose={() => setOpen(false)} aria-labelledby="limits-title">
      <div className="mb-5 flex items-center justify-between"><h2 id="limits-title" className="text-lg font-medium">Account usage</h2><button className="icon-button" aria-label="Close usage" onClick={close}><Icon name="close" /></button></div>
      <label className="block text-xs text-muted">Agent<select value={provider} disabled={lock.current} onChange={event => setProvider(event.target.value)}>{providers.map(entry => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}</select></label>
      {busy && <p role="status" className="mt-4 text-sm text-muted">Loading…</p>}{error && <p role="alert" className="notice mt-4">{error}</p>}{notice && <p role="status" className="mt-4 text-sm text-muted">{notice}</p>}
      {pending && <button className="button-secondary mt-4" disabled={busy} onClick={() => void reset()}>Check unresolved reset request</button>}
      {limits && <div className="mt-5 space-y-4">
        <p className="text-xs text-muted">{limits.account.plan ?? limits.account.authentication}{limits.stale ? " · Last known data" : ""}</p>
        {limits.message && <p className="text-sm text-muted">{limits.message.text}</p>}
        {limits.windows.map(window => <section key={window.id} className="rounded-lg border border-line p-3"><p className="text-sm">{window.label}{window.subtitle ? ` · ${window.subtitle}` : ""}</p><p className="mt-2 text-xs text-muted">{window.usedPercent === null ? "Usage unavailable" : `${window.usedPercent.toFixed(0)}% used`}{window.stale ? " · Last known data" : ""}</p>{window.usedPercent !== null && <progress className="mt-2 w-full" max={100} value={window.usedPercent} />}{window.resetsAt && <p className="mt-2 text-xs text-muted">Resets {new Date(window.resetsAt * 1000).toLocaleString()}</p>}</section>)}
        {limits.extraUsage && <p className="text-xs text-muted">Extra usage: {limits.extraUsage.unlimited ? "Unlimited" : limits.extraUsage.balanceLabel ?? (limits.extraUsage.enabled === null ? "Unknown" : limits.extraUsage.enabled ? "Enabled" : "Disabled")}</p>}
        {limits.spendControls.map(control => <p key={control.id} className="text-xs text-muted">{control.label}: {control.usedLabel ?? "Unknown"} / {control.limitLabel ?? "Unknown"}</p>)}
        {limits.resets.supported && <section className="space-y-2"><p className="text-sm">Available resets: {limits.resets.availableCount ?? "Unknown"}</p>{limits.resets.credits?.map(credit => <div key={credit.id}><p className="text-xs text-muted">{credit.title ?? "Usage reset"}{credit.description ? ` · ${credit.description.text}` : ""}</p><button className="button-secondary" disabled={busy || !!pending || !credit.supported || credit.status !== "available" || (credit.expiresAt !== null && credit.expiresAt <= Date.now() / 1000)} onClick={() => void reset(credit.id)}>Use reset</button></div>)}<button className="button-secondary" disabled={busy || !!pending || limits.resets.availableCount === 0} onClick={() => void reset()}>Use available reset</button></section>}
      </div>}
      <button className="button-secondary mt-5" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh usage</button>
    </dialog>, document.body)}</>;
}
