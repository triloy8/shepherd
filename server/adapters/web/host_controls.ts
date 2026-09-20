import { randomUUID } from "node:crypto";
import type { WebHostAction, WebHostOperation, WebHostStatus } from "../../../shared/protocol/host.js";
import type { SurfaceApplicationContext } from "../../core/surface_application_context.js";
import type { RuntimeLifecycleResult } from "../../core/runtime_lifecycle_orchestrator.js";
import { WebRequestError } from "./errors.js";

function outcome(result: RuntimeLifecycleResult): string {
  switch (result.type) {
    case "restart-requested": return "Restart requested. Waiting for the host to reconnect.";
    case "restart-already-scheduled": return "A restart is already scheduled.";
    case "deployment-in-progress": return "Another deployment is in progress. Wait for it to finish.";
    case "deployment-failed": return result.message;
    case "busy": return result.deployment
      ? `Validated ${result.deployment.deployedCommit}, but new agent work prevented restart. Restart after turns and approvals finish.`
      : "Host is busy. Finish active turns and pending approvals on all surfaces before retrying.";
  }
}

/** Small bounded operation journal; the shared orchestrator owns lifecycle decisions. */
export class WebHostControls {
  private readonly instanceId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private operation: WebHostOperation | null = null;
  private busy = false;
  private readonly requests = new Map<string, { input: string; operation: WebHostOperation }>();
  constructor(private readonly lifecycle: SurfaceApplicationContext["runtimeLifecycle"]) {}

  async status(): Promise<WebHostStatus> {
    const [checkout, runningCommit] = await Promise.all([
      this.lifecycle?.deploymentStatus() ?? null,
      this.lifecycle?.runningCommit() ?? null,
    ]);
    return { instanceId: this.instanceId, startedAt: this.startedAt, available: Boolean(this.lifecycle), checkout, runningCommit, operation: this.operation };
  }

  start(request: WebHostAction): WebHostOperation {
    if (!this.lifecycle) throw new WebRequestError(409, "control_unavailable", "Host lifecycle controls are unavailable.");
    const input = JSON.stringify([request.action, request.branch ?? null]);
    const existing = this.requests.get(request.requestId);
    if (existing) {
      if (existing.input !== input) throw new WebRequestError(409, "request_conflict", "This request ID was already used for a different action.");
      return existing.operation;
    }
    if (this.busy) throw new WebRequestError(409, "host_busy", "A host operation is already in progress.");
    const operation: WebHostOperation = { id: request.requestId, action: request.action, phase: "starting", message: "Checking host activity…" };
    this.operation = operation; this.busy = true;
    this.requests.set(request.requestId, { input, operation });
    if (this.requests.size > 32) this.requests.delete(this.requests.keys().next().value!);
    // Return acceptance before work begins. Client disconnects never cancel deployment.
    setTimeout(() => { void this.run(request, operation); }, 0);
    return operation;
  }

  private async run(request: WebHostAction, operation: WebHostOperation): Promise<void> {
    try {
      const announce = async (value: import("../../core/runtime_lifecycle_orchestrator.js").RuntimeRestartAnnouncement) => {
        operation.phase = "restarting";
        operation.message = value.action === "deploy"
          ? `Validated ${value.deployment.deployedCommit}. Restarting Shepherd.`
          : "Restarting Shepherd.";
      };
      const result = request.action === "restart"
        ? await this.lifecycle!.restart({ announce })
        : await this.lifecycle!.deploy({ target: request.branch ? { kind: "branch", branch: request.branch } : { kind: "main" }, announce,
          onDeploymentStarted: async () => { operation.phase = "validating"; operation.message = `Fetching and validating origin/${request.branch ?? "main"}…`; },
        });
      operation.phase = result.type === "restart-requested" || result.type === "restart-already-scheduled" ? "restarting" : "finished";
      // Keep validation details visible until the process restarts.
      if (result.type !== "restart-requested") operation.message = outcome(result);
    } catch (error) {
      console.error("Web host operation failed:", error);
      operation.phase = "finished"; operation.message = "Host operation failed. Check host logs and current status before retrying.";
    } finally { this.busy = operation.phase === "restarting"; }
    // Bound backend command output retained and transferred to the browser.
    if (operation.message.length > 64_000) operation.message = `${operation.message.slice(0, 64_000)}\n[Output truncated; see host logs.]`;
  }
}
