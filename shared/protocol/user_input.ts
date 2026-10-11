export type ImageDetail = "auto" | "low" | "high" | "original";

/** Application input. Adapters encode it into their native message formats. */
export type UserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string; detail?: ImageDetail }
  | { type: "image_file"; path: string; detail?: ImageDetail }
  | { type: "audio"; url: string }
  | { type: "audio_file"; path: string }
  | { type: "skill"; name: string; path: string };

export function toTextUserInput(text: string): UserInput {
  return { type: "text", text };
}
