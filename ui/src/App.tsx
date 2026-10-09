import { useImageDrafts } from "./use-image-drafts";
import { HostControls } from "./components/HostControls";
import { HostBattery } from "./components/HostBattery";
import { ConversationMenu } from "./components/ConversationMenu";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { StoredThreadSummary } from "../../shared/protocol/requests";
import type { WebConversation } from "../../shared/protocol/web";
import { api, explainError } from "./api";
import { useConversation } from "./use-conversation";
import { Icon } from "./components/Icon";
import { Timeline } from "./components/Timeline";
import { UsageLimits } from "./components/UsageLimits";
import { Composer } from "./components/Composer";
import { Approvals } from "./components/Approvals";

const label = (thread: StoredThreadSummary) => thread.name || thread.preview?.trim().slice(0, 70) || "Untitled conversation";
const savedSelection = (): WebConversation | null => {
  try {
    const value = JSON.parse(localStorage.getItem("shepherd.selection") ?? "null");
    return value && [value.id, value.threadId, value.project].every((item) => typeof item === "string" && item.length > 0) ? value : null;
  } catch { return null; }
};

export default function App() {
  const [conversations, setConversations] = useState<WebConversation[]>([]);
  const [archived, setArchived] = useState(false);
  const archivedRef = useRef(false);
  const listGeneration = useRef(0);
  const [names, setNames] = useState<Record<string, string>>({});
  const [restoring, setRestoring] = useState<string | null>(null);
  const restoreLock = useRef(false);
  const resumes = useRef(new Map<string, Promise<WebConversation>>());
  const selectionVersion = useRef(0);
  const [resuming, setResuming] = useState(false);
  const [threads, setThreads] = useState<StoredThreadSummary[]>([]);
  const [threadsCursor, setThreadsCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<WebConversation | null>(null);
  const [saved, setSaved] = useState<WebConversation | null>(savedSelection);
  const [drawer, setDrawer] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const hadDrawer = useRef(false);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const [dialog, setDialog] = useState<{ title: string } | null>(null);
  const [project, setProject] = useState("~");
  const imageDrafts = useImageDrafts();
  const [drafts, setDrafts] = useState<Record<string, { text: string; revision: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [refreshingThreads, setRefreshingThreads] = useState(false);
  const expandedList = useRef(false);
  const refreshPending = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerSpace, setComposerSpace] = useState(150);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const size = () => {
      const style = document.documentElement.style;
      if (viewport.scale === 1) {
        // Safari can pan the visual viewport as well as shrink it for the keyboard.
        // Keep the fixed app inside that visible rectangle instead of moving it twice.
        style.setProperty("--app-height", `${viewport.height}px`);
        style.setProperty("--app-top", `${viewport.offsetTop}px`);
        // The keyboard already separates the composer from the home indicator.
        if (viewport.height < document.documentElement.clientHeight - 100) style.setProperty("--composer-bottom-gap", "4px");
        else style.removeProperty("--composer-bottom-gap");
      } else {
        style.removeProperty("--app-height");
        style.removeProperty("--app-top");
        style.removeProperty("--composer-bottom-gap");
      }
    };
    size();
    viewport.addEventListener("resize", size);
    viewport.addEventListener("scroll", size);
    return () => {
      viewport.removeEventListener("resize", size);
      viewport.removeEventListener("scroll", size);
      document.documentElement.style.removeProperty("--app-height");
      document.documentElement.style.removeProperty("--app-top");
      document.documentElement.style.removeProperty("--composer-bottom-gap");
    };
  }, []);
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setComposerSpace(Math.ceil(element.getBoundingClientRect().height) + 20));
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected?.id]);
  const follow = useRef(true);
  const initialSelection = useRef(true);
  const controller = useConversation(selected);
  const thread = threads.find((item) => item.threadId === selected?.threadId);
  const title = thread ? label(thread) : selected ? names[selected.threadId] ?? "New conversation" : "Your workspace, in conversation";

  const refreshList = useCallback(async () => {
    const generation = ++listGeneration.current;
    refreshPending.current = true; setRefreshingThreads(true); expandedList.current = false;
    setLoadingThreads(false);
    const view = archivedRef.current;
    try {
      const [handles, stored] = await Promise.all([api.conversations(), api.threads(undefined, undefined, view)]);
      if (generation !== listGeneration.current || view !== archivedRef.current) return;
      setNames((current) => ({ ...current, ...Object.fromEntries(stored.threads.map((item) => [item.threadId, label(item)])) }));
      setConversations(handles.conversations); setThreads(stored.threads); setThreadsCursor(stored.nextCursor); setError(null);
      if (initialSelection.current) {
        initialSelection.current = false;
        const previous = savedSelection();
        const handle = handles.conversations.find((item) => item.threadId === previous?.threadId);
        if (handle) { setSelected(handle); setSaved(null); }
      }
    } catch (error) { if (generation === listGeneration.current) setError(explainError(error)); }
    finally { if (generation === listGeneration.current) { setLoading(false); setRefreshingThreads(false); refreshPending.current = false; } }
  }, []);
  useEffect(() => { void refreshList(); const onOnline = () => { void refreshList(); }; window.addEventListener("online", onOnline); return () => window.removeEventListener("online", onOnline); }, [refreshList]);
  // Refresh recent conversations without collapsing an intentionally expanded list.
  const refreshRecent = useCallback(() => {
    if (document.visibilityState === "visible" && !expandedList.current && !refreshPending.current) void refreshList();
  }, [refreshList]);
  useEffect(() => {
    const timer = setInterval(refreshRecent, 30_000);
    window.addEventListener("focus", refreshRecent);
    document.addEventListener("visibilitychange", refreshRecent);
    return () => { clearInterval(timer); window.removeEventListener("focus", refreshRecent); document.removeEventListener("visibilitychange", refreshRecent); };
  }, [refreshRecent]);
  useEffect(() => {
    if (!selected) return;
    const timer = setTimeout(refreshRecent, 500);
    return () => clearTimeout(timer);
  }, [selected?.id, controller.chat.activeTurnId, controller.chat.endedTurns.length, refreshRecent]);
  useEffect(() => {
    if (dialog && !dialogRef.current?.open) dialogRef.current?.showModal();
    else if (!dialog && dialogRef.current?.open) dialogRef.current.close();
  }, [dialog]);
  useEffect(() => {
    if (selected) { try { localStorage.setItem("shepherd.selection", JSON.stringify(selected)); } catch { /* Browser storage may be disabled. */ } }
    follow.current = true;
  }, [selected]);
  useEffect(() => {
    if (follow.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [controller.chat.messages, controller.approvals, controller.chat.activity, composerSpace]);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const change = () => setDesktop(query.matches);
    query.addEventListener("change", change); return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (drawer) sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (hadDrawer.current && !desktop) sidebarTrigger.current?.focus();
    hadDrawer.current = drawer;
    const close = (event: KeyboardEvent) => {
      if (!drawer || desktop) return;
      if (event.key === "Escape") { setDrawer(false); sidebarTrigger.current?.focus(); }
      if (event.key === "Tab") {
        const items = [...sidebarRef.current!.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')];
        const first = items[0]; const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [drawer, desktop]);

  function select(conversation: WebConversation) { selectionVersion.current++; setResuming(false); setSelected(conversation); setSaved(null); setDrawer(false); }
  async function openThread(threadId: string, force = false) {
    const existing = conversations.find((item) => item.threadId === threadId);
    if (existing && !force) { select(existing); return; }
    if (creating) return;
    const version = ++selectionVersion.current;
    setResuming(true); setError(null); setDrawer(false);
    // Repeated clicks share the request, while the latest selection wins.
    const pending = resumes.current.get(threadId) ?? api.create({ threadId });
    resumes.current.set(threadId, pending);
    try {
      const conversation = await pending;
      setConversations((items) => [...items.filter((item) => item.id !== conversation.id), conversation]);
      if (version === selectionVersion.current) select(conversation);
      void refreshList();
    } catch (error) { if (version === selectionVersion.current) setError(explainError(error)); }
    finally {
      if (resumes.current.get(threadId) === pending) resumes.current.delete(threadId);
      if (version === selectionVersion.current) setResuming(false);
    }
  }
  async function createConversation() {
    if (creating || !project.trim() || !dialog) return;
    selectionVersion.current++; setResuming(false);
    setCreating(true); setError(null);
    try {
      const conversation = await api.create({ project: project.trim() });
      setConversations((items) => [...items.filter((item) => item.id !== conversation.id), conversation]);
      select(conversation); setDialog(null); void refreshList();
    } catch (error) { setError(`${explainError(error)} Refresh the conversation list before retrying if the connection dropped.`); }
    finally { setCreating(false); }
  }
  function changeView(value: boolean) {
    archivedRef.current = value; setArchived(value); setThreads([]); setThreadsCursor(null); setLoading(true); setLoadingThreads(false); void refreshList();
  }
  async function restore(threadId: string) {
    if (restoreLock.current) return;
    restoreLock.current = true; setRestoring(threadId); setError(null);
    try { await api.restore(threadId); changeView(false); }
    catch (error) { setError(explainError(error)); }
    finally { restoreLock.current = false; setRestoring(null); }
  }
  async function loadThreads() {
    if (!threadsCursor || loadingThreads) return;
    expandedList.current = true; setLoadingThreads(true);
    const generation = listGeneration.current; const view = archivedRef.current;
    try {
      const page = await api.threads(threadsCursor, undefined, view);
      if (generation !== listGeneration.current || view !== archivedRef.current) return;
      setNames((current) => ({ ...current, ...Object.fromEntries(page.threads.map((item) => [item.threadId, label(item)])) }));
      setThreads((items) => [...items, ...page.threads.filter((item) => !items.some((existing) => existing.threadId === item.threadId))]); setThreadsCursor(page.nextCursor);
    } catch (error) { if (generation === listGeneration.current) setError(explainError(error)); }
    finally { if (generation === listGeneration.current) setLoadingThreads(false); }
  }
  async function detach() {
    if (!selected || detaching) return;
    const id = selected.id;
    setDetaching(true);
    try {
      await api.detach(id);
      setSelected((current) => current?.id === id ? null : current);
      setSaved((current) => current?.id === id ? null : current);
      setConversations((items) => items.filter((item) => item.id !== id));
      try { if (savedSelection()?.id === id) localStorage.removeItem("shepherd.selection"); } catch { /* Storage is optional. */ }
      await refreshList();
    }
    catch (error) { setError(explainError(error)); }
    finally { setDetaching(false); }
  }

  const active = Boolean(controller.chat.activeTurnId);
  const status = controller.connection === "online" ? active ? "Working" : "Connected" : controller.connection === "detached" ? "Needs attention" : controller.connection === "reconnecting" ? "Reconnecting" : "Connecting";
  const visibleHandles = (archived ? [] : conversations).filter((item) => !threads.some((thread) => thread.threadId === item.threadId));
  return <div className="app-shell">
    {drawer && <button className="drawer-backdrop" aria-label="Close conversations" onClick={() => setDrawer(false)} />}
    <aside inert={desktop ? sidebarCollapsed : !drawer} role={!desktop && drawer ? "dialog" : "complementary"} aria-hidden={!desktop && !drawer ? true : undefined} aria-modal={!desktop && drawer ? true : undefined} ref={sidebarRef} className={`sidebar ${drawer ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} aria-label="Conversations">
      <div className="flex h-16 shrink-0 items-center justify-between px-5">
        <a href="/" className="flex items-center gap-2.5 font-semibold tracking-tight"><span className="text-lg">shepherd</span></a>
        <button className="icon-button lg:hidden" aria-label="Close conversations" onClick={() => setDrawer(false)}><Icon name="close" /></button>
      </div>
      <div className="px-4"><button className="new-conversation" disabled={creating} onClick={() => { setDialog({ title: "New conversation" }); setProject("~"); setDrawer(false); }}><Icon name="plus" /><span>New conversation</span></button></div>
      <div className="mb-2 mt-7 flex items-center justify-between px-5 text-[10px] font-semibold uppercase tracking-[.16em] text-dim"><span>Conversations</span><button className="icon-button border border-line bg-raised/50" title="Refresh conversations" aria-label="Refresh conversations" disabled={refreshingThreads} aria-busy={refreshingThreads} onClick={() => void refreshList()}><Icon name="refresh" className={`size-5! ${refreshingThreads ? "motion-safe:animate-spin" : ""}`} /></button></div>
      <div className="mb-3 flex gap-2 px-4" aria-label="Conversation filter"><button className="button-secondary flex-1 justify-center" aria-pressed={!archived} onClick={() => changeView(false)}>Active</button><button className="button-secondary flex-1 justify-center" aria-pressed={archived} onClick={() => changeView(true)}>Archived</button></div>
      {refreshingThreads && !loading && <p role="status" className="px-5 pb-2 text-xs text-muted">Refreshing conversations…</p>}
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {loading && <p className="px-3 py-4 text-sm text-muted">Loading conversations…</p>}
        {!loading && !threads.length && !visibleHandles.length && <p className="px-3 py-4 text-sm leading-6 text-dim">{archived ? "No archived conversations." : "Your conversations will appear here."}</p>}
        {visibleHandles.map((item) => <button className={`thread-button ${selected?.id === item.id ? "thread-selected" : ""}`} key={item.id} onClick={() => select(item)}><Icon name="chat" /><span className="truncate">New conversation</span><span className="status-dot ml-auto" /></button>)}
        {threads.map((item) => archived ? <div key={item.threadId} className="mb-2 flex items-center gap-2 px-3 py-2"><span className="min-w-0 flex-1 truncate text-sm text-muted" title={label(item)}>{label(item)}</span><button className="button-secondary" aria-label={`Restore ${label(item)}`} disabled={restoring !== null} onClick={() => void restore(item.threadId)}>{restoring === item.threadId ? "Restoring…" : "Restore"}</button></div> : <button title={label(item)} className={`thread-button ${selected?.threadId === item.threadId ? "thread-selected" : ""}`} key={item.threadId} onClick={() => openThread(item.threadId)}><Icon name="chat" /><span className="truncate">{label(item)}</span>{conversations.some((c) => c.threadId === item.threadId) && <span className="status-dot ml-auto" />}</button>)}
        {threadsCursor && <button className="mt-3 w-full rounded-lg py-2 text-xs text-muted hover:text-ink" onClick={() => void loadThreads()} disabled={loadingThreads || refreshingThreads}>{loadingThreads ? "Loading…" : "Load more conversations"}</button>}
      </nav>
      <div className="sidebar-footer">
        <UsageLimits onOpen={() => setDrawer(false)} onClosed={() => { if (!desktop) sidebarTrigger.current?.focus(); }} />
        <HostControls onClosed={() => { if (!desktop) sidebarTrigger.current?.focus(); }} onOpen={() => setDrawer(false)} onRecovered={async () => {
          const previous = selected ?? savedSelection();
          setSelected(null); setSaved(previous);
          const handles = await api.conversations();
          if (previous) {
            const next = handles.conversations.find((item) => item.threadId === previous.threadId)
              ?? await api.create({ threadId: previous.threadId });
            select(next); setSaved(null);
          }
          await refreshList();
        }} />
      </div>
    </aside>
    <main className="main-pane" inert={!desktop && drawer}>
      <header className="main-header">
        <button ref={sidebarTrigger} className="icon-button" aria-label="Open conversations" aria-expanded={desktop ? !sidebarCollapsed : drawer} onClick={() => { if (desktop) setSidebarCollapsed(!sidebarCollapsed); else setDrawer(true); }}><Icon name="menu" /></button>
        {!selected && <><div className="min-w-0 flex-1"><h1 className="truncate text-sm font-medium">Workspace</h1></div><HostBattery /></>}
        {selected && <ConversationMenu key={selected.id} conversation={selected} title={title} status={status} disabled={controller.connection !== "online" || controller.busy || detaching} active={active || controller.approvals.length > 0} activeTurnId={controller.chat.activeTurnId} detaching={detaching || controller.busy} onDetach={() => void detach()}
          onHistoryChange={controller.refresh}
          onRename={(name) => { setNames((current) => ({ ...current, [selected.threadId]: name })); setThreads((items) => items.map((item) => item.threadId === selected.threadId ? { ...item, name } : item)); void refreshList(); }}
          onArchive={() => { setSelected(null); setSaved(null); setConversations((items) => items.filter((item) => item.id !== selected.id)); try { localStorage.removeItem("shepherd.selection"); } catch {} void refreshList(); }}
          onFork={(conversation) => { setConversations((items) => [...items, conversation]); select(conversation); changeView(false); }}
        />}
      </header>
      {resuming && <p role="status" className="notice mx-5 mt-4">Resuming conversation…</p>}
      {error && !dialog && <div className="notice mx-5 mt-4" role="alert">{error}<button className="ml-3 underline" onClick={() => void refreshList()}>Refresh</button></div>}
      {!selected ? <section className="empty-screen">
        <button className="button-primary" disabled={creating} onClick={() => { setDialog({ title: "New conversation" }); setProject("~"); }}><Icon name="plus" />Start a conversation</button>
        {saved && <button className="mt-5 text-sm text-muted underline decoration-line underline-offset-4" onClick={() => openThread(saved.threadId)}>Resume your last conversation</button>}
      </section> : <section className="conversation-stage" style={{ "--composer-space": `${composerSpace}px` } as CSSProperties}>
        <div className="chat-scroll" ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
          <div className="chat-width chat-content pt-4 sm:pt-6">
            {controller.historyCursor && <button className="mb-6 w-full text-xs text-muted hover:text-ink" disabled={controller.loadingHistory} onClick={() => { follow.current = false; void controller.loadOlder(); }}>{controller.loadingHistory ? "Loading…" : "Load earlier messages"}</button>}
            <Timeline key={selected.id} chat={controller.chat} revertDisabled={controller.connection !== "online" || controller.busy || detaching || active || controller.approvals.length > 0} onRevert={controller.revert} onReload={controller.recoverHistory} />
            {active && <div role="status" className="mt-7 flex items-center gap-2 text-xs text-muted"><span className="working-dot" />{controller.chat.activity || "Working"}</div>}
            {controller.chat.error && <p role="alert" className="notice mt-5">{controller.chat.error}</p>}
            <div className="mt-6"><Approvals approvals={controller.approvals} busy={controller.busy || controller.connection !== "online"} decide={(id, choice) => { void controller.decide(id, choice); }} /></div>
          </div>
        </div>
        <div ref={composerRef} className="composer-area"><div className="composer-dock">
          {controller.error && <div role="alert" className="notice mb-3">{controller.error}</div>}
          {controller.connection === "detached" && <button className="button-secondary mb-3" onClick={() => { setConversations((items) => items.filter((item) => item.id !== selected.id)); void openThread(selected.threadId, true); }}>Resume conversation</button>}
          <Composer key={selected.id} images={imageDrafts.images[selected.threadId] ?? []} onImages={(update) => imageDrafts.update(selected.threadId, update)}
            reading={imageDrafts.reading[selected.threadId] ?? false} imageError={imageDrafts.errors[selected.threadId] ?? null}
            addFiles={(files) => imageDrafts.addFiles(selected.threadId, files)} clearImageError={() => imageDrafts.clearError(selected.threadId)}
            draft={drafts[selected.threadId]?.text ?? ""} draftRevision={drafts[selected.threadId]?.revision ?? 0}
            onDraft={(text) => setDrafts((all) => ({ ...all, [selected.threadId]: { text, revision: (all[selected.threadId]?.revision ?? 0) + 1 } }))}
            clearDraft={(revision) => setDrafts((all) => {
              const current = all[selected.threadId];
              if ((current?.revision ?? 0) !== revision) return all;
              return { ...all, [selected.threadId]: { text: "", revision: revision + 1 } };
            })}
            send={controller.send} disabled={controller.connection !== "online"} busy={controller.busy} active={active} interrupt={() => { void controller.interrupt(); }} />
        </div></div>
      </section>}
    </main>
    <dialog ref={dialogRef} className="project-dialog" onCancel={(event) => { if (creating) event.preventDefault(); else setDialog(null); }} onClose={() => { if (!creating) setDialog(null); }}>
      <form onSubmit={(event) => { event.preventDefault(); void createConversation(); }}>
        <div className="mb-6 flex items-center justify-between"><h2 className="text-lg font-medium">{dialog?.title ?? "New conversation"}</h2><button type="button" className="icon-button" aria-label="Close" disabled={creating} onClick={() => setDialog(null)}><Icon name="close" /></button></div>
        <label htmlFor="project" className="mb-2 block text-sm font-medium">Project</label>
        <input id="project" autoFocus value={project} onChange={(event) => setProject(event.target.value)} placeholder="owner/repo or ~/project" required maxLength={4096} disabled={creating} />
        <p className="mt-3 text-xs leading-6 text-muted">Use a GitHub repository, a path starting with ~/ or ~ for a new local workspace.</p>
        {error && <p className="notice mt-4" role="alert">{error}</p>}
        <button className="button-primary mt-6 w-full justify-center" disabled={creating || !project.trim()}>{creating ? "Preparing workspace…" : "Create conversation"}<Icon name="chevron" /></button>
      </form>
    </dialog>
  </div>;
}
