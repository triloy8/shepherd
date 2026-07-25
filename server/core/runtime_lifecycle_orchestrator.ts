import type { DeploymentResult } from "./deployment_service.js";
import type { RuntimeActivity } from "./session_manager.js";

export type RuntimeLifecycleAction = "restart" | "deploy";

export type RuntimeRestartAnnouncement =
  | { action: "restart" }
  | { action: "deploy"; deployment: DeploymentResult };

export type RuntimeLifecycleResult =
  | {
      type: "restart-requested";
      action: RuntimeLifecycleAction;
      deployment?: DeploymentResult;
    }
  | {
      type: "busy";
      action: RuntimeLifecycleAction;
      stage: "before-operation" | "after-quiescing";
      activity: RuntimeActivity;
      deployment?: DeploymentResult;
    }
  | {
      type: "deployment-in-progress";
      action: RuntimeLifecycleAction;
    }
  | {
      type: "deployment-failed";
      message: string;
    }
  | {
      type: "restart-already-scheduled";
      action: RuntimeLifecycleAction;
      deployment?: DeploymentResult;
    };

export type RuntimeLifecyclePort = {
  prepareRestart: () => boolean;
  cancelRestart: () => void;
  requestRestart: () => void;
};

export type RuntimeDeploymentPort = {
  isDeploymentInProgress: () => boolean;
  deployLatestMain: () => Promise<DeploymentResult>;
};

export type RuntimeLifecycleOrchestratorOptions = {
  readActivity: () => RuntimeActivity;
  deployment: RuntimeDeploymentPort;
  lifecycle: RuntimeLifecyclePort;
};

export type RestartOptions = {
  announce: (value: RuntimeRestartAnnouncement) => Promise<void>;
};

export type DeployOptions = RestartOptions & {
  onDeploymentStarted?: () => Promise<void>;
};

function hasActivity(activity: RuntimeActivity): boolean {
  return activity.activeTurnThreadIds.length > 0 || activity.pendingApprovalIds.length > 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RuntimeLifecycleOrchestrator {
  private deploymentOperationInProgress = false;

  constructor(private readonly options: RuntimeLifecycleOrchestratorOptions) {}

  async restart(options: RestartOptions): Promise<RuntimeLifecycleResult> {
    if (this.isDeploymentInProgress()) {
      return { type: "deployment-in-progress", action: "restart" };
    }

    const activity = this.options.readActivity();
    if (hasActivity(activity)) {
      return {
        type: "busy",
        action: "restart",
        stage: "before-operation",
        activity,
      };
    }

    return this.prepareAndRestart({ action: "restart" }, options.announce);
  }

  async deploy(options: DeployOptions): Promise<RuntimeLifecycleResult> {
    const activity = this.options.readActivity();
    if (hasActivity(activity)) {
      return {
        type: "busy",
        action: "deploy",
        stage: "before-operation",
        activity,
      };
    }

    if (this.isDeploymentInProgress()) {
      return { type: "deployment-in-progress", action: "deploy" };
    }

    this.deploymentOperationInProgress = true;
    try {
      await options.onDeploymentStarted?.();

      let deployment: DeploymentResult;
      try {
        deployment = await this.options.deployment.deployLatestMain();
      } catch (error) {
        return {
          type: "deployment-failed",
          message: formatError(error),
        };
      }

      return await this.prepareAndRestart({ action: "deploy", deployment }, options.announce);
    } finally {
      this.deploymentOperationInProgress = false;
    }
  }

  private isDeploymentInProgress(): boolean {
    return this.deploymentOperationInProgress || this.options.deployment.isDeploymentInProgress();
  }

  private async prepareAndRestart(
    announcement: RuntimeRestartAnnouncement,
    announce: (value: RuntimeRestartAnnouncement) => Promise<void>,
  ): Promise<RuntimeLifecycleResult> {
    const { action } = announcement;
    const deployment = announcement.action === "deploy" ? announcement.deployment : undefined;

    if (!this.options.lifecycle.prepareRestart()) {
      return {
        type: "restart-already-scheduled",
        action,
        ...(deployment ? { deployment } : {}),
      };
    }

    const activity = this.options.readActivity();
    if (hasActivity(activity)) {
      this.options.lifecycle.cancelRestart();
      return {
        type: "busy",
        action,
        stage: "after-quiescing",
        activity,
        ...(deployment ? { deployment } : {}),
      };
    }

    try {
      await announce(announcement);
    } catch (error) {
      this.options.lifecycle.cancelRestart();
      throw error;
    }

    this.options.lifecycle.requestRestart();
    return {
      type: "restart-requested",
      action,
      ...(deployment ? { deployment } : {}),
    };
  }
}
