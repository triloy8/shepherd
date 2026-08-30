import { describe, expect, test } from "bun:test";

import { ShepherdRuntime } from "../server/runtime/shepherd_runtime.js";

function makeRuntime() {
  return new ShepherdRuntime({
    approvalPolicy: "on-request",
    deployment: {
      isDeploymentInProgress: () => false,
      async deploy() {
        throw new Error("not used");
      },
      async readStatus() {
        return {
          deployedCommit: "1111111111111111111111111111111111111111",
          matchingRemoteRefs: [],
          deploymentInProgress: false,
        };
      },
    },
  });
}

describe("ShepherdRuntime", () => {
  test("runs shutdown hooks once and quiesces ingress", async () => {
    const runtime = makeRuntime();
    const calls: string[] = [];
    runtime.registerShutdownHook(async () => {
      calls.push("adapter");
    });

    expect(runtime.isQuiescing()).toBe(false);
    const first = runtime.shutdown();
    const second = runtime.shutdown();

    expect(first).toBe(second);
    await first;
    expect(runtime.isQuiescing()).toBe(true);
    expect(calls).toEqual(["adapter"]);
  });

  test("continues shutdown after a hook fails", async () => {
    const runtime = makeRuntime();
    const calls: string[] = [];
    runtime.registerShutdownHook(() => {
      calls.push("first");
      throw new Error("hook failed");
    });
    runtime.registerShutdownHook(() => {
      calls.push("second");
    });

    await expect(runtime.shutdown()).rejects.toThrow("hook failed");
    expect(calls).toEqual(["first", "second"]);
  });
});
