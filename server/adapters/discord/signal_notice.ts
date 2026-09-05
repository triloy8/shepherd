import type { RegisteredSignal } from "../../core/signal_registry.js";
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

export function buildDiscordSignalNoticePages(signal: RegisteredSignal): DiscordSurfacePage[] {
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
    "Codex is checking authoritative workspace state.",
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
