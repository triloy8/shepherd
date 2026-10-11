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

import type { SurfaceAdapterContext } from "../server/runtime/surface_adapter.js";
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

import type { ProviderSession } from "../server/ports/provider_session.js";
import type { TurnStreamDeltaEvent } from "../shared/protocol/events.js";
import type { ApprovalRequestPayload } from "../shared/protocol/approvals.js";
function assertProviderBoundary(session: ProviderSession, delta: TurnStreamDeltaEvent, approval: ApprovalRequestPayload) {
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

import type { CreateThreadRequest, ListStoredThreadsRequest, ApprovalPolicy, SandboxMode } from "../shared/protocol/requests.js";
function assertNeutralConfiguration(create: CreateThreadRequest, list: ListStoredThreadsRequest) {
  // @ts-expect-error Raw SDK configuration belongs inside the adapter.
  create.config;
  // @ts-expect-error Native model backend overrides are not application configuration.
  create.modelProvider;
  // @ts-expect-error Native history source enums do not cross the port.
  list.sourceKinds;
  // @ts-expect-error Native storage implementation choices stay private.
  list.useStateDbOnly;
  // @ts-expect-error Native approval labels are not application modes.
  const approval: ApprovalPolicy = "untrusted";
  // @ts-expect-error Native sandbox labels are not application modes.
  const sandbox: SandboxMode = "danger-full-access";
  void approval; void sandbox;
}
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
  session.eventBus.publish({ ...metadata, type: "turn.stream.delta", payload: { method: "native/message", params: {} } });
  // @ts-expect-error Event names and payloads must agree at the adapter emitter too.
  bridgeEvent({ ...metadata, type: "turn.failed", payload: { turnId: "turn" } });
  if (event.type === "turn.stream.delta") {
    const text: string = event.payload.textDelta;
    // @ts-expect-error Discrimination exposes only this event's payload.
    event.payload.approvalId;
    void text;
  }
}
void assertEventPayloads;
