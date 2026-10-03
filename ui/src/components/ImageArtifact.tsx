import type { WebImage } from "../../../shared/protocol/web";
import { useState } from "react";
import { isImageAssetUrl } from "../image-artifacts";

export function ImageArtifact({ image, inline = false, alt, collapsePrompt = false }: { image: WebImage; inline?: boolean; alt?: string; collapsePrompt?: boolean }) {
  const [failed, setFailed] = useState(false);
  // Only the API's conversation-scoped asset route may cause a browser fetch.
  const safe = isImageAssetUrl(image.url);
  const Container = inline ? "span" : "figure";
  const Caption = inline ? "span" : "figcaption";
  if (!safe || failed) return <span className="notice">Image unavailable. Reload the conversation to retry.</span>;
  const caption = alt || image.prompt || image.name;
  return <Container className={inline ? "inline-flex max-w-full flex-col gap-2 align-top" : "space-y-2"}>
    <a href={image.url} target="_blank" rel="noopener noreferrer" aria-label={image.name ? `Open image: ${image.name}` : "Open image"}>
      <img src={image.url} alt={caption || "Image"} loading="lazy" onError={() => setFailed(true)} className="max-h-96 max-w-full rounded-xl border border-line object-contain" />
    </a>
    {collapsePrompt && image.prompt && !inline ? <details className="generation-details text-xs text-muted">
      <summary className="cursor-pointer">Generation details</summary><p className="mt-2 whitespace-pre-wrap">{image.prompt}</p>
    </details> : caption && <Caption className="text-xs text-muted">{caption}</Caption>}
  </Container>;
}
