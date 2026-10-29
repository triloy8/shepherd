import { THREAD_WATCH_SIGNAL_KIND, type RegisteredSignal, type ThreadWatchPayload, type ThreadWatchState } from "../../core/surface_api.js";
import {
  buildCardPages,
  type DiscordSurfacePage,
  type SurfaceTone,
} from "./components_renderer.js";
import {
  isSendableChannel,
  sendDiscordPages,
} from "./stream_delivery.js";

const COMPLETE_STATES = new Set(["COMPLETE", "COMPLETED"]);
const FAILED_STATES = new Set(["ERROR", "FAILED"]);
const ENDED_STATES = new Set([
  "CANCELED",
  "CANCELLED",
  "INTERRUPTED",
  "TERMINATED",
  "TIMED_OUT",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inlineCode(value: string): string {
  const backtickRuns = value.match(/`+/g) ?? [];
  const delimiterLength = Math.max(1, ...backtickRuns.map((run) => run.length + 1));
  const delimiter = "`".repeat(delimiterLength);
  return delimiterLength === 1
    ? `${delimiter}${value}${delimiter}`
    : `${delimiter} ${value} ${delimiter}`;
}

function titleAndTone(state: string | null): { title: string; tone: SurfaceTone } {
  const normalized = state?.toUpperCase() ?? "";
  if (COMPLETE_STATES.has(normalized)) {
    return { title: "Research run reported complete", tone: "success" };
  }
  if (FAILED_STATES.has(normalized)) {
    return { title: "Research run reported failed", tone: "danger" };
  }
  if (ENDED_STATES.has(normalized)) {
    return { title: "Research run reported ended", tone: "warning" };
  }
  return { title: "Research run update", tone: "info" };
}

const WATCH_PRESENTATION: Record<ThreadWatchState, { text: string; tone: SurfaceTone }> = {
  watching: { text: "idle", tone: "neutral" },
  running: { text: "running", tone: "working" },
  completed: { text: "completed", tone: "success" },
  interrupted: { text: "interrupted", tone: "warning" },
  failed: { text: "failed", tone: "danger" },
  "needs-attention": { text: "needs attention", tone: "warning" },
};

function isThreadWatchPayload(value: unknown): value is ThreadWatchPayload {
  return isRecord(value) && typeof value.group === "string" && isRecord(value.changed)
    && typeof value.changed.label === "string" && typeof value.changed.state === "string"
    && Object.hasOwn(WATCH_PRESENTATION, value.changed.state) && Array.isArray(value.agents);
}

function buildThreadWatchPages(payload: ThreadWatchPayload): DiscordSurfacePage[] {
  const changed = WATCH_PRESENTATION[payload.changed.state];
  const counts = new Map<string, number>();
  for (const agent of payload.agents) {
    const text = WATCH_PRESENTATION[agent.state]?.text ?? "unknown";
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const details = [
    `**Group:** ${inlineCode(payload.group)}`,
    `**Agents:** ${[...counts].map(([text, count]) => `${count} ${text}`).join(" · ")}`,
    "",
    "The agent is checking the delegated conversations.",
  ].join("\n");
  return buildCardPages({
    title: `Delegated agent ${inlineCode(payload.changed.label)} ${changed.text}`,
    text: details,
    tone: changed.tone,
  });
}

export function buildDiscordSignalNoticePages(signal: RegisteredSignal): DiscordSurfacePage[] {
  if (signal.envelope.kind === THREAD_WATCH_SIGNAL_KIND) {
    return isThreadWatchPayload(signal.envelope.payload) ? buildThreadWatchPages(signal.envelope.payload) : [];
  }
  if (
    signal.envelope.kind !== "research.state-changed"
    || signal.envelope.subject?.type !== "research-run"
    || !isRecord(signal.envelope.payload)
  ) {
    return [];
  }

  const payload = signal.envelope.payload;
  const state = typeof payload.state === "string" ? payload.state : null;
  const verified = typeof payload.verified === "boolean" ? payload.verified : null;
  const researchProject = typeof payload.researchProject === "string"
    ? payload.researchProject
    : null;
  const presentation = titleAndTone(state);
  const details = [
    `**Run:** ${inlineCode(signal.envelope.subject.id)}`,
    `**Reported state:** ${state ? inlineCode(state) : "Not reported"}`,
    `**Producer marked verified:** ${verified === null ? "Not reported" : verified ? "Yes" : "No"}`,
    ...(researchProject ? [`**Project:** ${inlineCode(researchProject)}`] : []),
    "",
    "The agent is checking authoritative workspace state.",
  ].join("\n");

  return buildCardPages({
    title: presentation.title,
    text: details,
    tone: presentation.tone,
  });
}

export async function presentDiscordSignalNotice(options: {
  client: { channels: { fetch: (surfaceId: string) => Promise<unknown> } };
  signal: RegisteredSignal;
  recordReplyTarget: (surfaceId: string, messageId: string) => void;
}): Promise<void> {
  if (options.signal.target.delivery.adapter !== "discord") return;
  const pages = buildDiscordSignalNoticePages(options.signal);
  if (pages.length === 0) return;

  const surfaceId = options.signal.target.delivery.surfaceId;
  const channel = await options.client.channels.fetch(surfaceId);
  if (!isSendableChannel(channel)) {
    throw new Error("The signal target is not a sendable Discord channel.");
  }

  const delivered = await sendDiscordPages(channel, pages);
  const replyTarget = delivered.messageIds[0];
  if (replyTarget) options.recordReplyTarget(surfaceId, replyTarget);
  if (!delivered.success) {
    throw new Error(delivered.error ?? "Discord signal notice delivery failed.");
  }
}
