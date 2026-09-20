import { useEffect, useRef, useState } from "react";
import type { WebHostStatus } from "../../../shared/protocol/host";
import { api, explainError } from "../api";
import { Icon } from "./Icon";

type Pending = { instanceId: string; requestId: string };
const readPending = (): Pending | null => {
  try { const value = JSON.parse(sessionStorage.getItem("shepherd.host-operation") ?? "null"); return typeof value?.instanceId === "string" && typeof value?.requestId === "string" ? value : null; } catch { return null; }
};

export function HostControls({ onRecovered }: { onRecovered: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WebHostStatus | null>(null);
  const [pending, setPending] = useState<Pending | null>(readPending);
  const [confirm, setConfirm] = useState<"restart" | "deploy" | null>(null);
  const [branch, setBranch] = useState("");
  const [sending, setSending] = useState(false);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  const recovered = useRef(onRecovered); recovered.current = onRecovered;
  function track(value: Pending | null) {
    setPending(value);
    try { if (value) sessionStorage.setItem("shepherd.host-operation", JSON.stringify(value)); else sessionStorage.removeItem("shepherd.host-operation"); } catch { /* Storage is optional. */ }
  }
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  useEffect(() => {
    if (!open && !pending) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.host(abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next); setOnline(true); setError(null);
        if (pending && pending.instanceId !== next.instanceId) {
          track(null); setNotice("Host reconnected. Check the running and checkout commits below to verify the deployment outcome.");
          void recovered.current().catch((error) => setError(explainError(error)));
        } else if (pending && next.operation?.id === pending.requestId) {
          setNotice(null);
          if (next.operation.phase === "finished") track(null);
        } else if (pending && next.operation?.id !== pending.requestId) {
          // A lost POST response does not authorize resending an operation.
          setNotice("No matching operation is recorded yet. Check host status before trying again.");
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        setOnline(false); setError(pending ? "Waiting for Shepherd to reconnect. The operation may still be running; it will not be sent again automatically." : explainError(error));
      } finally { if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 2000); }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [open, pending, revision]);

  async function run() {
    if (!confirm || !status || lock.current || pending || !online) return;
    lock.current = true; setSending(true); setError(null); setNotice(null);
    const requestId = crypto.randomUUID();
    track({ instanceId: status.instanceId, requestId });
    try {
      const operation = await api.hostAction({ requestId, action: confirm, ...(confirm === "deploy" && branch.trim() ? { branch: branch.trim() } : {}) });
      setStatus((current) => current && ({ ...current, operation }));
    } catch (error) { setError(`${explainError(error)} Check host status before retrying; the request may have been accepted.`); }
    finally { setConfirm(null); lock.current = false; setSending(false); setRevision((value) => value + 1); }
  }
  const running = status?.operation && status.operation.phase !== "finished";
  const blocked = !online || !status?.available || sending || Boolean(pending) || Boolean(running) || status?.checkout?.deploymentInProgress;
  return <>
    <button className="icon-button" aria-label="Host controls" title="Host controls" onClick={() => setOpen(true)}><Icon name="host" /></button>
    <dialog ref={dialog} className="project-dialog settings-dialog" aria-labelledby="host-title" onCancel={(event) => { if (sending) event.preventDefault(); else setOpen(false); }} onClose={() => setOpen(false)}>
      <div className="mb-5 flex items-center justify-between"><h2 id="host-title" className="text-lg font-medium">Host controls</h2><button className="icon-button" aria-label="Close host controls" disabled={sending} onClick={() => setOpen(false)}><Icon name="close" /></button></div>
      <p className="mb-4 text-xs text-muted">These actions affect the entire Shepherd host and every surface. Active turns and pending approvals must finish first.</p>
      {status ? <dl className="settings-facts"><dt>Connection</dt><dd>{online ? "Connected" : "Reconnecting"}</dd><dt>Started</dt><dd>{status.startedAt}</dd><dt>Running commit</dt><dd className="break-all">{status.runningCommit ?? "Unavailable"}</dd><dt>Checkout commit</dt><dd className="break-all">{status.checkout?.deployedCommit ?? "Unavailable"}</dd><dt>Remote refs</dt><dd className="break-all">{status.checkout?.matchingRemoteRefs.join(", ") || "None"}</dd></dl> : <p role="status">Loading host status…</p>}
      {status && !status.available && <p className="notice mt-4">Lifecycle controls are unavailable on this host.</p>}
      {status?.operation && <section className="mt-5" aria-label="Host operation"><h3 className="text-sm">{status.operation.action} · {status.operation.phase}</h3><pre role="status" className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{status.operation.message}</pre></section>}
      {notice && <p role="status" className="mt-4 text-xs text-muted">{notice}</p>}
      {error && <p role="alert" className="notice mt-4">{error}</p>}
      {confirm ? <section className="mt-5 space-y-3"><p className="text-sm">{confirm === "restart" ? "Restart Shepherd now?" : `Deploy origin/${branch.trim() || "main"}, validate it, and restart Shepherd?`}</p><p className="text-xs text-muted">All surfaces will disconnect briefly. The web UI will check for the host to return and resume the selected conversation when possible.</p><div className="flex gap-2"><button className="button-secondary" disabled={sending} onClick={() => setConfirm(null)}>Cancel host action</button><button className="button-primary" disabled={blocked} onClick={() => void run()}>Confirm {confirm}</button></div></section> : <section className="mt-5 space-y-3"><button className="button-secondary" disabled={blocked} onClick={() => setConfirm("restart")}>Restart host</button><label className="block text-sm">Deployment branch<input aria-label="Deployment branch" placeholder="main (stable)" value={branch} maxLength={256} disabled={blocked} onChange={(event) => setBranch(event.target.value)} /></label><p className="text-xs text-muted">Leave blank for stable main. A named branch deploys a preview; deploy main again to return to stable.</p><button className="button-secondary" disabled={blocked} onClick={() => setConfirm("deploy")}>Deploy host</button></section>}
      {pending && online && !running && !sending && <button className="button-secondary mt-4" onClick={() => { track(null); setNotice("Review the current checkout and operation outcome before requesting another action."); }}>I checked the outcome</button>}
      <button className="button-secondary mt-4" disabled={sending} onClick={() => setRevision((value) => value + 1)}>Refresh host status</button>
    </dialog>
  </>;
}
