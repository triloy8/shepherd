import type { WebImage } from "../../../shared/protocol/web";
import { useState } from "react";

export function ImageArtifact({ image }: { image: WebImage }) {
  const [failed, setFailed] = useState(false);
  // Only the API's conversation-scoped asset route may cause a browser fetch.
  const safe = /^\/api\/v1\/conversations\/[a-zA-Z0-9-]+\/images\/[a-zA-Z0-9-]+$/.test(image.url);
  if (!safe || failed) return <p className="notice">Image unavailable. Reload the conversation to retry.</p>;
  const caption = image.prompt || image.name;
  return <figure className="space-y-2">
    <a href={image.url} target="_blank" rel="noopener noreferrer" aria-label={image.name ? `Open image: ${image.name}` : "Open image"}>
      <img src={image.url} alt={caption || "Image"} loading="lazy" onError={() => setFailed(true)} className="max-h-96 max-w-full rounded-xl border border-line object-contain" />
    </a>
    {caption && <figcaption className="text-xs text-muted">{caption}</figcaption>}
  </figure>;
}
