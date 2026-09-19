import { useCallback, useEffect, useRef, useState } from "react";
import type { StoredThreadSummary } from "../../shared/protocol/requests";
import type { WebConversation } from "../../shared/protocol/web";
import { api, explainError } from "./api";
import { useConversation } from "./use-conversation";
import { Icon } from "./components/Icon";
import { Timeline } from "./components/Timeline";
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
  const [threads, setThreads] = useState<StoredThreadSummary[]>([]);
  const [threadsCursor, setThreadsCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<WebConversation | null>(null);
  const [saved, setSaved] = useState<WebConversation | null>(savedSelection);
  const [drawer, setDrawer] = useState(false);
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const [dialog, setDialog] = useState<{ threadId?: string; title: string } | null>(null);
  const [project, setProject] = useState("~");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const initialSelection = useRef(true);
  const controller = useConversation(selected);
  const thread = threads.find((item) => item.threadId === selected?.threadId);
  const title = thread ? label(thread) : selected ? "New conversation" : "Your workspace, in conversation";

  const refreshList = useCallback(async () => {
    try {
      const [handles, stored] = await Promise.all([api.conversations(), api.threads()]);
      setConversations(handles.conversations); setThreads(stored.threads); setThreadsCursor(stored.nextCursor); setError(null);
      if (initialSelection.current) {
        initialSelection.current = false;
        const previous = savedSelection();
        const handle = handles.conversations.find((item) => item.threadId === previous?.threadId);
        if (handle) { setSelected(handle); setSaved(null); }
      }
    } catch (error) { setError(explainError(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refreshList(); const onOnline = () => { void refreshList(); }; window.addEventListener("online", onOnline); return () => window.removeEventListener("online", onOnline); }, [refreshList]);
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
  }, [controller.chat.messages, controller.approvals, controller.chat.activity]);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const change = () => setDesktop(query.matches);
    query.addEventListener("change", change); return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (drawer) sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [drawer]);

  function select(conversation: WebConversation) { setSelected(conversation); setSaved(null); setDrawer(false); }
  function openThread(threadId: string, title: string) {
    const existing = conversations.find((item) => item.threadId === threadId);
    if (existing) select(existing);
    else { setProject(saved?.threadId === threadId ? saved.project : "~"); setDialog({ threadId, title }); setDrawer(false); }
  }
  async function createConversation() {
    if (creating || !project.trim() || !dialog) return;
    setCreating(true); setError(null);
    try {
      const conversation = await api.create({ project: project.trim(), ...(dialog.threadId ? { threadId: dialog.threadId } : {}) });
      setConversations((items) => [...items.filter((item) => item.id !== conversation.id), conversation]);
      select(conversation); setDialog(null); void refreshList();
    } catch (error) { setError(`${explainError(error)} Refresh the conversation list before retrying if the connection dropped.`); }
    finally { setCreating(false); }
  }
  async function loadThreads() {
    if (!threadsCursor || loadingThreads) return;
    setLoadingThreads(true);
    try {
      const page = await api.threads(threadsCursor);
      setThreads((items) => [...items, ...page.threads.filter((item) => !items.some((existing) => existing.threadId === item.threadId))]); setThreadsCursor(page.nextCursor);
    } catch (error) { setError(explainError(error)); }
    finally { setLoadingThreads(false); }
  }
  async function detach() {
    if (!selected || detaching) return;
    const id = selected.id;
    setDetaching(true);
    try { await api.detach(id); setSelected(null); setSaved(null); try { localStorage.removeItem("shepherd.selection"); } catch { /* Storage is optional. */ } await refreshList(); }
    catch (error) { setError(explainError(error)); }
    finally { setDetaching(false); }
  }

  const active = Boolean(controller.chat.activeTurnId);
  const status = controller.connection === "online" ? active ? "Working" : "Connected" : controller.connection === "detached" ? "Needs attention" : controller.connection === "reconnecting" ? "Reconnecting" : "Connecting";
  const visibleHandles = conversations.filter((item) => !threads.some((thread) => thread.threadId === item.threadId));
  return <div className="app-shell">
    {drawer && <button className="drawer-backdrop" aria-label="Close conversations" onClick={() => setDrawer(false)} />}
    <aside inert={!desktop && !drawer} role={desktop ? "complementary" : "dialog"} aria-modal={!desktop && drawer ? true : undefined} ref={sidebarRef} className={`sidebar ${drawer ? "sidebar-open" : ""}`} aria-label="Conversations">
      <div className="flex h-20 shrink-0 items-center justify-between px-5">
        <a href="/" className="flex items-center gap-2.5 font-semibold tracking-tight"><span className="text-lg">shepherd<span className="text-accent">.</span></span></a>
        <button className="icon-button lg:hidden" aria-label="Close conversations" onClick={() => setDrawer(false)}><Icon name="close" /></button>
      </div>
      <div className="px-4"><button className="new-conversation" onClick={() => { setDialog({ title: "New conversation" }); setProject("~"); setDrawer(false); }}><Icon name="plus" /><span>New conversation</span></button></div>
      <div className="mb-2 mt-7 flex items-center justify-between px-5 text-[10px] font-semibold uppercase tracking-[.16em] text-dim"><span>Conversations</span><button className="icon-button size-7!" aria-label="Refresh conversations" onClick={() => void refreshList()}><Icon name="refresh" className="size-3.5" /></button></div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {loading && <p className="px-3 py-4 text-sm text-muted">Loading conversations…</p>}
        {!loading && !threads.length && !conversations.length && <p className="px-3 py-4 text-sm leading-6 text-dim">A fresh start.<br />Your conversations will appear here.</p>}
        {visibleHandles.map((item) => <button className={`thread-button ${selected?.id === item.id ? "thread-selected" : ""}`} key={item.id} onClick={() => select(item)}><Icon name="chat" /><span className="truncate">New conversation</span><span className="status-dot ml-auto" /></button>)}
        {threads.map((item) => <button title={label(item)} className={`thread-button ${selected?.threadId === item.threadId ? "thread-selected" : ""}`} key={item.threadId} onClick={() => openThread(item.threadId, label(item))}><Icon name="chat" /><span className="truncate">{label(item)}</span>{conversations.some((c) => c.threadId === item.threadId) && <span className="status-dot ml-auto" />}</button>)}
        {threadsCursor && <button className="mt-3 w-full rounded-lg py-2 text-xs text-muted hover:text-ink" onClick={() => void loadThreads()} disabled={loadingThreads}>{loadingThreads ? "Loading…" : "Load more conversations"}</button>}
      </nav>
      <div className="sidebar-footer"><span className="status-dot" /><span>Private workspace</span><span className="ml-auto text-dim">Web</span></div>
    </aside>
    <main className="main-pane" inert={!desktop && drawer}>
      <header className="main-header">
        <button className="icon-button lg:hidden" aria-label="Open conversations" aria-expanded={drawer} onClick={() => setDrawer(true)}><Icon name="menu" /></button>
        <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-medium">{selected ? title : "Workspace"}</h1>{selected && <p className="mt-1 flex items-center gap-1.5 text-xs text-dim"><Icon name="folder" className="size-3" /><span className="truncate">{selected.project}</span></p>}</div>
        {selected && <><div role="status" className="flex items-center gap-2 text-xs text-muted"><span className={`status-dot ${controller.connection !== "online" ? "status-dot-muted" : ""}`} />{status}</div><button className="icon-button ml-1" aria-label="Detach conversation" title="Detach without stopping agent work" disabled={detaching || controller.busy} onClick={() => void detach()}><Icon name="detach" /></button></>}
      </header>
      {error && !dialog && <div className="notice mx-5 mt-4" role="alert">{error}<button className="ml-3 underline" onClick={() => void refreshList()}>Refresh</button></div>}
      {!selected ? <section className="empty-screen">
        <p className="mb-3 mt-7 text-[11px] font-medium uppercase tracking-[.2em] text-accent">A little direction. A lot of possibility.</p>
        <h2 className="max-w-lg text-balance text-3xl font-medium leading-tight tracking-tight sm:text-4xl">What shall we work on?</h2>
        <p className="mt-4 max-w-md text-balance text-sm leading-7 text-muted">A space to build, explore, and pick up where you left off. Choose a conversation or start something new.</p>
        <button className="button-primary mt-7" onClick={() => { setDialog({ title: "New conversation" }); setProject("~"); }}><Icon name="plus" />Start a conversation</button>
        {saved && <button className="mt-5 text-sm text-muted underline decoration-line underline-offset-4" onClick={() => openThread(saved.threadId, "Resume last conversation")}>Resume your last conversation</button>}
        <div className="welcome-footnote"><Icon name="folder" /><span>Your projects. Your conversations. One place.</span></div>
      </section> : <>
        <div className="chat-scroll" ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
          <div className="chat-width pb-6 pt-6 sm:pt-10">
            {controller.historyCursor && <button className="mb-6 w-full text-xs text-muted hover:text-ink" disabled={controller.loadingHistory} onClick={() => { follow.current = false; void controller.loadOlder(); }}>{controller.loadingHistory ? "Loading…" : "Load earlier messages"}</button>}
            {!controller.chat.messages.length && <div className="py-14 text-center"><h2 className="text-xl font-medium">A new thread of thought</h2><p className="mt-3 text-sm text-muted">Tell Shepherd what you have in mind.</p></div>}
            <Timeline chat={controller.chat} />
            {active && <div role="status" className="mt-7 flex items-center gap-2 text-xs text-muted"><span className="working-dot" />{controller.chat.activity || "Working"}</div>}
            {controller.chat.error && <p role="alert" className="notice mt-5">{controller.chat.error}</p>}
            <div className="mt-6"><Approvals approvals={controller.approvals} busy={controller.busy || controller.connection !== "online"} decide={(id, choice) => { void controller.decide(id, choice); }} /></div>
          </div>
        </div>
        <div className="composer-area"><div className="chat-width">
          {controller.error && <div role="alert" className="notice mb-3">{controller.error}</div>}
          {controller.connection === "detached" && <button className="button-secondary mb-3" onClick={() => { setConversations((items) => items.filter((item) => item.id !== selected.id)); setProject(selected.project); setDialog({ threadId: selected.threadId, title: "Resume conversation" }); }}>Resume conversation</button>}
          <Composer key={selected.id} draft={drafts[selected.threadId] ?? ""} onDraft={(value) => setDrafts((all) => ({ ...all, [selected.threadId]: value }))} send={controller.send} disabled={controller.connection !== "online"} busy={controller.busy} active={active} interrupt={() => { void controller.interrupt(); }} />
          <p className="composer-caption">{active ? "You can leave this page. Shepherd will keep working." : "Enter to send · Shift + Enter for a new line"}</p>
        </div></div>
      </>}
    </main>
    <dialog ref={dialogRef} className="project-dialog" onCancel={(event) => { if (creating) event.preventDefault(); else setDialog(null); }} onClose={() => { if (!creating) setDialog(null); }}>
      <form onSubmit={(event) => { event.preventDefault(); void createConversation(); }}>
        <div className="mb-6 flex items-center justify-between"><h2 className="text-lg font-medium">{dialog?.threadId ? "Resume conversation" : "New conversation"}</h2><button type="button" className="icon-button" aria-label="Close" disabled={creating} onClick={() => setDialog(null)}><Icon name="close" /></button></div>
        {dialog?.threadId && <p className="mb-5 truncate text-sm text-muted">{dialog.title}</p>}
        <label htmlFor="project" className="mb-2 block text-sm font-medium">Project</label>
        <input id="project" autoFocus value={project} onChange={(event) => setProject(event.target.value)} placeholder="owner/repo or ~/project" required maxLength={4096} disabled={creating} />
        <p className="mt-3 text-xs leading-6 text-muted">Use a GitHub repository, a path starting with ~/ or ~ for a new local workspace.{dialog?.threadId ? " Choose the original project when resuming." : ""}</p>
        {error && <p className="notice mt-4" role="alert">{error}</p>}
        <button className="button-primary mt-6 w-full justify-center" disabled={creating || !project.trim()}>{creating ? "Preparing workspace…" : dialog?.threadId ? "Resume conversation" : "Create conversation"}<Icon name="chevron" /></button>
      </form>
    </dialog>
  </div>;
}
