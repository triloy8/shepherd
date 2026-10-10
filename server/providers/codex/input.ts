import type { UserInput } from "../../../shared/protocol/user_input.js";
export type NativeInput = Exclude<UserInput, { type: "text" }> | { type: "text"; text: string; text_elements: import("../../../shared/protocol/user_input.js").UserInputTextElement[] };
/** SDK wire input is constructed inside the adapter. */
export function codexInput(input: UserInput[]): NativeInput[] {
  return input.map(part => {
    switch (part.type) {
      case "text": return { type: "text", text: part.text, text_elements: (part.annotations ?? []).map(annotation => ({ byteRange: { ...annotation.byteRange }, placeholder: annotation.placeholder })) };
      case "image": return { type: "image", url: part.url, ...(part.detail ? { detail: part.detail } : {}) };
      case "localImage": return { type: "localImage", path: part.path, ...(part.detail ? { detail: part.detail } : {}) };
      case "audio": return { type: "audio", url: part.url };
      case "localAudio": return { type: "localAudio", path: part.path };
      case "skill": return { type: "skill", name: part.name, path: part.path };
      case "mention": return { type: "mention", name: part.name, path: part.path };
    }
  });
}
