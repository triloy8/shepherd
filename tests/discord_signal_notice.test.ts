import { describe, expect, test } from "bun:test";
import { ComponentType } from "discord.js";

import type { RegisteredSignal } from "../server/core/signal_registry.js";
import {
  SURFACE_COLORS,
} from "../server/adapters/discord/components_renderer.js";
import {
  buildDiscordSignalNoticePages,
  presentDiscordSignalNotice,
} from "../server/adapters/discord/signal_notice.js";

function signal(
  state: string,
  options: { verified?: boolean; researchProject?: string; runId?: string } = {},
): RegisteredSignal {
  return {
    envelope: {
      kind: "research.state-changed",
      version: 1,
      subject: { type: "research-run", id: options.runId ?? "run-123" },
      payload: {
        state,
        ...(options.verified === undefined ? {} : { verified: options.verified }),
        ...(options.researchProject ? { researchProject: options.researchProject } : {}),
      },
    },
    target: {
      type: "conversation",
      threadId: "thread-1",
      cwd: "/workspace",
      delivery: { adapter: "discord", surfaceId: "channel-1" },
    },
    input: [],
    coalesceKey: "research.state-changed@1:run-123",
    terminal: true,
  };
}

function componentJson(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" && "toJSON" in value
    ? (value as { toJSON: () => unknown }).toJSON()
    : value) as Record<string, unknown>;
}

function notice(signalValue: RegisteredSignal): {
  title: string;
  body: string;
  accentColor: unknown;
} {
  const page = buildDiscordSignalNoticePages(signalValue)[0]!;
  const container = componentJson(page.components[0]);
  const children = container.components as unknown[];
  expect(container.type).toBe(ComponentType.Container);
  return {
    title: String(componentJson(children[0]).content),
    body: String(componentJson(children[1]).content),
    accentColor: container.accent_color,
  };
}

describe("Discord signal notices", () => {
  test("renders a sanitized successful research update", () => {
    const rendered = notice(signal("COMPLETE", {
      verified: true,
      researchProject: "P001",
      runId: "run`123",
    }));

    expect(rendered.title).toBe("## Research run reported complete");
    expect(rendered.accentColor).toBe(SURFACE_COLORS.success);
    expect(rendered.body).toContain("**Run:** `` run`123 ``");
    expect(rendered.body).toContain("**Reported state:** `COMPLETE`");
    expect(rendered.body).toContain("**Producer marked verified:** Yes");
    expect(rendered.body).toContain("**Project:** `P001`");
    expect(rendered.body).toContain("Codex is checking authoritative workspace state.");
  });

  test("uses a danger accent for a reported failure", () => {
    const rendered = notice(signal("FAILED", { verified: false }));

    expect(rendered.title).toBe("## Research run reported failed");
    expect(rendered.accentColor).toBe(SURFACE_COLORS.danger);
    expect(rendered.body).toContain("**Producer marked verified:** No");
  });

  test("does not render unsupported signal kinds", () => {
    const unsupported = signal("COMPLETE");
    unsupported.envelope.kind = "build.state-changed";

    expect(buildDiscordSignalNoticePages(unsupported)).toEqual([]);
  });

  test("posts the notice and records it as the signal turn reply target", async () => {
    const sent: unknown[] = [];
    const replyTargets: Array<[string, string]> = [];
    const channel = {
      async send(payload: unknown) {
        sent.push(payload);
        return { id: "notice-1", async edit() {} };
      },
      messages: { async fetch() { throw new Error("not used"); } },
    };

    await presentDiscordSignalNotice({
      client: { channels: { async fetch() { return channel; } } },
      signal: signal("COMPLETE", { verified: true }),
      recordReplyTarget: (surfaceId, messageId) => replyTargets.push([surfaceId, messageId]),
    });

    expect(sent).toHaveLength(1);
    expect(replyTargets).toEqual([["channel-1", "notice-1"]]);
  });
});
