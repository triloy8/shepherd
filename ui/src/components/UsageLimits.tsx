import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { WebLimitsResponse, WebResetRequest } from "../../../shared/protocol/web";
import { api, explainError } from "../api";
import { Icon } from "./Icon";
import { AccountLimits } from "./Usage";

const pendingKey = "shepherd.usage-reset";
function readPending(): WebResetRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    return typeof value?.idempotencyKey === "string" && value.idempotencyKey.trim() ? { idempotencyKey: value.idempotencyKey } : null;
  } catch { return null; }
}
const outcomeMessage = {
  reset: "Reset used.",
  alreadyRedeemed: "This reset was already used.",
  nothingToReset: "No usage window is eligible for a reset right now.",
  noCredit: "No banked resets are available.",
};
function dateLabel(seconds: number) {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
}

export function UsageLimits({ onOpen, onClosed }: { onOpen?: () => void; onClosed?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [limits, setLimits] = useState<WebLimitsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(readPending);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  function track(value: WebResetRequest | null) {
    setPending(value);
    try { if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); } catch { /* Storage is optional. */ }
  }
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true); setLimits(null); setError(null);
    void api.limits(abort.signal).then((value) => { if (!abort.signal.aborted) setLimits(value); })
      .catch((error) => { if (!abort.signal.aborted) setError(explainError(error)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [open, revision]);

  async function useReset() {
    if (lock.current || loading || (!pending && !limits?.rateLimitResetCredits?.availableCount)) return;
    lock.current = true; setSending(true); setResetError(null); setNotice(null);
    try {
      const request = pending ?? { idempotencyKey: crypto.randomUUID() };
      track(request);
      const result = await api.consumeReset(request);
      track(null);
      // Read again after every known outcome; never infer new usage percentages.
      setNotice(outcomeMessage[result.outcome]);
      setRevision((value) => value + 1);
    } catch (error) {
      setResetError(`${explainError(error)} The outcome may be unknown. Retry uses the same reset request.`);
    } finally { lock.current = false; setSending(false); }
  }
  const resets = limits?.rateLimitResetCredits;
  const buckets = limits?.rateLimitsByLimitId && Object.keys(limits.rateLimitsByLimitId).length
    ? Object.entries(limits.rateLimitsByLimitId) : limits ? [["codex", limits.rateLimits] as const] : [];
  return <>
    <button ref={trigger} className="sidebar-control" aria-label="Usage & limits" onClick={() => { onOpen?.(); setOpen(true); }}><Icon name="usage" /><span>Usage & limits</span><Icon name="chevron" className="ml-auto size-3.5" /></button>
    {typeof document !== "undefined" && createPortal(<dialog ref={dialog} className="project-dialog settings-dialog" aria-labelledby="usage-title"
      onCancel={(event) => { if (lock.current) event.preventDefault(); else setOpen(false); }}
      onClose={() => { setOpen(false); if (onClosed) onClosed(); else trigger.current?.focus(); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id="usage-title" className="text-lg font-medium">Usage & limits</h2><button className="icon-button" aria-label="Close usage & limits" disabled={sending} onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      <p className="mb-5 text-xs text-muted">Shared across all conversations using this Codex account.</p>
      {loading && <p role="status" className="text-xs text-muted">Loading usage…</p>}
      {error && <p role="alert" className="notice">{error}</p>}
      {notice && <p role="status" className="mb-4 text-sm text-muted">{notice}</p>}
      {buckets.map(([id, value]) => <section className="mb-5" key={id}><h3 className="mb-2 text-sm font-medium">{id}</h3><AccountLimits value={value} /></section>)}
      <section className="mt-5 border-t border-line pt-4" aria-label="Banked resets">
        <h3 className="mb-2 text-sm font-medium">Banked resets{resets ? ` · ${resets.availableCount.toLocaleString()} available` : ""}</h3>
        {!loading && !error && !resets && <p className="text-xs text-muted">Banked reset information is unavailable.</p>}
        {resets && <>
          {resets.credits === null ? <p className="text-xs text-muted">Expiration details are unavailable.</p> : <ul className="space-y-3 text-xs text-muted">{resets.credits.map((credit) => <li key={credit.id}>
            <p className="text-ink">{credit.title ?? "Usage reset"} · {credit.status}</p>
            {credit.description && <p>{credit.description}</p>}
            <p>Granted: {dateLabel(credit.grantedAt)}</p><p>{credit.expiresAt === null ? "Does not expire" : `Expires: ${dateLabel(credit.expiresAt)}`}</p>
          </li>)}</ul>}
          {resets.credits && resets.availableCount > resets.credits.length && <p className="mt-2 text-xs text-muted">Details are available for {resets.credits.length} of {resets.availableCount} resets.</p>}
          <p className="mt-3 text-xs text-muted">Using a reset spends one banked reset on eligible account usage windows.</p>
        </>}
        {pending && !sending && <p className="mt-3 text-xs text-muted">A previous reset request has an unknown outcome. Retry checks the same request.</p>}
        {resetError && <p role="alert" className="notice mt-3">{resetError}</p>}
        <button className="button-primary mt-3" disabled={sending || loading || (!pending && !resets?.availableCount)} onClick={() => void useReset()}>{sending ? "Using reset…" : pending ? "Retry reset" : "Use reset"}</button>
      </section>
      <button className="button-secondary mt-5" disabled={loading || sending} onClick={() => setRevision((value) => value + 1)}>Refresh usage</button>
    </dialog>, document.body)}
  </>;
}
