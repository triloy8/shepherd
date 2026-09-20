import { imageDataParts, WEB_IMAGE_MAX_BYTES, WEB_IMAGE_MAX_COUNT, WEB_IMAGE_MIME_TYPES, WEB_IMAGES_MAX_BYTES } from "../../shared/protocol/image_input";
export type DraftImage = { id: string; name: string; url: string; bytes: number };
export async function readDraftImages(files: File[], existing: DraftImage[]): Promise<DraftImage[]> {
  if (existing.length + files.length > WEB_IMAGE_MAX_COUNT) throw new Error("Attach up to four images per message.");
  if (existing.reduce((sum, image) => sum + image.bytes, 0) + files.reduce((sum, file) => sum + file.size, 0) > WEB_IMAGES_MAX_BYTES) throw new Error("Images must total no more than 10 MiB.");
  const images: DraftImage[] = [];
  for (const file of files) {
    if (!(WEB_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) throw new Error(`${file.name}: choose PNG, JPEG, GIF, or WebP. Convert other formats before attaching.`);
    if (!file.size || file.size > WEB_IMAGE_MAX_BYTES) throw new Error(`${file.name}: images must be non-empty and no larger than 5 MiB.`);
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled.`));
      reader.readAsDataURL(file);
    });
    if (!imageDataParts(url)) throw new Error(`Could not read ${file.name} as an image.`);
    images.push({ id: crypto.randomUUID(), name: file.name, url, bytes: file.size });
  }
  return images;
}
