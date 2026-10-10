import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { WebLimitsResponse, WebResetRequest } from "../../../shared/protocol/web";
import type { AgentProvider, ModelSummary, RateLimitResetCredit } from "../../../shared/protocol/requests";
import { usageTitle } from "../usage-title";
import { api, explainError } from "../api";
import { Icon } from "./Icon";
import { AccountLimits } from "./Usage";
import { ClaudeUsageLimits } from "./ClaudeUsageLimits";

const pendingKey = "shepherd.usage-reset";
function readPending(): WebResetRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    if (typeof value?.idempotencyKey !== "string" || !value.idempotencyKey.trim()) return null;
    if (value.creditId !== undefined && (typeof value.creditId !== "string" || !value.creditId.trim())) return null;
    return { idempotencyKey: value.idempotencyKey, ...(value.creditId ? { creditId: value.creditId } : {}) };
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

function expiredCredit(credit: RateLimitResetCredit): boolean {
  return credit.expiresAt !== null && credit.expiresAt <= Date.now() / 1000;
}
function usableCredit(credit: RateLimitResetCredit): boolean {
  return credit.status === "available" && credit.resetType === "codexRateLimits"
    && !expiredCredit(credit);
}

export function UsageLimits({ defaultProvider = "codex", onOpen, onClosed }: { defaultProvider?: AgentProvider; onOpen?: () => void; onClosed?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<AgentProvider>(defaultProvider);
  const [models, setModels] = useState<ModelSummary[]>([]);
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
    if (!open || provider !== "codex") return;
    const abort = new AbortController();
    setLoading(true); setLimits(null); setError(null);
    void api.limits(abort.signal).then((value) => { if (!abort.signal.aborted) setLimits(value); })
      .catch((error) => { if (!abort.signal.aborted) setError(explainError(error)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [open, provider, revision]);

  useEffect(() => {
    if (!open || provider !== "codex") return;
    const abort = new AbortController();
    setModels([]);
    async function loadModels() {
      let cursor: string | undefined;
      const seen = new Set<string>();
      const catalog: ModelSummary[] = [];
      do {
        const page = await api.accountModels(cursor, abort.signal);
        if (abort.signal.aborted) return;
        catalog.push(...page.data);
        setModels([...catalog]);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) return;
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    // Catalog metadata is optional: usage and redemption remain available if it fails.
    void loadModels().catch(() => {});
    return () => abort.abort();
  }, [open, provider, revision]);

  async function useReset(creditId?: string) {
    if (lock.current || loading || (!pending && !limits?.rateLimitResetCredits?.availableCount)) return;
    if (!pending && creditId && !limits?.rateLimitResetCredits?.credits?.some((credit) => credit.id === creditId && usableCredit(credit))) return;
    lock.current = true; setSending(true); setResetError(null); setNotice(null);
    try {
      const request = pending ?? { idempotencyKey: crypto.randomUUID(), ...(creditId ? { creditId } : {}) };
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
  const hasUnlistedResets = Boolean(resets && (resets.credits === null || resets.availableCount > resets.credits.length));
  return <>
    <button ref={trigger} className="sidebar-control" aria-label="Usage & limits" onClick={() => { onOpen?.(); setProvider(pending ? "codex" : defaultProvider); setOpen(true); }}><Icon name="usage" /><span>Usage & limits</span><Icon name="chevron" className="ml-auto size-3.5" /></button>
    {typeof document !== "undefined" && createPortal(<dialog ref={dialog} className="project-dialog settings-dialog" aria-labelledby="usage-title"
      onCancel={(event) => { if (lock.current) event.preventDefault(); else setOpen(false); }}
      onClose={() => { setOpen(false); if (onClosed) onClosed(); else trigger.current?.focus(); }}>
      <div className="mb-5 flex items-center justify-between"><h2 id="usage-title" className="text-lg font-medium">Usage & limits</h2><button className="icon-button" aria-label="Close usage & limits" disabled={sending} onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      <div role="tablist" aria-label="Usage provider" className="mb-5 flex gap-2">{(["codex", "claude"] as const).map(value => <button key={value} role="tab" tabIndex={provider === value ? 0 : -1} aria-selected={provider === value} aria-controls={`${value}-account-limits`} disabled={sending} className={provider === value ? "button-primary" : "button-secondary"} onClick={() => setProvider(value)} onKeyDown={event => {
        const next = event.key === "Home" ? "codex" : event.key === "End" ? "claude" : ["ArrowLeft", "ArrowRight"].includes(event.key) ? value === "codex" ? "claude" : "codex" : null;
        if (!next) return;
        event.preventDefault(); setProvider(next);
        const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
        tabs?.[next === "codex" ? 0 : 1]?.focus();
      }}>{value === "codex" ? "Codex" : "Claude"}</button>)}</div>
      {open && provider === "claude" && <ClaudeUsageLimits />}
      {provider === "codex" && <div id="codex-account-limits" role="tabpanel" aria-label="Codex limits">
      <p className="mb-5 text-xs text-muted">Shared across all conversations using this Codex account.</p>
      {loading && <p role="status" className="text-xs text-muted">Loading usage…</p>}
      {error && <p role="alert" className="notice">{error}</p>}
      {notice && <p role="status" className="mb-4 text-sm text-muted">{notice}</p>}
      {buckets.map(([id, value]) => {
        const { title, subtitle } = usageTitle(id, value, models);
        return <section className="mb-5" key={id}><h3 className="mb-2 text-sm font-medium">{title}</h3>{subtitle && <p className="mb-2 text-xs text-muted">{subtitle}</p>}<AccountLimits value={value} /></section>;
      })}
      <section className="mt-5 border-t border-line pt-4" aria-label="Banked resets">
        <h3 className="mb-2 text-sm font-medium">Banked resets{resets ? ` · ${resets.availableCount.toLocaleString()} available` : ""}</h3>
        {!loading && !error && !resets && <p className="text-xs text-muted">Banked reset information is unavailable.</p>}
        {resets && <>
          {resets.credits === null ? <p className="text-xs text-muted">Expiration details are unavailable.</p> : <ul className="space-y-3 text-xs text-muted">{resets.credits.map((credit) => <li key={credit.id}>
            <p className="text-ink">{credit.title ?? "Usage reset"} · {expiredCredit(credit) ? "expired" : credit.status}</p>
            {credit.description && <p>{credit.description}</p>}
            <p>Granted: {dateLabel(credit.grantedAt)}</p><p>{credit.expiresAt === null ? "Does not expire" : `Expires: ${dateLabel(credit.expiresAt)}`}</p>
            <button className="button-secondary mt-2" disabled={sending || loading || Boolean(pending) || !resets.availableCount || !usableCredit(credit)} onClick={() => void useReset(credit.id)}>Use this reset</button>
          </li>)}</ul>}
          {resets.credits && resets.availableCount > resets.credits.length && <p className="mt-2 text-xs text-muted">Details are available for {resets.credits.length} of {resets.availableCount} resets.</p>}
          <p className="mt-3 text-xs text-muted">Using a reset spends one banked reset on eligible account usage windows.</p>
        </>}
        {pending && !sending && <p className="mt-3 text-xs text-muted">A previous reset request has an unknown outcome. Retry checks the same request.</p>}
        {resetError && <p role="alert" className="notice mt-3">{resetError}</p>}
        {sending && <p role="status" className="mt-3 text-xs text-muted">Using reset…</p>}
        {(pending || hasUnlistedResets) && <>
          {!pending && <p className="mt-3 text-xs text-muted">Codex chooses the next available reset when no specific reset is selected.</p>}
          <button className="button-primary mt-3" disabled={sending || loading || (!pending && !resets?.availableCount)} onClick={() => void useReset()}>{pending ? "Retry reset" : "Use next available reset"}</button>
        </>}
      </section>
      <button className="button-secondary mt-5" disabled={loading || sending} onClick={() => setRevision((value) => value + 1)}>Refresh usage</button>
      </div>}
    </dialog>, document.body)}
  </>;
}
