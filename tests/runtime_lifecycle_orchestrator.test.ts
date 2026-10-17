import { describe, expect, test } from "bun:test";

import {
  RuntimeLifecycleOrchestrator,
  type RuntimeRestartAnnouncement,
} from "../server/core/runtime_lifecycle_orchestrator.js";
import type { RuntimeActivity } from "../server/core/session_manager.js";

const IDLE: RuntimeActivity = {
  activeTurnThreadIds: [],
  pendingApprovalIds: [],
};

const DEPLOYMENT = {
  previousCommit: "1111111111111111111111111111111111111111",
  deployedCommit: "2222222222222222222222222222222222222222",
  changed: true,
  target: { kind: "main" } as const,
};

function makeHarness(options?: {
  activities?: RuntimeActivity[];
  deploymentInProgress?: boolean;
  deploymentError?: Error;
  prepareRestart?: boolean;
  drainTimeoutMs?: number;
}) {
  const events: string[] = [];
  const activities = [...(options?.activities ?? [IDLE, IDLE])];
  const deploymentTargets: unknown[] = [];
  let lastActivity = activities.at(-1) ?? IDLE;

  const orchestrator = new RuntimeLifecycleOrchestrator({
    drainPollMs: 1,
    drainTimeoutMs: options?.drainTimeoutMs ?? 60_000,
    admission: {
      pauseNewTurns() { events.push("pause"); },
      resumeNewTurns() { events.push("resume"); },
    },
    readActivity() {
      events.push("activity");
      lastActivity = activities.shift() ?? lastActivity;
      return lastActivity;
    },
    deployment: {
      isDeploymentInProgress() {
        events.push("deployment-status");
        return options?.deploymentInProgress ?? false;
      },
      async deploy(target) {
        events.push("deploy");
        deploymentTargets.push(target);
        if (options?.deploymentError) throw options.deploymentError;
        return { ...DEPLOYMENT, target };
      },
      async readStatus() {
        events.push("read-deployment-status");
        return {
          deployedCommit: DEPLOYMENT.deployedCommit,
          matchingRemoteRefs: ["origin/main"],
          deploymentInProgress: false,
        };
      },
    },
    lifecycle: {
      prepareRestart() {
        events.push("prepare");
        return options?.prepareRestart ?? true;
      },
      cancelRestart() {
        events.push("cancel");
      },
      requestRestart() {
        events.push("request");
      },
    },
  });

  return { orchestrator, events, deploymentTargets };
}

describe("RuntimeLifecycleOrchestrator", () => {
  const busy = { activeTurnThreadIds: ["thread-1"], pendingApprovalIds: [] };
  const approval = { activeTurnThreadIds: [], pendingApprovalIds: ["approval-1"] };

  test("an idle restart pauses new turns, announces and requests shutdown", async () => {
    const { orchestrator, events } = makeHarness();
    const announcements: RuntimeRestartAnnouncement[] = [];
    await expect(orchestrator.restart({ async announce(value) { events.push("announce"); announcements.push(value); } }))
      .resolves.toEqual({ type: "restart-requested", action: "restart" });
    expect(announcements).toEqual([{ action: "restart" }]);
    // New turns stay paused: the process is about to exit.
    expect(events).toEqual(["deployment-status", "pause", "activity", "prepare", "activity", "announce", "request"]);
  });

  test("refuses restart while a deployment is already running", async () => {
    const { orchestrator, events } = makeHarness({ deploymentInProgress: true });
    await expect(orchestrator.restart({ async announce() {} })).resolves.toEqual({ type: "deployment-in-progress", action: "restart" });
    expect(events).toEqual(["deployment-status"]);
  });

  test("a restart waits for running turns and approvals, reporting each change, then restarts", async () => {
    const { orchestrator, events } = makeHarness({ activities: [busy, busy, approval, IDLE, IDLE] });
    const reported: RuntimeActivity[] = [];
    await expect(orchestrator.restart({ async onDraining(activity) { reported.push(activity); }, async announce() { events.push("announce"); } }))
      .resolves.toEqual({ type: "restart-requested", action: "restart" });
    // Unchanged activity is reported once.
    expect(reported).toEqual([busy, approval]);
    expect(events).toEqual(["deployment-status", "pause", "activity", "activity", "activity", "activity", "prepare", "activity", "announce", "request"]);
  });

  test("deployment may start while work runs; it validates, then waits for the work before restarting", async () => {
    const { orchestrator, events, deploymentTargets } = makeHarness({ activities: [busy, IDLE, IDLE] });
    await expect(orchestrator.deploy({
      async onDeploymentStarted() { events.push("deployment-started"); },
      async announce(value) { events.push("announce"); expect(value).toEqual({ action: "deploy", deployment: DEPLOYMENT }); },
    })).resolves.toEqual({ type: "restart-requested", action: "deploy", deployment: DEPLOYMENT });
    expect(events).toEqual(["deployment-status", "deployment-started", "deploy", "pause", "activity", "activity", "prepare", "activity", "announce", "request"]);
    expect(deploymentTargets).toEqual([{ kind: "main" }]);
  });

  test("passes a preview branch target through to deployment", async () => {
    const { orchestrator, deploymentTargets } = makeHarness();
    await expect(orchestrator.deploy({ target: { kind: "branch", branch: "feat/user-test" }, async announce() {} }))
      .resolves.toMatchObject({ type: "restart-requested", deployment: { target: { kind: "branch", branch: "feat/user-test" } } });
    expect(deploymentTargets).toEqual([{ kind: "branch", branch: "feat/user-test" }]);
  });

  test("reads deployment status without entering the restart flow", async () => {
    const { orchestrator, events } = makeHarness();
    await expect(orchestrator.deploymentStatus()).resolves.toEqual({ deployedCommit: DEPLOYMENT.deployedCommit, matchingRemoteRefs: ["origin/main"], deploymentInProgress: false });
    expect(events).toEqual(["read-deployment-status"]);
  });

  test("keeps the runtime online and new turns open when deployment validation fails", async () => {
    const { orchestrator, events } = makeHarness({ deploymentError: new Error("validation failed; restored previous commit") });
    await expect(orchestrator.deploy({ async onDeploymentStarted() { events.push("deployment-started"); }, async announce() { events.push("announce"); } }))
      .resolves.toEqual({ type: "deployment-failed", message: "validation failed; restored previous commit" });
    expect(events).toEqual(["deployment-status", "deployment-started", "deploy"]);
  });

  test("work that never finishes ends the wait at the limit and reopens new turns", async () => {
    const { orchestrator, events } = makeHarness({ activities: [busy], drainTimeoutMs: 0 });
    await expect(orchestrator.deploy({ async announce() { events.push("announce"); } }))
      .resolves.toEqual({ type: "drain-timed-out", action: "deploy", activity: busy, deployment: DEPLOYMENT });
    expect(events).toEqual(["deployment-status", "deploy", "pause", "activity", "resume"]);
  });

  test("work a provider starts as the restart is prepared cancels it and the wait continues", async () => {
    const { orchestrator, events } = makeHarness({ activities: [IDLE, busy, IDLE, IDLE] });
    await expect(orchestrator.restart({ async announce() { events.push("announce"); } })).resolves.toEqual({ type: "restart-requested", action: "restart" });
    expect(events).toEqual(["deployment-status", "pause", "activity", "prepare", "activity", "cancel", "activity", "prepare", "activity", "announce", "request"]);
  });

  test("a failed recovery announcement cancels the restart and reopens new turns", async () => {
    const { orchestrator, events } = makeHarness();
    await expect(orchestrator.restart({ async announce() { events.push("announce"); throw new Error("Discord reply failed"); } })).rejects.toThrow("Discord reply failed");
    expect(events).toEqual(["deployment-status", "pause", "activity", "prepare", "activity", "announce", "cancel", "resume"]);
  });

  test("a request while a restart waits joins it rather than starting another", async () => {
    const { orchestrator, events } = makeHarness({ activities: [busy, busy, busy, busy, IDLE, IDLE] });
    let draining!: () => void; const waiting = new Promise<void>((resolve) => { draining = resolve; });
    const first = orchestrator.restart({ async onDraining() { draining(); }, async announce() {} });
    await waiting;
    await expect(orchestrator.restart({ async announce() {} })).resolves.toEqual({ type: "restart-already-scheduled", action: "restart" });
    await expect(orchestrator.deploy({ async announce() {} })).resolves.toEqual({ type: "restart-already-scheduled", action: "deploy" });
    await expect(first).resolves.toEqual({ type: "restart-requested", action: "restart" });
    expect(events.filter((event) => event === "request")).toHaveLength(1);
    expect(events.filter((event) => event === "deploy")).toHaveLength(0);
  });

  test("blocks concurrent restart and deploy while deployment startup is awaiting Discord", async () => {
    const { orchestrator, events } = makeHarness();
    let releaseDeploymentStart!: () => void;
    let markDeploymentStartReached!: () => void;
    const deploymentStartReached = new Promise<void>((resolve) => { markDeploymentStartReached = resolve; });
    const holdDeploymentStart = new Promise<void>((resolve) => { releaseDeploymentStart = resolve; });
    const firstDeployment = orchestrator.deploy({
      async onDeploymentStarted() { events.push("deployment-started"); markDeploymentStartReached(); await holdDeploymentStart; },
      async announce() { events.push("announce"); },
    });
    await deploymentStartReached;
    await expect(orchestrator.restart({ async announce() {} })).resolves.toEqual({ type: "deployment-in-progress", action: "restart" });
    await expect(orchestrator.deploy({ async announce() {} })).resolves.toEqual({ type: "deployment-in-progress", action: "deploy" });
    releaseDeploymentStart();
    await expect(firstDeployment).resolves.toEqual({ type: "restart-requested", action: "deploy", deployment: DEPLOYMENT });
    expect(events.filter((event) => event === "deploy")).toHaveLength(1);
    expect(events.filter((event) => event === "request")).toHaveLength(1);
  });

  test("releases the deployment lock when the startup announcement fails", async () => {
    const { orchestrator } = makeHarness();
    await expect(orchestrator.deploy({ async onDeploymentStarted() { throw new Error("Discord progress reply failed"); }, async announce() {} })).rejects.toThrow("Discord progress reply failed");
    await expect(orchestrator.restart({ async announce() {} })).resolves.toEqual({ type: "restart-requested", action: "restart" });
  });
});
