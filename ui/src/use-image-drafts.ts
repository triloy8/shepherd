import { useRef, useState } from "react";
import { readDraftImages, type DraftImage } from "./image-input";

// Reads belong to the draft, so selecting another conversation cannot cancel
// them or allow another reader to exceed the per-message image limits.
export function useImageDrafts() {
  const [images, setImages] = useState<Record<string, DraftImage[]>>({});
  const [reading, setReading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const pending = useRef(new Set<string>());
  const current = useRef(images);
  function update(id: string, change: (images: DraftImage[]) => DraftImage[]) {
    const next = { ...current.current, [id]: change(current.current[id] ?? []) };
    current.current = next;
    setImages(next);
  }
  async function addFiles(id: string, files: File[]) {
    if (!files.length || pending.current.has(id)) return;
    pending.current.add(id);
    setReading((all) => ({ ...all, [id]: true }));
    setErrors((all) => ({ ...all, [id]: null }));
    try {
      const added = await readDraftImages(files, current.current[id] ?? []);
      update(id, (images) => [...images, ...added]);
    } catch (error) {
      setErrors((all) => ({ ...all, [id]: error instanceof Error ? error.message : "Could not read image." }));
    } finally {
      pending.current.delete(id);
      setReading((all) => ({ ...all, [id]: false }));
    }
  }
  return { images, reading, errors, update, addFiles, clearError: (id: string) => setErrors((all) => ({ ...all, [id]: null })) };
}
