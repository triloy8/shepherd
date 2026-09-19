import { randomUUID } from "node:crypto";
import { loadGeneratedImage } from "../../core/generated_image.js";
import { WebRequestError } from "./errors.js";

/** Only provider-reported artifacts get URLs; clients never supply a file path. */
export class WebImages {
  private readonly images = new Map<string, { key: string; path: string }>();
  constructor(private readonly conversationId: string) {}

  register(turnId: string | null, itemId: string, path: string): string {
    const key = JSON.stringify([turnId, itemId]);
    let id = [...this.images].find(([, image]) => image.key === key && image.path === path)?.[0];
    if (!id) {
      id = randomUUID();
      if (this.images.size >= 256) this.images.delete(this.images.keys().next().value!);
      this.images.set(id, { key, path });
    }
    return `/api/v1/conversations/${this.conversationId}/images/${id}`;
  }

  async response(id: string, headers: Headers): Promise<Response> {
    const image = this.images.get(id);
    if (!image) throw new WebRequestError(404, "image_not_found", "Image not found. Reload conversation history.");
    try {
      const file = await loadGeneratedImage(image.path);
      headers.set("content-type", file.mimeType);
      headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      headers.set("content-security-policy", "default-src 'none'; sandbox");
      return new Response(new Uint8Array(file.attachment), { headers });
    } catch {
      throw new WebRequestError(422, "image_unavailable", "The generated image is unavailable or unsupported.");
    }
  }
}
