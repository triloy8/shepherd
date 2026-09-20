import { useEffect, useRef, useState } from "react";
import type { WebHistoryItem, WebHistoryPage } from "../../../shared/protocol/web";
import { api, ApiError, explainError } from "../api";
import { GeneratedImage } from "./GeneratedImage";

type Navigation = { turnId?: string; cursors: Array<string | undefined>; page: number };
const initial = (): Navigation => ({ cursors: [undefined], page: 0 });
function itemText(item: WebHistoryItem): string {
  // Do not expose raw reasoning or embed large inline image data in text output.
  if (item.type === "reasoning") return "Reasoning item. Internal reasoning is not displayed.";
  return JSON.stringify(item, (key, value) => key === "webImage" || key === "webActivity" ? undefined :
    typeof value === "string" && value.startsWith("data:image/") ? "[Inline image attachment]" : value, 2).slice(0, 24000);
}
export function HistoryBrowser({ id, disabled }: { id: string; disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [nav, setNav] = useState<Navigation>(initial);
  const parent = useRef<{ nav: Navigation; scroll: number } | null>(null);
  const restoreScroll = useRef(0);
  const revision = useRef<number | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<WebHistoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true); setData(null); setError(null);
    void api.historyPage(id, { turnId: nav.turnId, cursor: nav.cursors[nav.page], revision: revision.current }, abort.signal).then((value) => {
      if (abort.signal.aborted) return;
      revision.current = value.revision; setData(value);
      requestAnimationFrame(() => { if (!abort.signal.aborted && dialog.current) dialog.current.scrollTop = restoreScroll.current; });
    }).catch((error) => { if (!abort.signal.aborted) { setError(explainError(error)); setChanged(error instanceof ApiError && error.code === "history_changed"); } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [id, open, nav, reload]);
  function reset() { revision.current = undefined; parent.current = null; restoreScroll.current = 0; setChanged(false); setNav(initial()); }
  function move(page: number) {
    restoreScroll.current = 0;
    setNav((current) => ({ ...current, page, cursors: page > current.page ? [...current.cursors.slice(0, page), data!.nextCursor!] : current.cursors }));
  }
  const canNext = Boolean(data?.nextCursor && !nav.cursors.slice(0, nav.page + 1).includes(data.nextCursor));
  return <>
    <button className="button-secondary mb-5" disabled={disabled} onClick={() => { reset(); setOpen(true); }}>Browse history</button>
    <dialog ref={dialog} className="project-dialog settings-dialog" aria-labelledby="history-title" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <div className="mb-5 flex items-center justify-between gap-3"><h2 id="history-title" className="text-lg font-medium">Conversation history</h2><button className="button-secondary" onClick={() => setOpen(false)}>Close history</button></div>
      {nav.turnId && <><button className="button-secondary mb-3" disabled={loading} onClick={() => { restoreScroll.current = parent.current?.scroll ?? 0; setNav(parent.current?.nav ?? initial()); }}>Back to turns</button><p className="mb-3 break-all text-xs text-muted">Turn {nav.turnId}</p></>}
      <p className="mb-3 text-xs text-muted">{nav.turnId ? "Items, oldest first" : "Turns, newest first"} · Page {nav.page + 1}</p>
      {loading && <p role="status">Loading history…</p>}
      {error && <p role="alert" className="notice mb-3">{error}</p>}
      {!loading && !data?.data.length && !error && <p className="text-sm text-muted">No history here yet.</p>}
      <div className="space-y-4">
        {data?.view === "turns" && data.data.map((turn) => <article key={turn.id} className="rounded-lg border border-line p-3">
          <h3 className="break-all text-sm">{turn.id}</h3><p className="my-2 text-xs text-muted">{turn.status}{turn.durationMs != null ? ` · ${Math.round(turn.durationMs / 1000)}s` : ""}{turn.startedAt != null ? ` · ${new Date(turn.startedAt * 1000).toLocaleString()}` : ""}</p>
          {turn.error && <p className="notice mb-2">{turn.error.message}</p>}
          <button className="button-secondary" aria-label={`Inspect turn ${turn.id}`} onClick={() => { parent.current = { nav, scroll: dialog.current?.scrollTop ?? 0 }; restoreScroll.current = 0; setNav({ ...initial(), turnId: turn.id }); }}>Inspect turn</button>
        </article>)}
        {data?.view === "items" && data.data.map(({ turnId, item }, index) => <article key={`${turnId}:${item.id}:${index}`} className="rounded-lg border border-line p-3">
          <h3 className="mb-2 break-all text-sm">{item.webActivity?.label ?? item.type}</h3>
          {item.webImage && <GeneratedImage image={item.webImage} />}
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{itemText(item)}</pre>
          <p className="mt-2 text-xs text-dim">Item details limited to 24,000 characters.</p>
        </article>)}
      </div>
      <div className="mt-5 flex flex-wrap gap-2"><button className="button-secondary" disabled={loading || changed || nav.page === 0} onClick={() => move(nav.page - 1)}>Previous page</button><button className="button-secondary" disabled={loading || changed || !canNext} onClick={() => move(nav.page + 1)}>Next page</button><button className="button-secondary" disabled={loading} onClick={() => { if (changed) reset(); else setReload((value) => value + 1); }}>Refresh history</button></div>
    </dialog>
  </>;
}
