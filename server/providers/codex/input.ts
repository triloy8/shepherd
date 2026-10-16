import type { ImageDetail, UserInput } from "../../../shared/protocol/user_input.js";

export type NativeImageDetail = "low" | "high" | "original";
export type NativeInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string; detail?: NativeImageDetail }
  | { type: "localImage"; path: string; detail?: NativeImageDetail }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string };

/** Codex calls an undownscaled image "original". */
function nativeDetail(detail: ImageDetail | undefined): { detail?: NativeImageDetail } {
  return detail ? { detail: detail === "full" ? "original" : detail } : {};
}

/** SDK wire input is constructed inside the adapter. */
export function codexInput(input: UserInput[]): NativeInput[] {
  return input.map(part => {
    switch (part.type) {
      case "text": return { type: "text", text: part.text, text_elements: [] };
      case "image": return { type: "image", url: part.url, ...nativeDetail(part.detail) };
      case "image_file": return { type: "localImage", path: part.path, ...nativeDetail(part.detail) };
      case "audio": return { type: "audio", url: part.url };
      case "audio_file": return { type: "localAudio", path: part.path };
      case "skill": return { type: "skill", name: part.name, path: part.path };
    }
  });
}
