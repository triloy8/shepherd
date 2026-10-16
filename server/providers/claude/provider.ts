import type * as P from "../../../shared/protocol/requests.js";
import type { Provider } from "../../ports/provider_session.js";
import type { ProviderTools } from "../../ports/provider_tools.js";
import { claudeCapabilities } from "./capabilities.js";
import { claudeAuthenticationOptions } from "./authentication.js";
import type { ClaudeLimitsObserver } from "./account_limits.js";
import { ClaudeModelCache } from "./model_cache.js";
import { archivedTag, claudeNative, type ClaudeNative } from "./native_sessions.js";
import { ClaudeSession, catalogQueryOptions, claudeModelPage, claudeSupportedModels } from "./session.js";
import { itemPage, listClaudeThreads, readStoredThread, storedTurns, turnPage } from "./history.js";

/** Claude Code: conversations are Claude's sessions, read through the SDK. A thread one of this
 * provider's sessions is running is served by that session, which knows its in-progress turn
 * and any change requested before Claude created the session. */
export class ClaudeProvider implements Provider {
  readonly capabilities = claudeCapabilities;
  private readonly running = new Map<string, ClaudeSession>();
  constructor(
    private readonly sdk: ClaudeNative = claudeNative,
    private readonly limits?: ClaudeLimitsObserver,
    private readonly models = new ClaudeModelCache(),
  ) {}
  openSession(policy: P.ApprovalPolicy, tools: ProviderTools): ClaudeSession {
    return new ClaudeSession(policy, tools, this.sdk, this.limits, this.models, this.running);
  }
  listStoredThreads(request: P.ListStoredThreadsRequest) { return listClaudeThreads(this.sdk, request); }
  readThread(id: string, includeTurns: boolean) { return this.running.get(id)?.readThread(id, includeTurns) ?? readStoredThread(this.sdk, id, includeTurns); }
  async listThreadTurns(id: string, request: P.ListThreadTurnsRequest) { return this.running.get(id)?.listThreadTurns(id, request) ?? turnPage(await storedTurns(this.sdk, id), request); }
  async listThreadItems(id: string, request: P.ListThreadItemsRequest) { return this.running.get(id)?.listThreadItems(id, request) ?? itemPage(await storedTurns(this.sdk, id), request); }
  setThreadName(id: string, name: string) { return this.running.get(id)?.setThreadName(id, name) ?? this.sdk.renameSession(id, name); }
  archiveThread(id: string) { return this.running.get(id)?.archiveThread(id) ?? this.sdk.tagSession(id, archivedTag); }
  unarchiveThread(id: string) { return this.running.get(id)?.unarchiveThread(id) ?? this.sdk.tagSession(id, null); }
  async listModels(request: P.ListModelsRequest) {
    const models = await claudeSupportedModels(this.models,
      input => this.sdk.query({ prompt: input, options: { ...catalogQueryOptions(), ...claudeAuthenticationOptions() } }),
      running => running.close());
    return claudeModelPage(models, request);
  }
  stop(): void { for (const session of [...this.running.values()]) session.stop(); }
}
