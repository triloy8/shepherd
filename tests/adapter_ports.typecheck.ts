import type { SurfaceApplicationContext } from "../server/core/surface_application_context.js";
import type { InteractionConversation } from "../server/core/conversation_ports.js";
import type { DiscordMessageIngressDeps } from "../server/adapters/discord/message_ingress.js";

// Compiled by bun run check. No runtime calls or external services.
function assertBoundaries(context: SurfaceApplicationContext, interaction: InteractionConversation, ingress: DiscordMessageIngressDeps) {
  context.conversation.getThreadModel("thread");
  // @ts-expect-error Process shutdown is not a surface command capability.
  context.conversation.stopAll();
  // @ts-expect-error Tool registration belongs to runtime composition.
  context.conversation.registerDynamicTool({});
  // @ts-expect-error Surface binding must go through application orchestration.
  context.conversation.bindSurfaceToThread("surface", "id", "thread");
  // @ts-expect-error Approval/list interactions cannot submit turns.
  interaction.submitTurn("thread", { input: [] });
  // @ts-expect-error Message routing cannot archive threads.
  ingress.conversation.archiveThread("thread");
}
void assertBoundaries;

import type { SurfaceAdapterContext } from "../server/core/surface_adapter.js";
function assertLauncherBoundary(adapter: SurfaceAdapterContext) {
  // @ts-expect-error Only the host can stop the process runtime.
  adapter.shepherd.shutdown();
  // @ts-expect-error Ingress cannot stop all conversations.
  adapter.ingress.stopAll();
  // @ts-expect-error Approval handling cannot create raw sessions.
  adapter.interactions.createThread({});
  // @ts-expect-error The approval port cannot create sessions.
  adapter.approvals.createThread({});
  // @ts-expect-error The approval port cannot stop shared runtime.
  adapter.approvals.stopAll();
}
void assertLauncherBoundary;

import type { Provider, ThreadSession as ProviderSession } from "../server/ports/provider_session.js";
import type { ItemDeltaEvent } from "../shared/protocol/events.js";
import type { ApprovalRequestPayload } from "../shared/protocol/approvals.js";
function assertProviderBoundary(session: ProviderSession, delta: ItemDeltaEvent, approval: ApprovalRequestPayload) {
  // @ts-expect-error Native account quotas are not a session operation.
  session.readAccountRateLimits();
  // @ts-expect-error SDK method names do not enter application text streams.
  delta.payload.method;
  // @ts-expect-error Native approval envelopes remain private.
  approval.params;
  // @ts-expect-error Native server request methods remain private.
  approval.method;
}
void assertProviderBoundary;

import type { CreateThreadRequest, ListStoredThreadsRequest, ExecutionPolicy, SubmitTurnRequest } from "../shared/protocol/requests.js";
import type { ProviderSkillsRequest } from "../server/ports/provider_session.js";
import type { SkillsListRequest } from "../shared/protocol/requests.js";

function assertDiscoveryAndResetContracts(skills: SkillsListRequest, discovery: ProviderSkillsRequest, account: ProviderAccountLimits) {
  // @ts-expect-error Surfaces cannot redirect discovery into arbitrary directories.
  skills.workspacePath;
  // @ts-expect-error Native multi-directory discovery does not cross the port.
  discovery.cwds;
  // @ts-expect-error Native reload flags remain adapter-owned.
  discovery.forceReload;
  // @ts-expect-error Reset operation support comes only from provider capabilities.
  account.resets.supported;
}
void assertDiscoveryAndResetContracts;
function assertNeutralConfiguration(create: CreateThreadRequest, list: ListStoredThreadsRequest) {
  // @ts-expect-error Raw SDK configuration belongs inside the adapter.
  create.config;
  // @ts-expect-error Native model backend overrides are not application configuration.
  create.modelProvider;
  // @ts-expect-error Native history source enums do not cross the port.
  list.sourceKinds;
  // @ts-expect-error Native storage implementation choices stay private.
  list.useStateDbOnly;
  // @ts-expect-error Native sandbox labels are not policy restrictions.
  const writes: ExecutionPolicy["writes"] = "danger-full-access";
  // @ts-expect-error Native approval labels are not policy restrictions.
  const review: ExecutionPolicy["review"] = "untrusted";
  // @ts-expect-error Threads take one policy, not separate approval and sandbox modes.
  create.approvalPolicy;
  // @ts-expect-error Threads take one policy, not separate approval and sandbox modes.
  create.sandbox;
  void writes; void review;
}
function assertNoPerTurnPolicy(submit: SubmitTurnRequest) {
  // @ts-expect-error A thread's policy is fixed when it starts; turns do not override it.
  submit.approvalPolicy;
}
void assertNoPerTurnPolicy;
void assertNeutralConfiguration;

import type { ThreadRecord, ThreadModelState, ModelSummary, HistoryItem } from "../shared/protocol/requests.js";
import type { UserInput } from "../shared/protocol/user_input.js";
import type { DynamicToolCallOutputContentItem } from "../shared/protocol/dynamic_tools.js";
function assertNeutralRecords(thread: ThreadRecord, model: ThreadModelState, summary: ModelSummary) {
  // @ts-expect-error Native model backends are not thread metadata.
  thread.modelProvider;
  // @ts-expect-error Native session origins are not thread metadata.
  thread.source;
  // @ts-expect-error Thread model state names the owning agent, not a native backend.
  model.modelProvider;
  // @ts-expect-error A model is selected by its application ID.
  summary.model;
  // @ts-expect-error Effort options use neutral names.
  summary.supportedReasoningEfforts;
  // @ts-expect-error Native thread item names do not cross the boundary.
  const item: HistoryItem = { id: "item", type: "agentMessage", text: "native" };
  // @ts-expect-error Native local-file input names do not cross the boundary.
  const input: UserInput = { type: "localImage", path: "/tmp/image.png" };
  // @ts-expect-error Native dynamic-tool content names do not cross the boundary.
  const output: DynamicToolCallOutputContentItem = { type: "inputText", text: "native" };
  void item; void input; void output;
}
void assertNeutralRecords;


import { bridgeEvent, type BridgeEvent } from "../shared/protocol/events.js";
function assertEventPayloads(session: ProviderSession, event: BridgeEvent) {
  const metadata = { id: "event", threadId: "thread", sessionId: "session", ts: "now" };
  session.eventBus.publish({ ...metadata, type: "turn.completed", payload: { turnId: "turn" } });
  // @ts-expect-error A native envelope cannot replace the semantic stream payload.
  session.eventBus.publish({ ...metadata, type: "item.delta", payload: { method: "native/message", params: {} } });
  // @ts-expect-error Event names and payloads must agree at the adapter emitter too.
  bridgeEvent({ ...metadata, type: "turn.failed", payload: { turnId: "turn" } });
  if (event.type === "item.delta") {
    const text: string = event.payload.delta;
    // @ts-expect-error Discrimination exposes only this event's payload.
    event.payload.approvalId;
    void text;
  }
}
void assertEventPayloads;

import type { ThreadBootstrapInfo } from "../server/ports/provider_session.js";
function assertWorkspaceContract() {
  const complete: ThreadBootstrapInfo = { threadId: "thread", cwd: "/workspace", model: null, effort: null, profile: null };
  // @ts-expect-error A live provider thread must expose its effective workspace.
  const incomplete: ThreadBootstrapInfo = { threadId: "thread", model: null, effort: null, profile: null };
  // @ts-expect-error Bootstrap reports the policy profile the thread runs with.
  const unreported: ThreadBootstrapInfo = { threadId: "thread", cwd: "/workspace", model: null, effort: null };
  return [complete, incomplete, unreported];
}
void assertWorkspaceContract;

import type { WebEffortRequest } from "../shared/protocol/web.js";
function assertEffortRequestContract() {
  const selections: WebEffortRequest[] = [{ effort: "default" }, { effort: null }, { effort: { mode: "default" } }];
  // @ts-expect-error Clearing is null, not another object mode.
  const invalid: WebEffortRequest = { effort: { mode: "clear" } };
  return [selections, invalid];
}
void assertEffortRequestContract;

import type { ThreadTokenUsage } from "../shared/protocol/requests.js";
import type { ProviderAccountLimits } from "../shared/protocol/account_limits.js";

const partialUsage: ThreadTokenUsage = { last: null, total: { inputTokens: null, outputTokens: null, totalTokens: 42, cacheReadInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null }, contextWindow: null };
const unknownLogin: ProviderAccountLimits["account"] = { plan: null, authentication: "unknown", signedIn: null };
void partialUsage; void unknownLogin;

import type { BridgeEventType } from "../shared/protocol/events.js";
function assertStructuredActivity(step: Extract<HistoryItem, { type: "activity" }>, approval: ApprovalRequestPayload, item: Extract<HistoryItem, { type: "activity" }>) {
  // @ts-expect-error Surfaces write activity labels; adapters do not supply free text.
  step.label;
  // @ts-expect-error Activity details come from typed fields, not adapter-formatted strings.
  step.detail;
  // @ts-expect-error Activity kinds are application categories, not tool provenance.
  const kind: typeof step.activity.kind = "mcp_tool"; void kind;
  // @ts-expect-error Tool output does not cross the boundary.
  item.output;
  if (approval.kind === "permission") {
    // @ts-expect-error Permission prompts are written from the activity they would allow.
    approval.prompt;
    // @ts-expect-error Native tool input is not an approval detail.
    approval.detail;
  } else {
    // @ts-expect-error Questions carry their form, not an activity.
    const activity: NonNullable<typeof approval.activity> = { kind: "other", title: "x", detail: null }; void activity;
  }
}
void assertStructuredActivity;

function assertItemEvents(started: Extract<BridgeEventType, "item.started">, image: Extract<HistoryItem, { type: "image" }>) {
  // @ts-expect-error Assistant text, activities and images stream as items, not per-kind events.
  const old: BridgeEventType = "turn.stream.delta"; void old;
  // @ts-expect-error An image item is the image; its generation is a separate activity item.
  image.activity;
  void started;
}
void assertItemEvents;

import type { ProviderExecution } from "../server/ports/provider_session.js";
function assertEventSourcedState(session: ProviderExecution) {
  // @ts-expect-error Core learns the running turn from turn events, not an adapter field.
  session.activeTurnId;
  // @ts-expect-error Core learns the approval mode from bootstrap and settings events.
  session.approvalPolicy;
  // @ts-expect-error Background work is reported by thread.status.changed.
  session.backgroundTaskCount;
  // @ts-expect-error Turn settings are one object; the workspace is not a turn setting.
  void session.startTurn([], undefined, "model", "/workspace");
}
void assertEventSourcedState;

function assertProviderSplit(provider: Provider, session: ProviderSession) {
  // @ts-expect-error Conversation listing is the provider's, never a session's.
  void session.listStoredThreads({});
  // @ts-expect-error Reading another thread's history is the provider's.
  void session.readThread("thread", false);
  // @ts-expect-error A provider does not run turns; its sessions do.
  void provider.startTurn([], {});
  void provider.openSession({ hasTools: () => false, specifications: () => [], execute: async () => ({ contentItems: [], success: true }) });
}
void assertProviderSplit;
