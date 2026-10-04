import type { WebImage } from "../../../shared/protocol/web";
import { useEffect, useState } from "react";
import { isImageAssetUrl } from "../image-artifacts";

export function ImageArtifact({ image, inline = false, alt, collapsePrompt = false }: { image: WebImage; inline?: boolean; alt?: string; collapsePrompt?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    const retry = () => setFailedUrl(null);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  // Only the API's conversation-scoped asset route may cause a browser fetch.
  const safe = isImageAssetUrl(image.url);
  const Container = inline ? "span" : "figure";
  const Caption = inline ? "span" : "figcaption";
  if (!safe) return <span className="notice">Image unavailable.</span>;
  if (failedUrl === image.url) return <span className="notice">Image unavailable. <button type="button" className="underline" onClick={() => setFailedUrl(null)}>Retry image</button></span>;
  const caption = alt || image.prompt || image.name;
  return <Container className={inline ? "inline-flex max-w-full flex-col gap-2 align-top" : "space-y-2"}>
    <a href={image.url} target="_blank" rel="noopener noreferrer" aria-label={image.name ? `Open image: ${image.name}` : "Open image"}>
      <img key={image.url} src={image.url} alt={caption || "Image"} loading="lazy" onError={() => setFailedUrl(image.url)} className="max-h-96 max-w-full rounded-xl border border-line object-contain" />
    </a>
    {collapsePrompt && image.prompt && !inline ? <details className="generation-details text-xs text-muted">
      <summary className="cursor-pointer">Generation details</summary><p className="mt-2 whitespace-pre-wrap">{image.prompt}</p>
    </details> : caption && <Caption className="text-xs text-muted">{caption}</Caption>}
  </Container>;
}
