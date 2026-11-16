import { useEffect, useRef, useState } from "react";
import type { SurfaceConversation } from "../../../shared/protocol/conversation";
import type { SwarmMember } from "../../../shared/protocol/swarm";
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
  return <>
    <button className="button-secondary swarm-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>Swarm · {team.loading ? "…" : team.error ? "?" : count}</button>
    {open && <SwarmDialog title="Swarm" close={() => { setOpen(false); setWorker(null); }}>
      {(error || team.error) && <p role="alert" className="notice">{error || team.error}<button className="button-secondary" onClick={() => void team.refresh()}>Retry</button></p>}
      <p className="swarm-caption">{team.online ? "Live team status" : "Reconnecting to team updates…"}</p>
      {team.loading ? <p>Loading team…</p> : !team.error && !count ? <p className="swarm-empty">No workers yet. Ask in the chat to split work across a team. You can keep working here on your own.</p> : null}
      {team.snapshot?.group.lifecycle === "closed" && <p className="swarm-caption">This team is closed. Its workers remain available for inspection.</p>}
      <ul className="swarm-roster">{team.snapshot?.group.members.map(member => {
        const state = team.snapshot?.workers.find(w => w.threadId === member.threadId);
        return <li key={member.threadId}><button className="swarm-worker" disabled={busy} onClick={() => void inspect(member)}><strong>{member.name}</strong><span>{state?.state ?? "unknown"}</span><p>{member.assignment || "No assignment recorded."}</p>{Boolean(state?.pendingApprovals) && <small>Needs a decision</small>}</button></li>;
      })}</ul>
    </SwarmDialog>}
    {open && worker && <WorkerInspector {...worker} close={() => setWorker(null)} />}
  </>;
}
