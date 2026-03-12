import type { BridgeEvent } from "../../../shared/protocol/events.js";
import type { ApprovalPolicy, SandboxMode } from "../../../shared/protocol/requests.js";
import type { CommandContext } from "./commands.js";
import { SurfaceConversationOrchestrator } from "../../core/surface_conversation_orchestrator.js";
import { SurfaceStateService } from "../../core/surface_state_service.js";
import {
  WorkspaceProvisioner,
  type WorkspaceProvisionerOptions,
} from "../../core/workspace_provisioner.js";
import type { ConversationService } from "../../core/conversation_service.js";

export type DiscordSurfaceRuntimeOptions = {
  conversation: ConversationService;
  approvalPolicy: ApprovalPolicy;
  defaultSandbox?: SandboxMode;
  onThreadEvent: (surfaceId: string, event: BridgeEvent) => void;
  cloneGithubRepo: (slug: string, workspacePath: string) => Promise<void>;
  resolveGithubRepo: (slug: string) => Promise<string>;
  workspaceProvisionerOptions?: Omit<WorkspaceProvisionerOptions, "cloneGithubRepo">;
};

export type DiscordSurfaceRuntime = {
  commandContext: CommandContext;
};

export function createDiscordSurfaceRuntime(
  options: DiscordSurfaceRuntimeOptions,
): DiscordSurfaceRuntime {
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
      adapter: "discord",
      approvalPolicy: options.approvalPolicy,
      sandbox: options.defaultSandbox,
      projectTargetResolver: {
        resolveGithubRepo: options.resolveGithubRepo,
      },
    },
  );

  const createSurfaceThread = (surfaceId: string): Promise<string> =>
    orchestrator.createAndBindSurfaceThread(surfaceId, (event) => options.onThreadEvent(surfaceId, event));

  const forkSurfaceThread = (surfaceId: string, sourceThreadId: string): Promise<string> =>
    orchestrator.forkSurfaceThread(surfaceId, sourceThreadId, (event) => options.onThreadEvent(surfaceId, event));

  const switchSurfaceThread = (surfaceId: string, threadId: string): Promise<string> =>
    orchestrator.switchSurfaceThread(surfaceId, threadId, (event) => options.onThreadEvent(surfaceId, event));

  const ensureSurfaceThread = (surfaceId: string): Promise<string> =>
    orchestrator.ensureSurfaceThread(surfaceId, (event) => options.onThreadEvent(surfaceId, event));

  return {
    commandContext: {
      conversation: options.conversation,
      getSurfaceThreadId: (surfaceId) => options.conversation.getSurfaceThread("discord", surfaceId),
      getSurfaceProject: (surfaceId) => orchestrator.getSurfaceProjectDisplay(surfaceId),
      setSurfaceProject: (surfaceId, repoSlug) => orchestrator.setSurfaceProject(surfaceId, repoSlug),
      ensureSurfaceThread,
      createSurfaceThread,
      switchSurfaceThread,
      forkSurfaceThread,
      clearSurfaceThread: (surfaceId) => {
        orchestrator.clearSurfaceThread(surfaceId);
      },
    },
  };
}
