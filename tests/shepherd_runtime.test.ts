import { describe, expect, test } from "bun:test";

import { ShepherdRuntime } from "../server/runtime/shepherd_runtime.js";

function makeRuntime(options: { restartDelayMs?: number; exitProcess?: (code: number) => void } = {}) {
  return new ShepherdRuntime({
    approvalPolicy: "on-request",
    restartDelayMs: options.restartDelayMs,
    exitProcess: options.exitProcess,
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

  test("quiesces adapters and exits after a lifecycle restart", async () => {
    const exits: number[] = [];
    const calls: string[] = [];
    const runtime = makeRuntime({
      restartDelayMs: 0,
      exitProcess: (code) => exits.push(code),
    });
    runtime.registerShutdownHook(() => {
      calls.push("adapter");
    });

    await expect(runtime.lifecycle.restart({
      announce: async () => {
        calls.push("announce");
      },
    })).resolves.toEqual({ type: "restart-requested", action: "restart" });
    expect(runtime.isQuiescing()).toBe(true);

    for (let attempt = 0; attempt < 20 && exits.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(calls).toEqual(["announce", "adapter"]);
    expect(exits).toEqual([0]);
  });

  test("reopens ingress when a restart announcement fails", async () => {
    const runtime = makeRuntime();
    await expect(runtime.lifecycle.restart({
      announce: async () => {
        throw new Error("announcement failed");
      },
    })).rejects.toThrow("announcement failed");
    expect(runtime.isQuiescing()).toBe(false);
    await runtime.shutdown();
  });
});
