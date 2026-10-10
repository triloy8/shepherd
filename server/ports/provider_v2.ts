import type { ConversationInput } from "../../shared/protocol/v2/conversation_items.js";
import type { ProviderAccountLimits } from "../../shared/protocol/v2/account_limits.js";
import type {
  CreateThreadRequest, ForkThreadRequest, HistoryPage, ModelSummary, Page, ProviderId,
  ResumeThreadRequest, RevertThreadResponse, ThreadBootstrapInfo, ThreadFilter, ThreadRecord, TurnInput, TurnPage,
} from "../../shared/protocol/v2/conversations.js";
import type { ProviderMutation } from "../../shared/protocol/v2/events.js";
import type { InteractionReply } from "../../shared/protocol/v2/interactions.js";

/** Additive v2 port. Adapters are migrated to this contract in later stages. */
export interface ProviderSession {
  readonly provider: ProviderId;
  readonly sessionId: string;
  readonly activeTurnId: string | null;
  readonly backgroundTaskCount: number;
  readonly events: { subscribe(listener: (event: ProviderMutation) => void): () => void };
  initialize(): Promise<void>;
  startThread(request: CreateThreadRequest): Promise<ThreadBootstrapInfo>;
  resumeThread(threadId: string, request: ResumeThreadRequest): Promise<ThreadBootstrapInfo>;
  startTurn(input: TurnInput): Promise<string>;
  interruptTurn(turnId?: string): Promise<void>;
  respond(requestId: string, reply: InteractionReply): Promise<void>;
  setCwd(cwd: string): Promise<void>;
  stop(): Promise<void>;
  readonly steering?: { steer(input: ConversationInput, turnId: string): Promise<string> };
  readonly fork?: { fork(threadId: string, request: ForkThreadRequest): Promise<ThreadBootstrapInfo> };
  readonly compaction?: { compact(threadId: string): Promise<void> };
  readonly revert?: { revertBefore(threadId: string, turnId: string): Promise<RevertThreadResponse> };
}
export interface ProviderHistory {
  listThreads(filter: ThreadFilter): Promise<Page<ThreadRecord>>;
  readThread(threadId: string): Promise<ThreadRecord>;
  listTurns(threadId: string, cursor?: string): Promise<TurnPage>;
  listItems(threadId: string, cursor?: string): Promise<HistoryPage>;
  rename(threadId: string, name: string): Promise<void>;
  archive(threadId: string, archived: boolean): Promise<void>;
}
export interface ProviderLimitResets {
  list(): Promise<ProviderAccountLimits["resets"]>;
  consume(request: { idempotencyKey: string; creditId?: string }): Promise<{
    outcome: "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit";
  }>;
}
export interface ProviderServices {
  createSession(): ProviderSession;
  history: ProviderHistory;
  catalog: { listModels(cursor?: string): Promise<Page<ModelSummary>> };
  skills?: {
    list?: (cwd: string) => Promise<Array<{ referenceId: string; name: string; description: string; enabled: boolean }>>;
    configure?: (referenceId: string, enabled: boolean) => Promise<{ enabled: boolean }>;
  };
  account?: { read(): Promise<ProviderAccountLimits>; resets?: ProviderLimitResets };
  shutdown(): Promise<void>;
}
