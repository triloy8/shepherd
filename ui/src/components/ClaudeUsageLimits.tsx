import { useEffect, useRef, useState } from "react";
import type { ProviderAccountLimits } from "../../../shared/protocol/provider_account_limits";
import { api, explainError } from "../api";

const statuses = { available: "Available", warning: "Near limit", limited: "Limit reached" };
const dateLabel = (seconds: number) => new Date(seconds * 1000).toLocaleString();

export function ClaudeUsageLimits() {
  const [limits, setLimits] = useState<ProviderAccountLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useRef<(refresh: boolean) => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let abort: AbortController | null = null;
    async function load(refresh: boolean) {
      if (pending || disposed) return;
      pending = true; abort = new AbortController(); setLoading(true);
      try {
        const value = await api.claudeLimits(abort.signal, refresh);
        if (value.provider !== "claude") throw new Error("Claude returned an invalid account-limits response.");
        if (!disposed) { setLimits(value); setError(null); }
      } catch (error) { if (!disposed) setError(explainError(error)); }
      finally { pending = false; if (!disposed) setLoading(false); }
    }
    reload.current = refresh => { void load(refresh); };
    void load(false);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(false); }, 30_000);
    return () => { disposed = true; abort?.abort(); clearInterval(timer); reload.current = () => {}; };
  }, []);

  return <div id="claude-account-limits" role="tabpanel" aria-label="Claude limits">
    <p className="mb-5 text-xs text-muted">Shared across all conversations and other Claude apps using this account.</p>
    {loading && <p role="status" className="mb-3 text-xs text-muted">{limits ? "Refreshing Claude usage…" : "Loading Claude usage…"}</p>}
    {error && <p role="alert" className="notice">{error}{limits ? " Showing the last reported values." : ""}</p>}
    {limits && <>
      <dl className="settings-facts mb-5"><dt>Plan</dt><dd>{limits.account.plan ?? "Unknown"}</dd>
        <dt>Authentication</dt><dd>{limits.account.authentication === "subscription" ? "Claude subscription" : limits.account.authentication === "api" ? "API account" : limits.account.signedIn ? "Signed in" : limits.checkedAt === null ? "Not checked" : "Not signed in"}</dd>
        <dt>Last checked</dt><dd>{limits.checkedAt === null ? "Not checked yet" : dateLabel(limits.checkedAt)}</dd>
      </dl>
      {limits.message && <p role="status" className="mb-4 text-xs text-muted">{limits.message}</p>}
      {limits.windows.map(window => {
        const stale = Boolean(error) || window.stale || (window.resetsAt !== null && window.resetsAt <= Date.now() / 1000);
        return <section className="mb-5" key={window.id} aria-label={window.label}>
          <div className="mb-2 flex items-start justify-between gap-3 text-sm"><h3 className="font-medium">{window.label}</h3><span className="shrink-0 text-muted">{window.usedPercent === null ? "Not reported" : `${Number(window.usedPercent.toFixed(1))}% used`}</span></div>
          {window.usedPercent !== null && <div role="progressbar" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-valuetext={`${window.usedPercent}% used${stale ? ", last reported value" : ""}`} className="mb-2 h-1.5 overflow-hidden rounded-full bg-panel"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }} /></div>}
          <div className="space-y-1 text-xs text-muted">
            {window.status && <p>{stale ? "Last reported status: " : "Status: "}{statuses[window.status]}</p>}
            <p>Resets: {window.resetsAt === null ? "Not reported" : dateLabel(window.resetsAt)}</p>
            {(stale || limits.source === "events") && <p>{stale ? "Last reported value · " : "Reported · "}{dateLabel(window.observedAt)}{stale ? ". Refresh to check current usage." : ""}</p>}
          </div>
        </section>;
      })}
      {limits.extraUsage && <section className="mt-5 border-t border-line pt-4" aria-label="Claude extra usage"><h3 className="mb-2 text-sm font-medium">Extra usage</h3><div className="space-y-1 text-xs text-muted">
        <p>{limits.extraUsage.enabled === null ? "Availability not reported" : limits.extraUsage.enabled ? "Enabled" : "Disabled"}</p>
        {limits.extraUsage.usedPercent !== null && <p>{Number(limits.extraUsage.usedPercent.toFixed(1))}% of the extra usage allowance used</p>}
        {limits.extraUsage.active === true && <p>Extra usage was reported as in use.</p>}
        {limits.extraUsage.status && <p>Status: {statuses[limits.extraUsage.status]}</p>}
        {(error || limits.extraUsage.stale) && <p>Last reported · {dateLabel(limits.extraUsage.observedAt)}. Refresh to check current extra usage.</p>}
      </div></section>}
    </>}
    <div className="mt-5 flex flex-wrap items-center gap-3"><button className="button-secondary" disabled={loading} onClick={() => reload.current(true)}>Refresh usage</button><a className="text-xs text-muted underline" href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">View usage in Claude</a></div>
  </div>;
}
