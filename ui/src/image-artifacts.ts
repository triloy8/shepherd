import type { WebImage } from "../../shared/protocol/web";

export const isImageAssetUrl = (url: string) => /^\/api\/v1\/conversations\/[a-zA-Z0-9-]+\/images\/[a-zA-Z0-9-]+$/.test(url);

/** Text can reference known artifacts; it never grants access to another file or URL. */
export function resolveImageArtifact(source: string | undefined, images: readonly WebImage[]): WebImage | undefined {
  if (!source) return;
  const known = images.filter((image) => isImageAssetUrl(image.url));
  const exact = known.find((image) => image.path === source || image.url === source);
  if (exact) return exact;
  try {
    const decoded = decodeURIComponent(source);
    return known.find((image) => image.path === decoded || image.url === decoded);
  } catch { return; }
}
