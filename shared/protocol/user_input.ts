export type ImageDetail = "auto" | "low" | "high" | "original";

export interface UserInputTextElement {
  byteRange: {
    start: number;
    end: number;
  };
  placeholder: string | null;
}

export type UserInput =
  | { type: "text"; text: string; text_elements: UserInputTextElement[] }
  | { type: "image"; url: string; detail?: ImageDetail }
  | { type: "localImage"; path: string; detail?: ImageDetail }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export function toTextUserInput(text: string): UserInput {
  return { type: "text", text, text_elements: [] };
}
