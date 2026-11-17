import { createApplicationConversation } from "../core/surface/conversation_ports.js";
import type { BridgeEvent } from "../../shared/protocol/events.js";
import type { AgentProvider } from "../../shared/protocol/requests.js";
import type { SurfaceApplicationContext } from "../core/surface/surface_application_context.js";
import { SurfaceConversationOrchestrator } from "../core/surface/surface_conversation_orchestrator.js";
import { SurfaceStateService } from "../core/surface/surface_state_service.js";
import {
  WorkspaceProvisioner,
  type WorkspaceProvisionerOptions,
} from "../core/workspace/workspace_provisioner.js";
import type { ConversationService } from "../core/conversation/conversation_service.js";
import { ApplicationActionError } from "../core/common/action_error.js";

export type SurfaceRuntimeOptions = {
  adapter: string;
  conversation: ConversationService;
  onThreadEvent: (surfaceId: string, event: BridgeEvent) => void;
  cloneGithubRepo: (slug: string, workspacePath: string) => Promise<void>;
  resolveGithubRepo: (slug: string) => Promise<string>;
  resolveGithubRepoFromWorkspace?: (workspacePath: string) => Promise<string | null>;
  workspaceProvisionerOptions?: Omit<WorkspaceProvisionerOptions, "cloneGithubRepo">;
  runtimeLifecycle?: SurfaceApplicationContext["runtimeLifecycle"];
};

export type SurfaceRuntime = {
  commandContext: SurfaceApplicationContext;
};

export function createSurfaceRuntime(
  options: SurfaceRuntimeOptions,
): SurfaceRuntime {
  const surfaceState = new SurfaceStateService();
  const workspaceProvisioner = new WorkspaceProvisioner({
    ...options.workspaceProvisionerOptions,
    cloneGithubRepo: options.cloneGithubRepo,
  });

  const orchestrator = new SurfaceConversationOrchestrator(
    options.conversation,
    surfaceState,
    workspaceProvisioner,
    {
      adapter: options.adapter,
      projectTargetResolver: {
        resolveGithubRepo: options.resolveGithubRepo,
        resolveGithubRepoFromWorkspace: options.resolveGithubRepoFromWorkspace,
      },
    },
  );

  const createSurfaceThread = (surfaceId: string, provider?: AgentProvider, instructions?: string): Promise<string> =>
    orchestrator.createAndBindSurfaceThread(surfaceId, (event) => options.onThreadEvent(surfaceId, event), provider, instructions);

  const forkSurfaceThread = (surfaceId: string, sourceThreadId: string): Promise<string> =>
    orchestrator.forkSurfaceThread(surfaceId, sourceThreadId, (event) => options.onThreadEvent(surfaceId, event));

  const switchSurfaceThread = (surfaceId: string, threadId: string, instructions?: string): Promise<string> =>
    orchestrator.switchSurfaceThread(surfaceId, threadId, (event) => options.onThreadEvent(surfaceId, event), instructions);

  const updateSurfaceInstructions = async (surfaceId: string, instructions: string): Promise<void> => {
    const threadId = options.conversation.getSurfaceThread(options.adapter, surfaceId);
    if (!threadId) throw new ApplicationActionError({ code: "thread_required" });
    await options.conversation.updateThreadInstructions(threadId, instructions);
  };

  const ensureSurfaceThread = (surfaceId: string): Promise<string> =>
    orchestrator.ensureSurfaceThread(surfaceId, (event) => options.onThreadEvent(surfaceId, event));

  return {
    commandContext: {
      conversation: createApplicationConversation(options.conversation),
      getSurfaceThreadId: (surfaceId) => options.conversation.getSurfaceThread(options.adapter, surfaceId),
      getSurfaceProject: (surfaceId) => orchestrator.getSurfaceProjectDisplay(surfaceId),
      getSurfaceListeningMode: (surfaceId) => orchestrator.getSurfaceListeningMode(surfaceId),
      setSurfaceListeningMode: (surfaceId, mode) =>
        orchestrator.setSurfaceListeningMode(surfaceId, mode),
      pauseSurfaceListening: (surfaceId) => orchestrator.pauseSurfaceListening(surfaceId),
      resumeSurfaceListening: (surfaceId) => orchestrator.resumeSurfaceListening(surfaceId),
      setSurfaceProject: (surfaceId, repoSlug) => orchestrator.setSurfaceProject(surfaceId, repoSlug),
      inheritSurfaceProject: (surfaceId, parentSurfaceId) =>
        orchestrator.inheritSurfaceProject(surfaceId, parentSurfaceId),
      ensureSurfaceThread,
      createSurfaceThread,
      switchSurfaceThread,
      updateSurfaceInstructions,
      forkSurfaceThread,
      disposeSurface: (surfaceId) => orchestrator.disposeSurface(surfaceId),
      clearSurfaceThread: (surfaceId) => {
        orchestrator.clearSurfaceThread(surfaceId);
      },
      runtimeLifecycle: options.runtimeLifecycle,
    },
  };
}
