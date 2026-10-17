import { expect, test } from "bun:test";
import { sessionProviders } from "./helpers/session_providers.js";
import { CodexSession } from "../server/providers/codex/session.js";
import { SessionManager } from "../server/core/session_manager.js";
import type { ThreadBootstrapInfo } from "../server/ports/provider_session.js";
import { IndependentSession } from "./helpers/independent_provider.js";

for (const operation of ["create", "resume", "fork"] as const) {
  test(`${operation} rejects missing provider workspace before accepting the thread`, async () => {
    for (const cwd of [undefined, "", "   "]) {
      const session = new IndependentSession();
      const bootstrap = async () => ({ threadId: "new-thread", cwd, model: null, effort: null } as unknown as ThreadBootstrapInfo);
      Object.assign(session, { startThread: bootstrap, resumeThread: bootstrap, forkThread: bootstrap, capabilities: { ...session.capabilities, fork: true } });
      const manager = new SessionManager(undefined, sessionProviders(() => session));
      try {
        const pending = operation === "create" ? manager.createThread({ cwd: "/requested" })
          : operation === "resume" ? manager.resumeThread("stored", {}) : manager.forkThread("stored", {});
        await expect(pending).rejects.toMatchObject({ failure: { code: "workspace_unavailable" } });
        expect(manager.listThreads().threads).toEqual([]);
        expect(session.stopped).toBe(true);
      } finally { manager.stopAll(); }
    }
  });
}

test("core uses the provider's effective workspace without reading history, and turns run in the session's workspace", async () => {
  const session = new IndependentSession();
  session.startThread = async () => ({ threadId: "thread", cwd: "/effective", model: null, effort: null, approvalPolicy: "provider_default" });
  session.readThread = async () => { throw new Error("Should use bootstrapped workspace"); };
  let settings: object | undefined;
  session.onTurn = (_input, applied) => { settings = applied; };
  const manager = new SessionManager(undefined, sessionProviders(() => session));
  try {
    const { threadId } = await manager.createThread({ cwd: "/requested" });
    expect(await manager.resolveThreadCwd(threadId)).toBe("/effective");
    await manager.submitTurn(threadId, { input: [{ type: "text", text: "hello" }] });
    // The workspace is the session's own setting, changed only through setCwd, not a per-turn value.
    expect(settings).toEqual({});
  } finally { manager.stopAll(); }
});

test("Codex lifecycle returns its effective workspace and rejects missing native workspace", async () => {
  const session = new CodexSession();
  session.initialize = async () => {};
  let response: unknown = { cwd: "/effective", thread: { id: "thread", cwd: "/saved" } };
  (session as unknown as { sendRequest: () => Promise<unknown> }).sendRequest = async () => response;
  try {
    for (const bootstrap of [
      () => session.startThread({ cwd: "/requested" }),
      () => session.resumeThread("thread", {}),
      () => session.forkThread("thread", {}),
    ]) {
      expect((await bootstrap()).cwd).toBe("/effective");
      response = { thread: { id: "thread", cwd: "/saved" } };
      expect((await bootstrap()).cwd).toBe("/saved");
      response = { thread: { id: "thread" } };
      await expect(bootstrap()).rejects.toThrow("returned no workspace");
      response = { cwd: "/effective", thread: { id: "thread", cwd: "/saved" } };
    }
  } finally { session.stop(); }
});
