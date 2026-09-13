import { expect, test } from "bun:test";
import { createSurfaceRuntime } from "../server/runtime/surface_runtime.js";
import { executeSurfaceAction } from "../server/core/surface_actions_service.js";
import { ApplicationActionError } from "../server/core/action_error.js";

for (const adapter of ["discord", "terminal"]) {
  test(`${adapter} shares listening prerequisites, pause/resume and detach semantics`, async () => {
    const bindings = new Map<string, string>();
    const unsubscribed: string[] = [];
    const key = (adapter: string, surfaceId: string) => `${adapter}:${surfaceId}`;
    const conversation = {
      getSurfaceThread: (adapter: string, surfaceId: string) => bindings.get(key(adapter, surfaceId)) ?? null,
      clearSurfaceBinding: (adapter: string, surfaceId: string) => { bindings.delete(key(adapter, surfaceId)); },
      unsubscribeSurfaceEvents: (adapter: string, surfaceId: string) => { unsubscribed.push(key(adapter, surfaceId)); },
    };
    const { commandContext: context } = createSurfaceRuntime({
      adapter, conversation: conversation as never, approvalPolicy: "on-request",
      onThreadEvent() {}, async cloneGithubRepo() {}, async resolveGithubRepo(slug) { return slug; },
    });
    const run = (type: "listening.pause" | "listening.resume" | "surface.detach" | "listening.get") =>
      executeSurfaceAction(context, { type, surfaceId: "same-id" });
    expect(executeSurfaceAction(context, { type: "listening.set", surfaceId: "same-id", mode: "open" }))
      .toEqual({ ok: false, error: { code: "thread_required" } });
    expect(() => context.setSurfaceListeningMode("same-id", "open")).toThrow(ApplicationActionError);
    expect(context.getSurfaceListeningMode("same-id")).toBe("mention");
    expect(run("surface.detach")).toEqual({ ok: false, error: { code: "thread_required" } });
    expect(unsubscribed).toEqual([]);
    bindings.set(key(adapter, "same-id"), "thread-1");
    bindings.set(key("other", "same-id"), "thread-other");
    await context.setSurfaceProject("same-id", "~");
    expect(executeSurfaceAction(context, { type: "listening.set", surfaceId: "same-id", mode: "open" }))
      .toEqual({ ok: true, threadId: "thread-1", mode: "open" });
    expect(run("listening.pause")).toMatchObject({ mode: "paused" });
    expect(run("listening.pause")).toMatchObject({ mode: "paused" });
    expect(run("listening.resume")).toMatchObject({ mode: "open" });
    run("listening.pause");
    expect(run("surface.detach")).toEqual({ ok: true, threadId: "thread-1", mode: "mention" });
    expect(run("listening.resume")).toEqual({ ok: true, threadId: null, mode: "mention" });
    expect(context.getSurfaceProject("same-id")).toBe("~");
    expect(bindings.get(key("other", "same-id"))).toBe("thread-other");
    expect(unsubscribed).toEqual([key(adapter, "same-id")]);
  });
}
