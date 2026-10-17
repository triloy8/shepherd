/** What an agent action does, described by its target rather than by a native tool call.
 * Adapters classify their own tools into these kinds and extract the fields; native arguments
 * never cross the boundary. Surfaces write every label from these fields. A new kind belongs
 * here only when surfaces present it differently; anything else is `other`. */
export type Activity =
  /** `result` is what a finished command printed, when the provider records it. */
  | { kind: "command"; command: string | null; cwd: string | null; result?: CommandResult }
  | { kind: "file_change"; paths: string[] }
  /** `application` tools are Shepherd's own; `builtin` tools are the agent's own (for example
   * file reads or searches). `target` is the main argument, such as a path or pattern. */
  | { kind: "tool"; source: "application" | "mcp" | "builtin"; server: string | null; name: string; target: string | null }
  | { kind: "web"; query: string | null; url: string | null }
  | { kind: "delegation"; description: string | null }
  | { kind: "image"; action: "view" | "generate"; path: string | null; prompt: string | null }
  | { kind: "wait"; durationMs: number | null }
  | { kind: "other"; title: string; detail: string | null };

/** The end of a finished command's output, and its exit code when the provider reports one. */
export type CommandResult = { output: string; exitCode: number | null };

/** History keeps the end of a command's output: the part that shows how it finished. */
export const COMMAND_OUTPUT_LIMIT = 4_096;

/** A command's result as every provider records it, bounded the same way; none when it printed
 * nothing and reported no exit code. */
export function commandResult(output: string | null, exitCode: number | null): CommandResult | undefined {
  const text = output ?? "";
  if (!text && exitCode === null) return undefined;
  return { output: text.length > COMMAND_OUTPUT_LIMIT ? `…${text.slice(-COMMAND_OUTPUT_LIMIT)}` : text, exitCode };
}

export type ActivityKind = Activity["kind"];
export type ActivityStatus = "started" | "completed" | "failed";

/** A presentation of an activity shared by every surface. */
export interface ActivityDescription { title: string; detail: string | null }

const listed = (values: readonly string[], visible = 3): string | null => {
  if (!values.length) return null;
  const shown = values.slice(0, visible);
  return `${shown.join(", ")}${values.length > shown.length ? ` +${values.length - shown.length} more` : ""}`;
};
const joined = (...parts: Array<string | null>): string | null => parts.filter(Boolean).join(".") || null;

export function describeActivity(activity: Activity): ActivityDescription {
  switch (activity.kind) {
    case "command": return { title: "Running command", detail: activity.command };
    case "file_change": return { title: "Changing files", detail: listed(activity.paths) };
    case "tool": {
      if (activity.source === "builtin") return { title: `Using ${activity.name}`, detail: activity.target };
      const name = joined(activity.server, activity.name);
      return { title: activity.source === "mcp" ? "Calling MCP tool" : "Calling tool", detail: activity.target ? `${name}: ${activity.target}` : name };
    }
    case "web": return activity.query !== null || activity.url === null
      ? { title: "Searching the web", detail: activity.query }
      : { title: "Fetching a page", detail: activity.url };
    case "delegation": return { title: "Delegating to an agent", detail: activity.description };
    case "image": return activity.action === "generate"
      ? { title: "Generating image", detail: activity.prompt }
      : { title: "Viewing image", detail: activity.path };
    case "wait": return { title: "Waiting", detail: activity.durationMs === null ? null : `${activity.durationMs} ms` };
    case "other": return { title: activity.title, detail: activity.detail };
  }
}

/** The question a permission request asks, written from the activity it would allow. */
export function describePermission(activity: Activity): ActivityDescription {
  const { detail } = describeActivity(activity);
  switch (activity.kind) {
    case "command": return { title: "Allow this command?", detail };
    case "file_change": return { title: "Allow these file changes?", detail };
    case "tool": return { title: `Allow ${activity.source === "builtin" ? activity.name : joined(activity.server, activity.name)}?`, detail: activity.target };
    case "web": return { title: activity.query !== null || activity.url === null ? "Allow a web search?" : "Allow fetching this page?", detail };
    case "delegation": return { title: "Allow delegating to an agent?", detail };
    case "image": return { title: activity.action === "generate" ? "Allow generating an image?" : "Allow viewing this image?", detail };
    case "wait": return { title: "Allow waiting?", detail };
    case "other": return { title: `Allow: ${activity.title}?`, detail };
  }
}

/** The title surfaces show for reasoning: a provider's summary of its reasoning is not the reasoning itself. */
export function reasoningTitle(form: import("./requests.js").ReasoningForm): string {
  return form === "summary" ? "Reasoning summary" : "Reasoning";
}
