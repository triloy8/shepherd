import type { Provider, ProviderHistory, ThreadSession } from "../../server/ports/provider_session.js";
import type { ProviderLookup } from "../../server/ports/provider_services.js";
import type { ProviderCapabilities } from "../../shared/protocol/provider_capabilities.js";
import { noProviderTools, type ProviderTools } from "../../server/ports/provider_tools.js";

/** A test fake that runs a thread and also answers history, as one object. */
export type TestSession = ThreadSession & ProviderHistory;
export type TestSessionFactory = (tools: ProviderTools, provider: string) => TestSession;

/** A provider built from session fakes. Like the installed adapters, it serves a running thread
 * through its session and everything else through one reader session opened on first use. */
export function sessionProvider(open: TestSessionFactory, capabilities?: ProviderCapabilities, id = "default"): Provider {
  const live = new Map<string, TestSession>();
  let reader: Promise<TestSession> | undefined;
  let first: TestSession | undefined;
  const opened = (tools: ProviderTools) => { const session = open(tools, id); first ??= session; return session; };
  const target = async (threadId?: string): Promise<TestSession> => {
    const running = threadId ? live.get(threadId) : undefined;
    if (running) return running;
    reader ??= (async () => { const session = opened(noProviderTools); await session.initialize(); return session; })();
    return reader;
  };
  const track = (session: TestSession): TestSession => {
    for (const method of ["startThread", "resumeThread", "forkThread"] as const) {
      const bootstrap = session[method] as ((...args: unknown[]) => Promise<{ threadId: string }>) | undefined;
      if (!bootstrap) continue;
      (session as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        const result = await bootstrap.apply(session, args);
        live.set(result.threadId, session);
        return result;
      };
    }
    return session;
  };
  const delegate = <K extends keyof ProviderHistory | "listModels">(method: K, threadArg: boolean) => async (...args: unknown[]) => {
    const session = await target(threadArg ? args[0] as string : undefined) as unknown as Record<string, (...input: unknown[]) => unknown>;
    if (typeof session[method] !== "function") throw new Error(`Test session does not implement ${method}.`);
    return session[method]!(...args);
  };
  return {
    get capabilities() { return capabilities ?? (first ??= open(noProviderTools, id)).capabilities; },
    openSession: tools => track(opened(tools)),
    listStoredThreads: delegate("listStoredThreads", false) as Provider["listStoredThreads"],
    listLoadedThreads: (async request => {
      const session = await target();
      return session.listLoadedThreads ? session.listLoadedThreads(request) : { data: [], nextCursor: null };
    }) as Provider["listLoadedThreads"],
    readThread: delegate("readThread", true) as Provider["readThread"],
    listThreadTurns: delegate("listThreadTurns", true) as Provider["listThreadTurns"],
    listThreadItems: delegate("listThreadItems", true) as Provider["listThreadItems"],
    setThreadName: delegate("setThreadName", true) as Provider["setThreadName"],
    archiveThread: delegate("archiveThread", true) as Provider["archiveThread"],
    unarchiveThread: delegate("unarchiveThread", true) as Provider["unarchiveThread"],
    listModels: delegate("listModels", false) as Provider["listModels"],
  };
}

/** Providers for each ID, built from one session factory. */
export function sessionProviders(open: TestSessionFactory): ProviderLookup {
  const providers = new Map<string, Provider>();
  return id => {
    let provider = providers.get(id);
    if (!provider) providers.set(id, provider = sessionProvider(open, undefined, id));
    return provider;
  };
}
