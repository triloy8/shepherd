import { expect, test } from "bun:test";
import { WebHostControls } from "../server/adapters/web/host_controls";
import { RuntimeLifecycleOrchestrator } from "../server/core/runtime_lifecycle_orchestrator";
import { webHarness } from "./helpers/web_harness";

function fixture() {
  let active = false; let pending = false; let count = 0; let restart = 0; let fail = false;
  let release: (() => void) | null = null;
  const lifecycle = new RuntimeLifecycleOrchestrator({
    runningCommit: Promise.resolve("boot-commit"),
    readActivity: () => ({ activeTurnThreadIds: active ? ["thread"] : [], pendingApprovalIds: pending ? ["approval"] : [] }),
    lifecycle: { prepareRestart: () => true, cancelRestart() {}, requestRestart() { restart++; } },
    deployment: {
      isDeploymentInProgress: () => false,
      async readStatus() { return { deployedCommit: "checkout", matchingRemoteRefs: ["origin/main"], deploymentInProgress: false }; },
      async deploy(target) { count++; await new Promise<void>((resolve) => { release = resolve; }); if (fail) throw new Error("Validation failed; restored boot-commit"); return { target, previousCommit: "boot-commit", deployedCommit: "next-commit", changed: true }; },
    },
  });
  return { lifecycle, setActive: (value: boolean) => { active = value; }, setPending: (value: boolean) => { pending = value; }, fail: () => { fail = true; }, release: () => release?.(), count: () => count, restarts: () => restart };
}
async function until(predicate: () => Promise<boolean>) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("Timed out waiting for host operation"); }

test("host deployment runs asynchronously, exposes progress, deduplicates requests and blocks concurrent actions", async () => {
  const f = fixture(); const controls = new WebHostControls(f.lifecycle);
  const input = { requestId: "deploy-1", action: "deploy" as const, branch: "preview" };
  const operation = controls.start(input); expect(operation.phase).toBe("starting");
  await until(async () => (await controls.status()).operation?.phase === "validating");
  expect(controls.start(input)).toBe(operation); expect(f.count()).toBe(1);
  expect(() => controls.start({ ...input, branch: "different" })).toThrow("different action");
  expect(() => controls.start({ requestId: "other", action: "restart" })).toThrow("already in progress");
  f.release(); await until(async () => (await controls.status()).operation?.phase === "restarting");
  expect(f.restarts()).toBe(1); expect((await controls.status()).runningCommit).toBe("boot-commit");
  expect((await controls.status()).operation?.message).toContain("next-commit");
});

test("shared lifecycle refuses active work and pending approvals, and retains deployment failure/restore details", async () => {
  const f = fixture(); const controls = new WebHostControls(f.lifecycle);
  f.setActive(true); controls.start({ requestId: "busy", action: "restart" });
  await until(async () => (await controls.status()).operation?.phase === "finished");
  expect((await controls.status()).operation?.message).toContain("Host is busy"); expect(f.restarts()).toBe(0);
  f.setActive(false); f.setPending(true); controls.start({ requestId: "approval", action: "deploy" });
  await until(async () => (await controls.status()).operation?.phase === "finished"); expect(f.count()).toBe(0);
  f.setPending(false); f.fail(); controls.start({ requestId: "failed", action: "deploy" });
  await until(async () => f.count() === 1); f.release();
  await until(async () => (await controls.status()).operation?.phase === "finished");
  expect((await controls.status()).operation?.message).toContain("restored boot-commit");
  expect(f.restarts()).toBe(0);
});

test("host API validates input/origin and works without a conversation", async () => {
  const f = fixture(); const h = webHarness(f.lifecycle);
  try {
    const status = await (await h.request("/host")).json(); expect(status.available).toBe(true); expect(status.runningCommit).toBe("boot-commit");
    expect((await h.request("/host", "GET", undefined, { origin: "https://evil.test" })).status).toBe(403);
    for (const input of [{}, { requestId: "a", action: "unknown" }, { requestId: "a", action: "restart", branch: "main" }, { requestId: "a", action: "deploy", branch: "--bad" }, { requestId: "a", action: "deploy", extra: true }]) expect((await h.request("/host/actions", "POST", input)).status).toBe(400);
    expect((await h.request("/host/actions", "POST", { requestId: "valid", action: "restart" }, { origin: "https://evil.test" })).status).toBe(403);
    const response = await h.request("/host/actions", "POST", { requestId: "valid", action: "restart" }); expect(response.status).toBe(202);
    await until(async () => f.restarts() === 1);
  } finally { h.api.dispose(); }
  const missing = webHarness();
  try { expect((await (await missing.request("/host")).json()).available).toBe(false); expect((await missing.request("/host/actions", "POST", { requestId: "a", action: "restart" })).status).toBe(409); } finally { missing.api.dispose(); }
});

test("host operation output is bounded and lifecycle exceptions settle without exposing internals", async () => {
  const f = fixture();
  const longFailure = new WebHostControls({
    runningCommit: () => f.lifecycle.runningCommit(), deploymentStatus: () => f.lifecycle.deploymentStatus(), restart: (options) => f.lifecycle.restart(options),
    deploy: async () => ({ type: "deployment-failed", message: "Validation failed; restored previous commit.\n" + "x".repeat(100_000) }),
  });
  longFailure.start({ requestId: "long", action: "deploy" });
  await until(async () => (await longFailure.status()).operation?.phase === "finished");
  const output = (await longFailure.status()).operation!.message;
  expect(output.length).toBeLessThan(65_000); expect(output).toContain("Output truncated"); expect(output).toContain("restored previous commit");
  const throwing = new WebHostControls({
    runningCommit: () => f.lifecycle.runningCommit(), deploymentStatus: () => f.lifecycle.deploymentStatus(), deploy: (options) => f.lifecycle.deploy(options),
    restart: async () => { throw new Error("private implementation detail"); },
  });
  throwing.start({ requestId: "throw", action: "restart" });
  await until(async () => (await throwing.status()).operation?.phase === "finished");
  expect((await throwing.status()).operation?.message).not.toContain("private implementation detail");
});
