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
}
void assertLauncherBoundary;
