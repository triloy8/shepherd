import { useEffect, useRef, useState } from "react";
import type { SurfaceConversation } from "../../../shared/protocol/conversation";
import { swarmStateLabels, type SwarmMember } from "../../../shared/protocol/swarm";
import { useSwarms } from "./use-swarms";
import { swarms } from "./api";
import { explainError } from "../api";
import { SwarmDialog } from "./SwarmDialog";
import { WorkerInspector } from "./WorkerInspector";

export function SwarmPanel({ conversation }: { conversation: SurfaceConversation }) {
  const team = useSwarms(conversation.threadId);
  const [open, setOpen] = useState(false);
  const [worker, setWorker] = useState<{ member: SwarmMember; conversation: SurfaceConversation } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function inspect(member: SwarmMember) {
    if (!team.snapshot || busy) return;
    setBusy(true); setError(null);
    try {
      const handle = await swarms.open(team.snapshot.group.id, member.threadId);
      if (alive.current) setWorker({ member, conversation: handle });
    } catch (e) { if (alive.current) setError(explainError(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  const count = team.snapshot?.group.members.length ?? 0;
  const countLabel = team.loading ? "…" : team.error ? "?" : count;
  return <>
    <button className="icon-button w-auto min-w-11 border border-line bg-raised px-1 text-xs font-medium whitespace-nowrap tabular-nums text-ink hover:border-accent/50 sm:px-2" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); void team.refresh(); }}>Swarm · {countLabel}</button>
    {open && <SwarmDialog title="Swarm" close={() => { setOpen(false); setWorker(null); }}>
      {(error || team.error) && <p role="alert" className="notice">{error || team.error}<button className="button-secondary" onClick={() => void team.refresh()}>Retry</button></p>}
      {!team.online && <p role="status" className="mb-4 text-xs text-muted">Reconnecting to team updates…</p>}
      {team.loading ? <p role="status" className="text-sm text-muted">Loading team…</p> : !team.error && !count ? <p className="text-sm text-muted">No workers yet. Ask in the chat to split work across a team.</p> : null}
      {team.snapshot?.group.lifecycle === "closed" && <p className="swarm-caption">This team is closed. Its workers remain available for inspection.</p>}
      <ul className="swarm-roster">{team.snapshot?.group.members.map(member => {
        const observed = team.snapshot?.workers.find(w => w.threadId === member.threadId);
        const dispatch = observed?.latestDispatch;
        const state = dispatch?.state ?? observed?.state ?? "unknown";
        const label = state === "delivery-unconfirmed" ? "Delivery unconfirmed"
          : state === "needs-attention" ? "Needs a decision" : swarmStateLabels[state];
        const task = dispatch ? dispatch.task ?? (dispatch.turnId ? "Task text unavailable." : null)
          : member.assignment || "No assignment recorded.";
        return <li key={member.threadId}>
          <button className="swarm-worker" disabled={busy} onClick={() => void inspect(member)}>
            <strong>{member.name}</strong><span>{label}</span>
            {task && <p>{task}</p>}
            {Boolean(observed?.pendingApprovals) && state !== "needs-attention" && <small>Worker needs a decision</small>}
          </button>
        </li>;
      })}</ul>
    </SwarmDialog>}
    {open && worker && <WorkerInspector {...worker} close={() => setWorker(null)} />}
  </>;
}
