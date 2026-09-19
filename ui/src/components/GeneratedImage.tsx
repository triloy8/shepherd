import type { WebImage } from "../../../shared/protocol/web";
import { useState } from "react";

export function GeneratedImage({ image }: { image: WebImage }) {
  const [failed, setFailed] = useState(false);
  // Only the API's conversation-scoped asset route may cause a browser fetch.
  const safe = /^\/api\/v1\/conversations\/[a-zA-Z0-9-]+\/images\/[a-zA-Z0-9-]+$/.test(image.url);
  if (!safe || failed) return <p className="notice">Generated image unavailable. Reload the conversation to retry.</p>;
  return <figure className="space-y-2">
    <a href={image.url} target="_blank" rel="noopener noreferrer" aria-label="Open generated image">
      <img src={image.url} alt={image.prompt || "Generated image"} loading="lazy" onError={() => setFailed(true)} className="max-h-96 max-w-full rounded-xl border border-line object-contain" />
    </a>
    {image.prompt && <figcaption className="text-xs text-muted">{image.prompt}</figcaption>}
  </figure>;
}
