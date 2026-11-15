import { useEffect, useRef, useState, type FormEvent } from "react";
import { HostBattery } from "../components/HostBattery";
import { HostControls } from "../components/HostControls";
import { UsageLimits } from "../components/UsageLimits";
import { Icon } from "../components/Icon";
import type { SwarmMember, SwarmObservation } from "../../../shared/protocol/swarm";
import { swarmStateLabels } from "../../../shared/protocol/swarm";
import type { SurfaceConversation } from "../../../shared/protocol/conversation";
import { explainError } from "../api";
import { useImageDrafts } from "../use-image-drafts";
import { MessageIdentity, MessageCopyOnClick } from "../components/Message";
import { Identity, OrbitIcon } from "./Identity";
import { useSwarms } from "./use-swarms";
import { swarms } from "./api";
import { ManagerChat, type ManagerConnection, type Drafts } from "./ManagerChat";
import { WorkerInspector } from "./WorkerInspector";
import { SwarmDialog as Modal } from "./SwarmDialog";

function Status({ observation }: { observation: SwarmObservation }) {
  return <span className={`swarm-status state-${observation.state}`}><i />{swarmStateLabels[observation.state]}</span>;
}

const renderIdentity = (role: string) => <Identity kind={role === "user" ? "user" : "manager"} />;
export function SwarmApp() {
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem("shepherd.swarm-selection"); } catch { return null; } });
  const model = useSwarms(selected);
  const [dialog, setDialog] = useState<"create" | "roster" | null>(null);
  const [inspector, setInspector] = useState<{ member: SwarmMember; conversation: SurfaceConversation } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 721px)").matches);
  const [drawer, setDrawer] = useState(false), [collapsed, setCollapsed] = useState(false);
  const sidebarDialog = useRef<HTMLDialogElement>(null), sidebarTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 721px)");
    const change = () => { setDesktop(query.matches); setDrawer(false); };
    query.addEventListener("change", change); return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (drawer && !desktop) sidebarDialog.current?.showModal(); else sidebarDialog.current?.close();
  }, [drawer, desktop]);
  const closeNavigation = () => setDrawer(false);
  const restoreNavigationFocus = () => { if (!desktop) sidebarTrigger.current?.focus(); };
  const [renaming, setRenaming] = useState(false), [title, setTitle] = useState("");
  const drafts = useRef<Drafts>(new Map()), imageDrafts = useImageDrafts();
  const [managerConnection, setManagerConnection] = useState<ManagerConnection | null>(null);
  const [menuTarget, setMenuTarget] = useState<HTMLDivElement | null>(null);
  const snapshot = model.snapshot, group = snapshot?.group;
  const selection = useRef(selected); selection.current = selected;
  const projects = [...new Set(model.groups.map(g => g.project))];
  const visible = model.groups;
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => { document.documentElement.style.setProperty("--app-height", `${viewport?.height ?? window.innerHeight}px`); document.documentElement.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`); };
    update(); viewport?.addEventListener("resize", update); viewport?.addEventListener("scroll", update);
    return () => { viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update); };
  }, []);
  useEffect(() => { if (model.listedFor === selected && model.groups[0] && !model.groups.some(g => g.id === selected)) select(model.groups[0].id); }, [model.groups, model.listedFor, selected]);
  function select(id: string) { setDrawer(false); setSelected(id); setDialog(null); setInspector(null); setError(null); setRenaming(false); try { localStorage.setItem("shepherd.swarm-selection", id); } catch { /* Optional storage. */ } }
  async function action(run: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(null);
    try { await run(); } catch (e) { setError(explainError(e)); }
    finally { setBusy(false); void model.refresh(); }
  }
  function newConversation() { setDrawer(false); setError(null); setDialog("create"); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await action(async () => {
      const result = await swarms.create({ project: String(data.get("project") ?? "").trim() });
      select(result.group.id);
    });
  }
  const navigation = <>
    <div className="swarm-sidebar-brand"><h1>Orbit</h1><button className="icon-button" aria-label="Close conversations" onClick={() => desktop ? setCollapsed(true) : setDrawer(false)}><Icon name="close" /></button></div>
    <button className="alloy-button new-swarm" onClick={newConversation}><Icon name="plus" /> New conversation</button>
    <div className="swarm-section-label"><span>Conversations</span><button className="icon-button" aria-label="Refresh conversations" onClick={() => void model.refresh()}><Icon name="refresh" /></button></div>
    <nav className="swarm-conversations" aria-label="Conversations">{visible.map(g => <button key={g.id} data-group-id={g.id} className={`swarm-nav-item ${selected === g.id ? "selected" : ""}`} aria-current={selected === g.id ? "page" : undefined} onClick={() => select(g.id)}><Identity kind="manager" /><span className="swarm-nav-copy"><strong>{g.name}</strong><small>{g.project}</small></span>{g.id === selected && snapshot && <span className={`swarm-nav-status state-${snapshot.manager.state}`} title={swarmStateLabels[snapshot.manager.state]}><i /></span>}</button>)}{!visible.length && <p className="swarm-caption">No conversations found.</p>}</nav>
    <footer className="sidebar-footer swarm-sidebar-footer"><UsageLimits defaultProvider={snapshot?.manager.conversation?.provider} onOpen={closeNavigation} onClosed={restoreNavigationFocus} /><HostControls onOpen={closeNavigation} onClosed={restoreNavigationFocus} onRecovered={model.refresh} /></footer>
  </>;
  const roster = snapshot && <>
    <div className="swarm-section-label">Swarm <span>{snapshot.workers.length}</span></div>
    <div className="swarm-manager-label"><Identity kind="manager" large /><div><h2>Manager</h2><Status observation={snapshot.manager} /></div></div>
    <div className="swarm-workers" aria-label="Worker roster">{group!.members.map(member => {
      const observed = snapshot.workers.find(w => w.threadId === member.threadId)!;
      return <button key={member.threadId} className="swarm-worker" disabled={busy} aria-label={`Inspect ${member.name}`} onClick={() => void action(async () => { const conversation = await swarms.open(group!.id, member.threadId); if (selection.current !== group!.id) return; setDialog(null); setInspector({ member, conversation }); })}>
        <Identity seed={member.iconSeed} /><span className="swarm-worker-text"><strong>{member.name}</strong><small>{member.assignment}</small></span><Status observation={observed} />
      </button>;
    })}{!snapshot.workers.length && <p className="swarm-caption empty-roster">Workers appear here when your manager delegates.</p>}</div>
    <p className="swarm-caption roster-footnote">Your manager brings results and questions back to the conversation.</p>
  </>;
  return <MessageIdentity.Provider value={renderIdentity}><MessageCopyOnClick.Provider value={true}><div className={`swarm-shell ${collapsed ? "swarm-sidebar-collapsed" : ""}`}>
    {desktop ? <aside className="swarm-navigation" inert={collapsed} aria-hidden={collapsed || undefined}>{navigation}</aside> : <dialog ref={sidebarDialog} className="swarm-navigation swarm-navigation-drawer" aria-label="Conversations" onCancel={() => setDrawer(false)} onClose={() => setDrawer(false)} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX > bounds.right || event.clientX < bounds.left || event.clientY < bounds.top || event.clientY > bounds.bottom) setDrawer(false); } }}>{navigation}</dialog>}
    <main className="swarm-main" id="conversation" data-group-id={selected ?? ""}>
      <header className="swarm-header">
        <button ref={sidebarTrigger} className="icon-button swarm-sidebar-trigger" aria-label="Open conversations" aria-expanded={desktop ? !collapsed : drawer} onClick={() => desktop ? setCollapsed(!collapsed) : setDrawer(true)}><Icon name="menu" /></button>
        <div className="swarm-heading">{renaming && group ? <form onSubmit={event => { event.preventDefault(); void action(async () => { await swarms.rename(group.id, group.revision, title.trim()); setRenaming(false); }); }}><input autoFocus aria-label="Conversation title" value={title} required maxLength={120} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setRenaming(false); }} /><button aria-label="Save title" disabled={busy}>✓</button><button type="button" aria-label="Cancel rename" onClick={() => setRenaming(false)}>×</button></form> : <h1><button aria-label="Rename conversation" disabled={!group} onClick={() => { setTitle(group!.name); setRenaming(true); }}>{group?.name ?? "New conversation"}</button></h1>}</div>
        <HostBattery />
        {group && <button className="alloy-button roster-toggle" onClick={() => setDialog("roster")} title="Swarm and conversation details">{snapshot && <span className={`swarm-header-status state-${snapshot.manager.state}`} aria-hidden="true"><i /></span>}Swarm · {group.members.length}</button>}
        <div ref={setMenuTarget} className="swarm-manager-menu" />
      </header>
      {(error || model.error) && dialog !== "create" && <p role="alert" className="notice swarm-global-notice">{error || model.error}</p>}
      {snapshot ? snapshot.manager.conversation ? <ManagerChat key={snapshot.manager.conversation.id} conversation={snapshot.manager.conversation} drafts={drafts} imageDrafts={imageDrafts} menuTarget={menuTarget} onConnectionChange={setManagerConnection} />
        : <div className="swarm-empty"><Identity kind="manager" large /><h2>Continue the conversation</h2><button className="alloy-button" disabled={busy} onClick={() => void action(async () => { await swarms.open(group!.id, group!.managerThreadId); })}>Resume conversation</button></div>
        : <div className="swarm-empty"><Identity kind="manager" large /><h2>What shall we work on?</h2><p>{model.loading ? "Loading conversations…" : "Choose a project and tell your manager what you need."}</p><button className="alloy-button" disabled={model.loading} onClick={newConversation}><OrbitIcon name="plus" /> New conversation</button></div>}
    </main>
    <aside className="swarm-roster">{roster ?? <p className="swarm-caption">Your team will appear here.</p>}</aside>
    {dialog === "roster" && snapshot && <Modal title="Swarm" close={() => setDialog(null)}>{roster}<section className="swarm-conversation-info" aria-label="Manager conversation details"><h3>Manager conversation</h3><p>{snapshot.group.name}</p><dl>
      <div><dt>Connection</dt><dd>{!snapshot.manager.conversation ? "Not attached" : managerConnection?.id === snapshot.manager.conversation.id ? ({ online: "Connected", connecting: "Connecting…", reconnecting: "Reconnecting…", detached: "Detached" }[managerConnection.connection]) : "Connecting…"}</dd></div>
      <div><dt>Project</dt><dd>{snapshot.group.project}</dd></div>
      {snapshot.manager.conversation?.provider && <div><dt>Provider</dt><dd>{snapshot.manager.conversation.provider}</dd></div>}
      <div><dt>Conversation ID</dt><dd className="font-mono">{snapshot.group.managerThreadId}</dd></div>
    </dl></section></Modal>}
    {dialog === "create" && <Modal title="New conversation" close={() => { if (!busy) setDialog(null); }}><form className="swarm-form" onSubmit={submit}>
      <label>Project<input name="project" required autoFocus list="swarm-project-list" defaultValue={group?.project ?? ""} placeholder="owner/repo or /absolute/path" maxLength={4096} /></label>
      <datalist id="swarm-project-list">{projects.map(project => <option key={project} value={project} />)}</datalist>
      {error && <p role="alert" className="notice">{error}</p>}
      <button className="alloy-button" disabled={busy} type="submit">{busy ? "Opening…" : "Start conversation"}</button>
    </form></Modal>}

    {inspector && <WorkerInspector member={inspector.member} conversation={inspector.conversation} close={() => setInspector(null)} />}
  </div></MessageCopyOnClick.Provider></MessageIdentity.Provider>;
}
