import type { HistoryContentPart, HistoryItem, HistoryTurn, TurnStatus } from "../../../shared/protocol/requests.js";
import { claudeActivity, claudeActivityFields } from "./activity.js";

/* Claude's transcript is authoritative. One decoder turns its messages into application turns
 * and items, both for the live SDK stream and for stored sessions, so an item delivered live is
 * the record history later returns. */

const reasoningChars = 8_000;
const interruptedMarker = /^\[Request interrupted/;

type Block = { type?: unknown; [key: string]: unknown };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const blocks = (content: unknown): Block[] => typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(record) : [];

/** The CLI writes one transcript entry per content block. Later text blocks of one API message
 * need distinct item IDs, numbered the same way live and in history. */
export function textItemId(messageId: string, index: number): string { return index === 0 ? messageId : `${messageId}:${index}`; }

/** Content of a prompt as the user sent it. */
export function promptContent(content: unknown): HistoryContentPart[] {
  return blocks(content).flatMap((block): HistoryContentPart[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "image") {
      const source = record(block.source);
      if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") return [{ type: "image", url: `data:${source.media_type};base64,${source.data}` }];
      return typeof source.url === "string" ? [{ type: "image", url: source.url }] : [{ type: "image" }];
    }
    return [{ type: "attachment", name: null, path: null }];
  });
}

function bounded(value: string): string {
  return value.length > reasoningChars ? `${value.slice(0, reasoningChars)}\n[${value.length - reasoningChars} characters omitted]` : value;
}

export type ItemListener = (stage: "started" | "completed", turnId: string, item: HistoryItem) => void;

export class ClaudeTranscript {
  readonly turns: HistoryTurn[] = [];
  private pendingText: Array<{ id: string; text: string }> = [];
  private readonly textBlocks = new Map<string, number>();
  private readonly thinkingBlocks = new Map<string, number>();
  constructor(private readonly listener: ItemListener = () => {}) {}

  get current(): HistoryTurn | null {
    const turn = this.turns.at(-1);
    return turn?.status === "in_progress" ? turn : null;
  }

  /** A prompt begins a turn. Background task notifications begin one without a user message. */
  beginTurn(id: string, startedAt: number, content: HistoryContentPart[] | null): HistoryTurn {
    const turn: HistoryTurn = { id, items: [], itemsView: "full", status: "in_progress", error: null, startedAt, completedAt: null, durationMs: null };
    this.turns.push(turn);
    if (content) turn.items.push({ id, type: "user_message", content });
    return turn;
  }

  /** Input sent while a turn runs joins that turn. */
  steer(id: string, content: HistoryContentPart[]): void {
    this.current?.items.push({ id, type: "user_message", content });
  }

  /** A response ended: its last text answers the input it responded to. */
  answered(): void {
    const turn = this.current;
    if (turn) this.flush(turn, "final");
  }

  assistant(message: unknown): void {
    const turn = this.current;
    const native = record(message);
    const messageId = typeof native.id === "string" ? native.id : null;
    if (!turn || !messageId) return;
    for (const block of blocks(native.content)) {
      if (block.type === "text" && typeof block.text === "string") {
        const index = this.textBlocks.get(messageId) ?? 0;
        this.textBlocks.set(messageId, index + 1);
        if (block.text) this.pendingText.push({ id: textItemId(messageId, index), text: block.text });
      }
      // Thinking precedes more work in the response, so text before it is interim. Redacted thinking has no text.
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        const index = this.thinkingBlocks.get(messageId) ?? 0;
        this.thinkingBlocks.set(messageId, index + 1);
        this.flush(turn, "interim");
        this.complete(turn, { id: `${messageId}:thinking:${index}`, type: "reasoning", summary: [bounded(block.thinking)] });
      }
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        this.flush(turn, "interim");
        // A plan proposed for approval is the turn's plan, as well as a tool call.
        const plan = block.name === "ExitPlanMode" ? record(block.input).plan : null;
        if (typeof plan === "string" && plan.trim()) this.complete(turn, { id: `${block.id}:plan`, type: "plan", text: plan });
        const item: HistoryItem = { id: block.id, type: "activity", status: "started", activity: claudeActivity(block.name, claudeActivityFields(block.input)) };
        turn.items.push(item);
        this.listener("started", turn.id, item);
      }
    }
  }

  toolResults(content: unknown): void {
    const turn = this.current;
    if (!turn) return;
    for (const block of blocks(content)) {
      if (block.type !== "tool_result") continue;
      const index = turn.items.findIndex(item => item.id === block.tool_use_id && item.type === "activity");
      const item = turn.items[index];
      if (item?.type !== "activity") continue;
      const completed: HistoryItem = { ...item, status: block.is_error ? "failed" : "completed" };
      turn.items[index] = completed;
      this.listener("completed", turn.id, completed);
    }
  }

  /** A finished response's last text answers it; otherwise its text was progress. */
  finish(status: Exclude<TurnStatus, "in_progress">, completedAt: number, error?: string): HistoryTurn | null {
    const turn = this.current;
    if (!turn) return null;
    this.flush(turn, status === "completed" ? "final" : "interim");
    this.textBlocks.clear(); this.thinkingBlocks.clear();
    turn.status = status;
    if (error) turn.error = { message: error };
    turn.completedAt = completedAt;
    turn.durationMs = turn.startedAt === null ? null : Math.max(0, (completedAt - turn.startedAt) * 1000);
    return turn;
  }

  /** The current turn as it stands, with text whose role is not yet known left unphased. */
  snapshot(): HistoryTurn[] {
    const turn = this.current;
    if (!turn || !this.pendingText.length) return this.turns;
    return [...this.turns.slice(0, -1), { ...turn, items: [...turn.items, ...this.pendingText.map(({ id, text }): HistoryItem => ({ id, type: "assistant_message", text }))] }];
  }

  private flush(turn: HistoryTurn, phase: "interim" | "final"): void {
    for (const { id, text } of this.pendingText.splice(0)) this.complete(turn, { id, type: "assistant_message", text, phase });
  }

  private complete(turn: HistoryTurn, item: HistoryItem): void {
    turn.items.push(item);
    this.listener("completed", turn.id, item);
  }
}

/** A stored transcript entry, as `getSessionMessages` returns it. */
export type TranscriptEntry = {
  type: "user" | "assistant" | "system"; uuid: string; message: unknown; parent_tool_use_id: string | null;
  timestamp?: unknown; isQueuedCommand?: unknown; origin?: unknown;
};

function seconds(value: unknown, fallback: number): number {
  const time = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(time) ? time / 1000 : fallback;
}

/** Decode a stored session. The transcript records no turn results, so a turn ends when the
 * next prompt arrives or the transcript ends; an interruption marker ends it as interrupted.
 * `activeTurnId` names a turn still running in this process, which stays in progress. */
export function decodeTranscript(entries: readonly TranscriptEntry[], activeTurnId: string | null = null): { turns: HistoryTurn[]; model: string | null; usage: unknown } {
  const transcript = new ClaudeTranscript();
  let model: string | null = null, usage: unknown = null, last = 0;
  for (const entry of entries) {
    // Subagent work belongs to its delegation activity, not the main conversation.
    if (entry.parent_tool_use_id) continue;
    const at = seconds(entry.timestamp, last);
    const message = record(entry.message);
    const content = blocks(message.content);
    if (entry.type === "assistant") {
      if (typeof message.model === "string") model = message.model;
      if (message.usage) usage = message.usage;
      transcript.assistant(message);
    } else if (entry.type === "user" && content.some(block => block.type === "tool_result")) {
      transcript.toolResults(content);
    } else if (entry.type === "user" && content.some(block => block.type === "text" && typeof block.text === "string" && interruptedMarker.test(block.text))) {
      transcript.finish("interrupted", at);
    } else if (entry.type === "user" && entry.isQueuedCommand === true && transcript.current) {
      // Claude records queued input when it reads it, after answering the input before it.
      transcript.answered();
      transcript.steer(entry.uuid, promptContent(message.content));
    } else if (entry.type === "user") {
      // A turn ends with its last entry, before the next prompt.
      transcript.finish("completed", last);
      const background = record(entry.origin).kind === "task-notification";
      transcript.beginTurn(entry.uuid, at, background ? null : promptContent(message.content));
    }
    last = at;
  }
  if (transcript.current && transcript.current.id !== activeTurnId) transcript.finish("completed", last);
  return { turns: transcript.snapshot(), model, usage };
}
