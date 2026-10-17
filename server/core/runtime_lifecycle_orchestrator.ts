import {
  MAIN_DEPLOYMENT_TARGET,
  type DeploymentResult,
  type DeploymentStatus,
  type DeploymentTarget,
} from "./deployment_service.js";
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
      /** Work did not finish within the drain limit; new turns are accepted again and nothing restarted. */
      type: "drain-timed-out";
      action: RuntimeLifecycleAction;
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
  deploy: (target: DeploymentTarget) => Promise<DeploymentResult>;
  readStatus: () => Promise<DeploymentStatus>;
};

/** Whether new turns may start. A restart pauses them while work already running finishes;
 * reading, interrupting, answering approvals and steering stay available. */
export type RuntimeAdmissionPort = {
  pauseNewTurns: () => void;
  resumeNewTurns: () => void;
};

export type RuntimeLifecycleOrchestratorOptions = {
  readActivity: () => RuntimeActivity;
  admission: RuntimeAdmissionPort;
  /** How often to check whether running work has finished, and how long to wait for it. */
  drainPollMs?: number;
  drainTimeoutMs?: number;
  runningCommit?: Promise<string | null>;
  deployment: RuntimeDeploymentPort;
  lifecycle: RuntimeLifecyclePort;
};

export type RestartOptions = {
  announce: (value: RuntimeRestartAnnouncement) => Promise<void>;
  /** Reports the work a restart is waiting for, whenever it changes. */
  onDraining?: (activity: RuntimeActivity) => Promise<void>;
};

export type DeployOptions = RestartOptions & {
  target?: DeploymentTarget;
  onDeploymentStarted?: () => Promise<void>;
};

function hasActivity(activity: RuntimeActivity): boolean {
  return activity.activeTurnThreadIds.length > 0 || activity.pendingApprovalIds.length > 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DRAIN_POLL_MS = 2_000;
const DRAIN_TIMEOUT_MS = 30 * 60_000;

export class RuntimeLifecycleOrchestrator {
  private deploymentOperationInProgress = false;
  /** A restart is waiting for running work; another request joins it rather than starting one. */
  private draining = false;

  constructor(private readonly options: RuntimeLifecycleOrchestratorOptions) {}

  runningCommit(): Promise<string | null> {
    return this.options.runningCommit ?? Promise.resolve(null);
  }

  deploymentStatus(): Promise<DeploymentStatus> {
    return this.options.deployment.readStatus();
  }

  /** Restarts once running work has finished. New turns wait meanwhile. */
  async restart(options: RestartOptions): Promise<RuntimeLifecycleResult> {
    if (this.isDeploymentInProgress()) return { type: "deployment-in-progress", action: "restart" };
    if (this.draining) return { type: "restart-already-scheduled", action: "restart" };
    return this.drainAndRestart({ action: "restart" }, options);
  }

  /** Validates the target, then restarts onto it once running work has finished. Work may run
   * during validation, which does not touch running conversations. */
  async deploy(options: DeployOptions): Promise<RuntimeLifecycleResult> {
    if (this.isDeploymentInProgress()) return { type: "deployment-in-progress", action: "deploy" };
    if (this.draining) return { type: "restart-already-scheduled", action: "deploy" };

    this.deploymentOperationInProgress = true;
    try {
      await options.onDeploymentStarted?.();

      let deployment: DeploymentResult;
      try {
        deployment = await this.options.deployment.deploy(options.target ?? MAIN_DEPLOYMENT_TARGET);
      } catch (error) {
        const message = formatError(error);
        console.error("Shepherd deployment failed:", message);
        return {
          type: "deployment-failed",
          message,
        };
      }

      return await this.drainAndRestart({ action: "deploy", deployment }, options);
    } finally {
      this.deploymentOperationInProgress = false;
    }
  }

  private isDeploymentInProgress(): boolean {
    return this.deploymentOperationInProgress || this.options.deployment.isDeploymentInProgress();
  }

  /** Pauses new turns, waits for running turns, background work and approvals to finish, then
   * restarts. New turns resume if the restart does not happen. */
  private async drainAndRestart(announcement: RuntimeRestartAnnouncement, options: RestartOptions): Promise<RuntimeLifecycleResult> {
    const { action } = announcement;
    const deployment = announcement.action === "deploy" ? announcement.deployment : undefined;
    const poll = this.options.drainPollMs ?? DRAIN_POLL_MS;
    const deadline = Date.now() + (this.options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
    let restarting = false;
    this.draining = true;
    this.options.admission.pauseNewTurns();
    try {
      let reported = "";
      while (true) {
        const activity = this.options.readActivity();
        if (hasActivity(activity)) {
          if (Date.now() >= deadline) return { type: "drain-timed-out", action, activity, ...(deployment ? { deployment } : {}) };
          const summary = JSON.stringify(activity);
          if (summary !== reported) { reported = summary; await options.onDraining?.(activity); }
          await new Promise((resolve) => setTimeout(resolve, poll));
          continue;
        }
        if (!this.options.lifecycle.prepareRestart()) return { type: "restart-already-scheduled", action, ...(deployment ? { deployment } : {}) };
        // A provider can start work on its own, such as a background task waking its conversation.
        if (hasActivity(this.options.readActivity())) { this.options.lifecycle.cancelRestart(); continue; }
        try {
          await options.announce(announcement);
        } catch (error) {
          this.options.lifecycle.cancelRestart();
          throw error;
        }
        this.options.lifecycle.requestRestart();
        restarting = true;
        return { type: "restart-requested", action, ...(deployment ? { deployment } : {}) };
      }
    } finally {
      this.draining = false;
      if (!restarting) this.options.admission.resumeNewTurns();
    }
  }
}
