import type * as P from "../../../shared/protocol/requests.js";
import type { Provider } from "../../ports/provider_session.js";
import { noProviderTools, type ProviderTools } from "../../ports/provider_tools.js";
import { codexCapabilities } from "./capabilities.js";
import { CodexSession } from "./session.js";

/** Codex app-server. A thread one of this provider's sessions is running is served by that
 * session's process, so its notifications reach the conversation; other history and discovery
 * use one app-server process with no thread bound. */
export class CodexProvider implements Provider {
  readonly capabilities = codexCapabilities;
  private readonly live = new Map<string, CodexSession>();
  private client: Promise<CodexSession> | null = null;
  constructor(private readonly createClient: () => CodexSession = () => new CodexSession("provider_default", noProviderTools)) {}
  openSession(policy: P.ApprovalPolicy, tools: ProviderTools): CodexSession { return new CodexSession(policy, tools, this.live); }
  /** The process for provider-wide requests, started on first use and replaced if it fails to start. */
  private history(threadId?: string): Promise<CodexSession> {
    const live = threadId ? this.live.get(threadId) : undefined;
    if (live) return Promise.resolve(live);
    this.client ??= (async () => { const client = this.createClient(); await client.initialize(); return client; })()
      .catch(error => { this.client = null; throw error; });
    return this.client;
  }
  async listStoredThreads(request: P.ListStoredThreadsRequest) { return (await this.history()).listStoredThreads(request); }
  async listLoadedThreads(request: P.ListLoadedThreadsRequest) { return (await this.history()).listLoadedThreads(request); }
  async readThread(id: string, includeTurns: boolean) { return (await this.history(id)).readThread(id, includeTurns); }
  async listThreadTurns(id: string, request: P.ListThreadTurnsRequest) { return (await this.history(id)).listThreadTurns(id, request); }
  async listThreadItems(id: string, request: P.ListThreadItemsRequest) { return (await this.history(id)).listThreadItems(id, request); }
  async setThreadName(id: string, name: string) { return (await this.history(id)).setThreadName(id, name); }
  async archiveThread(id: string) { return (await this.history(id)).archiveThread(id); }
  async unarchiveThread(id: string) { return (await this.history(id)).unarchiveThread(id); }
  async listModels(request: P.ListModelsRequest) { return (await this.history()).listModels(request); }
  stop(): void {
    const client = this.client; this.client = null;
    void client?.then(session => session.stop(), () => {});
  }
}
