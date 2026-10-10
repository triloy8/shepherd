/** Public presentation data. Native SDK payloads belong in provider adapters. */
export interface BoundedText {
  text: string;
  truncated: boolean;
  totalBytes: number | null;
}

export type InputMedia = "image" | "audio";
export interface AssetReference {
  id: string;
  media: InputMedia | "text" | "file";
  mimeType: string | null;
  name: string | null;
  availability: "available" | "unavailable";
}

export type InputPart =
  | { type: "text"; text: string }
  | { type: "asset"; assetId: string; media: InputMedia }
  | { type: "skill" | "mention"; name: string; referenceId: string };
export type ConversationInput = InputPart[];
export type HistoryInputPart = { type: "text"; text: BoundedText } | Exclude<InputPart, { type: "text" }>;
export type ItemStatus = "in_progress" | "completed" | "failed" | "interrupted" | "declined" | "unknown";

interface ItemContent {
  user_message: { content: HistoryInputPart[] };
  assistant_message: { text: BoundedText; phase: "commentary" | "final_answer" | null };
  reasoning: { summary: BoundedText[] };
  plan: { text: BoundedText | null; steps: Array<{ text: BoundedText; status: "pending" | "in_progress" | "completed" }> };
  command: {
    command: BoundedText; description: BoundedText | null; cwd: string | null;
    actions: Array<{ kind: "read" | "search" | "list" | "other"; path: string | null; query: BoundedText | null }>;
    output: BoundedText | null; exitCode: number | null; durationMs: number | null;
    execution: "foreground" | "background" | "unknown"; taskId: string | null;
  };
  file_change: { changes: Array<{
    path: string; kind: "add" | "update" | "delete" | "move"; movePath: string | null;
    diff: BoundedText | null; additions: number | null; deletions: number | null; applied: boolean | null;
  }> };
  file_read: { reads: Array<{ path: string; offset: number | null; limit: number | null }>; output: BoundedText | null };
  search: { queries: BoundedText[]; paths: string[]; output: BoundedText | null };
  web: {
    action: "search" | "open_page" | "find_in_page" | "other";
    queries: BoundedText[]; url: string | null; pattern: BoundedText | null; output: BoundedText | null;
  };
  tool: { source: "mcp" | "shepherd" | "provider"; server: string | null; name: string;
    input: BoundedText | null; output: BoundedText | null; assets: AssetReference[] };
  subagent: {
    action: "spawn" | "wait" | "send" | "stop" | "resume" | "activity" | "other";
    description: BoundedText; prompt: BoundedText | null; report: BoundedText | null;
    agents: Array<{ id: string; threadId: string | null; status: ItemStatus; report: BoundedText | null }>;
    taskId: string | null;
  };
  image: { origin: "generated" | "viewed"; asset: AssetReference; prompt: BoundedText | null };
  notice: { kind: "compaction" | "review" | "hook" | "wait" | "warning" | "other"; text: BoundedText };
}

interface ItemBase {
  id: string;
  turnId: string;
  parentItemId: string | null;
  relatedItemIds: string[];
  status: ItemStatus;
  startedAt: number | null;
  completedAt: number | null;
  error: BoundedText | null;
  recovery: "complete" | "partial" | "transient";
  detailAsset: AssetReference | null;
}

type ArrayKeys<T> = { [K in keyof T]: T[K] extends unknown[] ? K : never }[keyof T];
/** Missing fields and omission counts are specific to the discriminated variant. */
export type ConversationItem = {
  [K in keyof ItemContent]: ItemBase & ItemContent[K] & {
    type: K;
    unavailableFields: Array<keyof (ItemBase & ItemContent[K])>;
    omitted: Partial<Record<ArrayKeys<ItemBase & ItemContent[K]>, number>>;
  }
}[keyof ItemContent];

export interface ConversationTurn {
  id: string;
  status: "in_progress" | "completed" | "interrupted" | "failed";
  error: BoundedText | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  itemsView: "summary" | "full" | "not_loaded";
  items: ConversationItem[];
  itemsNextCursor: string | null;
}

/** Runtime versions are not stored in native history or neutral item records. */
export interface VersionedItem { item: ConversationItem; revision: number }
