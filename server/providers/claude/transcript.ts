import type { HistoryContentPart, HistoryItem, HistoryTurn, TurnStatus } from "../../../shared/protocol/requests.js";
import { claudeActivity, claudeActivityFields } from "./activity.js";
import { commandResult } from "../../../shared/protocol/activity.js";

/* Claude's transcript is authoritative. One decoder turns its messages into application turns
 * and items, both for the live SDK stream and for stored sessions, so an item delivered live is
 * the record history later returns. */

const reasoningChars = 8_000;
const interruptedMarker = /^\[Request interrupted/;

type Block = { type?: unknown; [key: string]: unknown };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const blocks = (content: unknown): Block[] => typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(record) : [];

/** A command keeps the end of what it printed. Claude reports a failed command's exit code on the
 * result's first line; other tools' results stay out of history. */
function withResult(activity: import("../../../shared/protocol/activity.js").Activity, block: Block) {
  if (activity.kind !== "command") return activity;
  const output = blocks(block.content).flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  const exit = block.is_error ? /^Exit code (\d+)/.exec(output) : null;
  const result = commandResult(output, exit ? Number(exit[1]) : null);
  return result ? { ...activity, result } : activity;
}

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
  /** Block counters for subagent messages, which can outlast the turn that started them. */
  private readonly subagentBlocks = new Map<string, number>();
  constructor(private readonly listener: ItemListener = () => {}) {}

  get current(): HistoryTurn | null {
    const turn = this.turns.at(-1);
    return turn?.status === "in_progress" ? turn : null;
  }

  /** A prompt begins a turn. Background task notifications begin one without a user message,
   * marked as started by background work. */
  beginTurn(id: string, startedAt: number, content: HistoryContentPart[] | null): HistoryTurn {
    const turn: HistoryTurn = { id, ...(content ? {} : { trigger: "background" as const }), items: [], itemsView: "full", status: "in_progress", error: null, startedAt, completedAt: null, durationMs: null };
    this.turns.push(turn);
    if (content) turn.items.push({ id, type: "user_message", content });
    return turn;
  }

  /** Claude compacted the conversation: it continues from a summary of everything before. The
   * summary is Claude's, not the user's, so it is a step of the turn that was running. A stored
   * session begins at its last compaction, without the prompt of that turn, so there the step
   * begins a turn of its own. */
  compacted(id: string, summary: unknown, at: number): void {
    let turn = this.current;
    if (!turn) {
      turn = { id, items: [], itemsView: "full", status: "in_progress", error: null, startedAt: at, completedAt: null, durationMs: null };
      this.turns.push(turn);
    }
    this.flush(turn, "interim");
    const text = blocks(summary).flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
    this.complete(turn, { id, type: "activity", status: "completed", activity: { kind: "other", title: "Context compacted", detail: text || null } });
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
        this.complete(turn, { id: `${messageId}:thinking:${index}`, type: "reasoning", form: "summary", parts: [bounded(block.thinking)] });
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
    if (turn) this.completeTools(turn, content);
  }

  /** A subagent's message. Its items join the turn holding the delegation that started it, which
   * may have ended: a background subagent keeps working after its turn. A subagent's text is its
   * own progress, never the conversation's answer, so it is always interim. */
  subagent(parentItemId: string, role: "assistant" | "user", message: unknown): void {
    // Subagents can delegate too; their items name the nested delegation, which is itself an item.
    const turn = [...this.turns].reverse().find(candidate => candidate.items.some(item => item.id === parentItemId && item.type === "activity"));
    if (!turn) return;
    const native = record(message);
    if (role === "user") return this.completeTools(turn, native.content);
    const messageId = typeof native.id === "string" ? native.id : null;
    if (!messageId) return;
    const next = (kind: string) => { const key = `${kind}:${messageId}`; const index = this.subagentBlocks.get(key) ?? 0; this.subagentBlocks.set(key, index + 1); return index; };
    for (const block of blocks(native.content)) {
      if (block.type === "text" && typeof block.text === "string") {
        const index = next("text");
        if (block.text) this.complete(turn, { id: textItemId(messageId, index), type: "assistant_message", text: block.text, phase: "interim", parentItemId });
      }
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        this.complete(turn, { id: `${messageId}:thinking:${next("thinking")}`, type: "reasoning", form: "summary", parts: [bounded(block.thinking)], parentItemId });
      }
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const item: HistoryItem = { id: block.id, type: "activity", status: "started", activity: claudeActivity(block.name, claudeActivityFields(block.input)), parentItemId };
        turn.items.push(item);
        this.listener("started", turn.id, item);
      }
    }
  }

  private completeTools(turn: HistoryTurn, content: unknown): void {
    for (const block of blocks(content)) {
      if (block.type !== "tool_result") continue;
      const index = turn.items.findIndex(item => item.id === block.tool_use_id && item.type === "activity");
      const item = turn.items[index];
      if (item?.type !== "activity") continue;
      const completed: HistoryItem = { ...item, status: block.is_error ? "failed" : "completed", activity: withResult(item.activity, block) };
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
  timestamp?: unknown; isQueuedCommand?: unknown; origin?: unknown; isCompactSummary?: unknown;
};

function seconds(value: unknown, fallback: number): number {
  const time = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(time) ? time / 1000 : fallback;
}

/** Decode a stored session. The transcript records no turn results, so a turn ends when the
 * next prompt arrives or the transcript ends; an interruption marker ends it as interrupted.
 * `activeTurnId` names a turn still running in this process, which stays in progress. Subagent
 * transcripts are stored separately; they are merged in by time, as they streamed live. */
export function decodeTranscript(entries: readonly TranscriptEntry[], activeTurnId: string | null = null, subagentEntries: readonly TranscriptEntry[] = []): { turns: HistoryTurn[]; model: string | null; usage: unknown } {
  const transcript = new ClaudeTranscript();
  let model: string | null = null, usage: unknown = null, last = 0, waking = false;
  // An entry without a time takes the time before it, so it keeps its place; main entries come first on ties.
  const timed = (list: readonly TranscriptEntry[], offset: number) => { let at = 0; return list.map((entry, index) => ({ entry, index: offset + index, at: at = seconds(entry.timestamp, at) })); };
  const ordered = [...timed(entries, 0), ...timed(subagentEntries, entries.length)].sort((a, b) => a.at - b.at || a.index - b.index).map(({ entry }) => entry);
  for (const entry of ordered) {
    // Subagent work joins the delegation that started it; the subagent's own prompt is that delegation's input.
    if (entry.parent_tool_use_id) {
      if (entry.type === "assistant" || entry.type === "user") transcript.subagent(entry.parent_tool_use_id, entry.type, entry.message);
      continue;
    }
    const at = seconds(entry.timestamp, last);
    const message = record(entry.message);
    const content = blocks(message.content);
    if (entry.type === "assistant") {
      if (typeof message.model === "string") model = message.model;
      if (message.usage) usage = message.usage;
      transcript.assistant(message);
    } else if (entry.type === "user" && entry.isCompactSummary === true) {
      transcript.compacted(entry.uuid, message.content, at);
    } else if (entry.type === "user" && content.some(block => block.type === "tool_result")) {
      transcript.toolResults(content);
    } else if (entry.type === "user" && content.some(block => block.type === "text" && typeof block.text === "string" && interruptedMarker.test(block.text))) {
      transcript.finish("interrupted", at);
    } else if (entry.type === "user" && entry.isQueuedCommand === true && transcript.current) {
      // Claude records queued input when it reads it, after answering the input before it. A
      // background task's notification can be queued too; it is not the user's words, so the
      // turn continues without a message from them.
      transcript.answered();
      if (record(entry.origin).kind !== "task-notification") transcript.steer(entry.uuid, promptContent(message.content));
    } else if (entry.type === "user") {
      const origin = record(entry.origin);
      const background = origin.kind === "task-notification";
      // Notifications that arrive together wake one turn. A wake turn is named by the task run
      // whose notification started it, as the live stream names it.
      if (!(background && waking && transcript.current?.items.length === 0)) {
        // A turn ends with its last entry, before the next prompt.
        transcript.finish("completed", last);
        transcript.beginTurn(background && typeof origin.runId === "string" && origin.runId ? origin.runId : entry.uuid, at, background ? null : promptContent(message.content));
        waking = background;
      }
    }
    last = at;
  }
  if (transcript.current && transcript.current.id !== activeTurnId) transcript.finish("completed", last);
  return { turns: transcript.snapshot(), model, usage };
}
