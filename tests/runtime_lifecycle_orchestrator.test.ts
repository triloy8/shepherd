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
};

function makeHarness(options?: {
  activities?: RuntimeActivity[];
  deploymentInProgress?: boolean;
  deploymentError?: Error;
  prepareRestart?: boolean;
}) {
  const events: string[] = [];
  const activities = [...(options?.activities ?? [IDLE, IDLE])];
  let lastActivity = activities.at(-1) ?? IDLE;

  const orchestrator = new RuntimeLifecycleOrchestrator({
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
      async deployLatestMain() {
        events.push("deploy");
        if (options?.deploymentError) throw options.deploymentError;
        return DEPLOYMENT;
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

  return { orchestrator, events };
}

describe("RuntimeLifecycleOrchestrator", () => {
  test("coordinates an idle restart through announcement and shutdown request", async () => {
    const { orchestrator, events } = makeHarness();
    const announcements: RuntimeRestartAnnouncement[] = [];

    await expect(
      orchestrator.restart({
        async announce(value) {
          events.push("announce");
          announcements.push(value);
        },
      }),
    ).resolves.toEqual({
      type: "restart-requested",
      action: "restart",
    });

    expect(announcements).toEqual([{ action: "restart" }]);
    expect(events).toEqual([
      "deployment-status",
      "activity",
      "prepare",
      "activity",
      "announce",
      "request",
    ]);
  });

  test("refuses restart while a deployment is already running", async () => {
    const { orchestrator, events } = makeHarness({ deploymentInProgress: true });

    await expect(
      orchestrator.restart({ async announce() {} }),
    ).resolves.toEqual({
      type: "deployment-in-progress",
      action: "restart",
    });
    expect(events).toEqual(["deployment-status"]);
  });

  test("refuses deployment before side effects when Codex work is active", async () => {
    const busy = {
      activeTurnThreadIds: ["thread-1"],
      pendingApprovalIds: [],
    };
    const { orchestrator, events } = makeHarness({ activities: [busy] });

    await expect(
      orchestrator.deploy({ async announce() {} }),
    ).resolves.toEqual({
      type: "busy",
      action: "deploy",
      stage: "before-operation",
      activity: busy,
    });
    expect(events).toEqual(["activity"]);
  });

  test("coordinates deployment before using the shared restart path", async () => {
    const { orchestrator, events } = makeHarness();

    await expect(
      orchestrator.deploy({
        async onDeploymentStarted() {
          events.push("deployment-started");
        },
        async announce(value) {
          events.push("announce");
          expect(value).toEqual({ action: "deploy", deployment: DEPLOYMENT });
        },
      }),
    ).resolves.toEqual({
      type: "restart-requested",
      action: "deploy",
      deployment: DEPLOYMENT,
    });

    expect(events).toEqual([
      "activity",
      "deployment-status",
      "deployment-started",
      "deploy",
      "prepare",
      "activity",
      "announce",
      "request",
    ]);
  });

  test("keeps the runtime online when deployment validation fails", async () => {
    const { orchestrator, events } = makeHarness({
      activities: [IDLE],
      deploymentError: new Error("validation failed; restored previous commit"),
    });

    await expect(
      orchestrator.deploy({
        async onDeploymentStarted() {
          events.push("deployment-started");
        },
        async announce() {
          events.push("announce");
        },
      }),
    ).resolves.toEqual({
      type: "deployment-failed",
      message: "validation failed; restored previous commit",
    });
    expect(events).toEqual([
      "activity",
      "deployment-status",
      "deployment-started",
      "deploy",
    ]);
  });

  test("cancels quiescing when work starts during deployment", async () => {
    const busy = {
      activeTurnThreadIds: [],
      pendingApprovalIds: ["approval-1"],
    };
    const { orchestrator, events } = makeHarness({ activities: [IDLE, busy] });

    await expect(
      orchestrator.deploy({ async announce() { events.push("announce"); } }),
    ).resolves.toEqual({
      type: "busy",
      action: "deploy",
      stage: "after-quiescing",
      activity: busy,
      deployment: DEPLOYMENT,
    });
    expect(events).toEqual([
      "activity",
      "deployment-status",
      "deploy",
      "prepare",
      "activity",
      "cancel",
    ]);
  });

  test("cancels quiescing when the recovery announcement fails", async () => {
    const { orchestrator, events } = makeHarness();

    await expect(
      orchestrator.restart({
        async announce() {
          events.push("announce");
          throw new Error("Discord reply failed");
        },
      }),
    ).rejects.toThrow("Discord reply failed");
    expect(events).toEqual([
      "deployment-status",
      "activity",
      "prepare",
      "activity",
      "announce",
      "cancel",
    ]);
  });

  test("blocks concurrent restart and deploy while deployment startup is awaiting Discord", async () => {
    const { orchestrator, events } = makeHarness();
    let releaseDeploymentStart!: () => void;
    let markDeploymentStartReached!: () => void;
    const deploymentStartReached = new Promise<void>((resolve) => {
      markDeploymentStartReached = resolve;
    });
    const holdDeploymentStart = new Promise<void>((resolve) => {
      releaseDeploymentStart = resolve;
    });

    const firstDeployment = orchestrator.deploy({
      async onDeploymentStarted() {
        events.push("deployment-started");
        markDeploymentStartReached();
        await holdDeploymentStart;
      },
      async announce() {
        events.push("announce");
      },
    });

    await deploymentStartReached;

    await expect(
      orchestrator.restart({ async announce() {} }),
    ).resolves.toEqual({
      type: "deployment-in-progress",
      action: "restart",
    });
    await expect(
      orchestrator.deploy({ async announce() {} }),
    ).resolves.toEqual({
      type: "deployment-in-progress",
      action: "deploy",
    });

    releaseDeploymentStart();
    await expect(firstDeployment).resolves.toEqual({
      type: "restart-requested",
      action: "deploy",
      deployment: DEPLOYMENT,
    });
    expect(events.filter((event) => event === "deploy")).toHaveLength(1);
    expect(events.filter((event) => event === "request")).toHaveLength(1);
  });

  test("releases the deployment lock when the startup announcement fails", async () => {
    const { orchestrator } = makeHarness();

    await expect(
      orchestrator.deploy({
        async onDeploymentStarted() {
          throw new Error("Discord progress reply failed");
        },
        async announce() {},
      }),
    ).rejects.toThrow("Discord progress reply failed");

    await expect(
      orchestrator.restart({ async announce() {} }),
    ).resolves.toEqual({
      type: "restart-requested",
      action: "restart",
    });
  });
});
