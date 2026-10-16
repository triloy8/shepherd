import { Buffer } from "node:buffer";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type { ThreadRecord } from "../../shared/protocol/requests.js";
import type { Provider, ProviderEvents, ThreadSession } from "../ports/provider_session.js";
import type { ProviderTools } from "../ports/provider_tools.js";

const prefix = "shepherd-thread:";

/** Provider-local IDs become stable application IDs without requiring native UUIDs. */
export function scopedThreadId(provider: string, nativeId: string): string {
  if (!nativeId) throw new Error("Invalid native thread identity.");
  return prefix + Buffer.from(JSON.stringify([provider, nativeId])).toString("base64url");
}

export function parseScopedThreadId(id: string): { provider: string; nativeId: string } | null {
  if (!id.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(id.slice(prefix.length), "base64url").toString());
    if (!Array.isArray(value) || value.length !== 2 || value.some(part => typeof part !== "string" || !part)) throw new Error();
    const [provider, nativeId] = value as [string, string];
    if (scopedThreadId(provider, nativeId) !== id) throw new Error();
    return { provider, nativeId };
  } catch { throw new Error("Invalid scoped thread identity."); }
}

function nativeThreadId(provider: string, id: string): string {
  const identity = parseScopedThreadId(id);
  if (!identity || identity.provider !== provider) throw new Error("Thread identity belongs to another provider.");
  return identity.nativeId;
}

function eventThread(event: BridgeEvent, translate: (id: string) => string): BridgeEvent {
  const payload = event.type === "approval.requested" && event.payload.userInput
    ? { ...event.payload, userInput: { ...event.payload.userInput, threadId: translate(event.payload.userInput.threadId) } }
    : event.payload;
  return { ...event, threadId: translate(event.threadId), payload } as BridgeEvent;
}

export function scopedProviderTools(provider: string, tools: ProviderTools): ProviderTools {
  return {
    hasTools: () => tools.hasTools(), specifications: () => tools.specifications(),
    execute: request => tools.execute({ ...request, threadId: scopedThreadId(provider, request.threadId) }),
  };
}

/** Translate every thread-bearing session operation at the composition boundary, including replay. */
export function scopedThreadSession(provider: string, session: ThreadSession): ThreadSession {
  const outward = (id: string) => scopedThreadId(provider, id);
  const inward = (id: string) => nativeThreadId(provider, id);
  const record = (thread: ThreadRecord): ThreadRecord => ({ ...thread, id: outward(thread.id) });
  const bootstrap = (result: Awaited<ReturnType<ThreadSession["startThread"]>>) => ({ ...result, threadId: outward(result.threadId) });
  const events: ProviderEvents = {
    publish: event => session.eventBus.publish(eventThread(event, inward)),
    subscribe: (listener, cursor) => session.eventBus.subscribe(event => listener(eventThread(event, outward)), cursor),
  };
  const methods: Partial<ThreadSession> = {
    eventBus: events,
    startThread: async request => bootstrap(await session.startThread(request)),
    resumeThread: async (id, request) => bootstrap(await session.resumeThread(inward(id), request)),
  };
  if (session.forkThread) methods.forkThread = async (id, request) => bootstrap(await session.forkThread!(inward(id), request));
  if (session.listModels) methods.listModels = request => session.listModels!({ ...request, ...(request.threadId ? { threadId: inward(request.threadId) } : {}) });
  if (session.compactThread) methods.compactThread = id => session.compactThread!(inward(id));
  if (session.revertThread) methods.revertThread = async (id, before) => { const result = await session.revertThread!(inward(id), before); return { ...result, thread: record(result.thread) }; };
  return withMethods(session, methods);
}

/** Translate a provider's history and the sessions it opens. */
export function scopedProvider(provider: string, native: Provider): Provider {
  const outward = (id: string) => scopedThreadId(provider, id);
  const inward = (id: string) => nativeThreadId(provider, id);
  const record = (thread: ThreadRecord): ThreadRecord => ({ ...thread, id: outward(thread.id) });
  const methods: Partial<Provider> = {
    openSession: tools => scopedThreadSession(provider, native.openSession(tools)),
    readThread: async (id, turns) => { const result = await native.readThread(inward(id), turns); return { ...result, thread: record(result.thread) }; },
    listStoredThreads: async request => { const result = await native.listStoredThreads(request); return { ...result, data: result.data.map(record) }; },
    listThreadTurns: (id, request) => native.listThreadTurns(inward(id), request),
    listThreadItems: (id, request) => native.listThreadItems(inward(id), request),
  };
  if (native.listLoadedThreads) methods.listLoadedThreads = async request => { const result = await native.listLoadedThreads!(request); return { ...result, data: result.data.map(outward) }; };
  if (native.setThreadName) methods.setThreadName = (id, name) => native.setThreadName!(inward(id), name);
  if (native.archiveThread) methods.archiveThread = id => native.archiveThread!(inward(id));
  if (native.unarchiveThread) methods.unarchiveThread = id => native.unarchiveThread!(inward(id));
  return withMethods(native, methods);
}

/** The target with some methods replaced; state stays on the target. */
export function withMethods<T extends object>(target: T, methods: Partial<T>): T {
  return new Proxy(target, {
    get(object, key) {
      if (Object.hasOwn(methods, key)) return Reflect.get(methods, key);
      const value = Reflect.get(object, key, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}
