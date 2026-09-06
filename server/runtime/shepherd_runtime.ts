import type { ApprovalPolicy, SandboxMode } from "../../shared/protocol/requests.js";
import { ConversationService } from "../core/conversation_service.js";
import {
  RuntimeLifecycleOrchestrator,
  type RuntimeDeploymentPort,
} from "../core/runtime_lifecycle_orchestrator.js";

type ShutdownHook = () => void | Promise<void>;

export type ShepherdRuntimeOptions = {
  approvalPolicy: ApprovalPolicy;
  defaultSandbox?: SandboxMode;
  deployment: RuntimeDeploymentPort;
  restartDelayMs?: number;
  exitProcess?: (code: number) => void;
};

export class ShepherdRuntime {
  readonly conversation: ConversationService;
  readonly lifecycle: RuntimeLifecycleOrchestrator;

  private readonly shutdownHooks = new Set<ShutdownHook>();
  private readonly restartDelayMs: number;
  private readonly exitProcess: (code: number) => void;
  private shutdownPromise: Promise<void> | null = null;
  private restartPrepared = false;
  private restartExitScheduled = false;

  constructor(options: ShepherdRuntimeOptions) {
    this.restartDelayMs = options.restartDelayMs ?? 250;
    this.exitProcess = options.exitProcess ?? ((code) => process.exit(code));
    this.conversation = new ConversationService({
      routing: {
        autoCreateIfMissing: true,
        defaultApprovalPolicy: options.approvalPolicy,
        defaultSandbox: options.defaultSandbox,
        exclusiveThreadBinding: true,
      },
    });
    this.lifecycle = new RuntimeLifecycleOrchestrator({
      readActivity: () => this.conversation.getRuntimeActivity(),
      deployment: options.deployment,
      lifecycle: {
        prepareRestart: () => this.prepareRestart(),
        cancelRestart: () => this.cancelRestart(),
        requestRestart: () => this.requestRestart(),
      },
    });
  }

  isQuiescing(): boolean {
    return this.restartPrepared || this.shutdownPromise !== null;
  }

  registerShutdownHook(hook: ShutdownHook): () => void {
    this.shutdownHooks.add(hook);
    return () => this.shutdownHooks.delete(hook);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.restartPrepared = true;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private prepareRestart(): boolean {
    if (this.restartPrepared) return false;
    this.restartPrepared = true;
    return true;
  }

  private cancelRestart(): void {
    if (this.restartExitScheduled || this.shutdownPromise) return;
    this.restartPrepared = false;
  }

  private requestRestart(): void {
    if (this.restartExitScheduled) return;
    this.restartPrepared = true;
    this.restartExitScheduled = true;
    const timer = setTimeout(() => {
      void this.shutdown().finally(() => this.exitProcess(0));
    }, this.restartDelayMs);
    timer.unref?.();
  }

  private async performShutdown(): Promise<void> {
    let firstError: unknown = null;
    for (const hook of this.shutdownHooks) {
      try {
        await hook();
      } catch (error) {
        firstError ??= error;
      }
    }
    this.shutdownHooks.clear();

    try {
      this.conversation.stopAll();
    } catch (error) {
      firstError ??= error;
    }

    if (firstError) throw firstError;
  }
}
