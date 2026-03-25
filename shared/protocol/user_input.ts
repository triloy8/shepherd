export type UserInputTextElement = Record<string, unknown>;

export type UserInput =
  | { type: "text"; text: string; text_elements: UserInputTextElement[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export function toTextUserInput(text: string): UserInput {
  return { type: "text", text, text_elements: [] };
}
