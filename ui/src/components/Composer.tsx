import { readDraftImages, type DraftImage } from "../image-input";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export function Composer({ draft, onDraft, images, onImages, send, disabled, busy, active, interrupt }: {
  draft: string; onDraft: (value: string) => void; images: DraftImage[]; onImages: (update: (current: DraftImage[]) => DraftImage[]) => void; send: (text: string, images: string[]) => Promise<boolean>;
  disabled: boolean; busy: boolean; active: boolean; interrupt: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const readingRef = useRef(false);
  const [reading, setReading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  async function addFiles(files: File[]) {
    if (!files.length || readingRef.current || sending) return;
    readingRef.current = true; setReading(true); setImageError(null);
    try { const added = await readDraftImages(files, images); if (mounted.current) onImages((current) => [...current, ...added]); }
    catch (error) { setImageError(error instanceof Error ? error.message : "Could not read image."); }
    finally { readingRef.current = false; setReading(false); }
  }
  const [sending, setSending] = useState(false);
  async function submit() {
    if ((!draft.trim() && !images.length) || disabled || busy || sending || readingRef.current) return;
    const value = draft;
    setSending(true);
    try { if (await send(value, images.map((image) => image.url))) { onDraft(""); onImages((current) => current.filter((image) => !images.some((sent) => sent.id === image.id))); setImageError(null); } } finally { setSending(false); }
  }
  return <form className="composer" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); void addFiles(files); } }} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <input ref={picker} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Choose images" className="sr-only" disabled={sending || reading} onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    {images.length > 0 && <div className="flex flex-wrap gap-3 p-3" aria-label="Attached images">{images.map((image) => <figure key={image.id} className="w-24"><img src={image.url} alt={image.name} className="h-20 w-24 rounded-lg border border-line object-contain" /><figcaption className="truncate text-xs text-muted">{image.name}</figcaption><button type="button" className="text-xs underline" aria-label={`Remove ${image.name}`} disabled={sending || reading} onClick={() => onImages((current) => current.filter((item) => item.id !== image.id))}>Remove</button></figure>)}</div>}
    {imageError && <p role="alert" className="notice m-3">{imageError}</p>}
    {reading && <p role="status" className="px-3 text-xs text-muted">Reading images…</p>}
    <textarea aria-label="Message Shepherd" placeholder={active ? "Add a follow-up…" : "Message Shepherd…"}
      onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files); } }}
      value={draft} onChange={(event) => onDraft(event.target.value)} maxLength={32768} rows={3} disabled={sending}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
          event.preventDefault(); void submit();
        }
      }} />
    <div className="flex items-center justify-between gap-3 px-3 pb-3">
      <span className="pl-1 text-xs text-dim">{disabled ? "Waiting for connection" : active ? "Follow-ups steer the active turn" : "A little context goes a long way"}</span>
      <div className="flex items-center gap-2">
        <button type="button" className="icon-button" aria-label="Attach images" title="Attach images (PNG, JPEG, GIF, WebP)" disabled={sending || reading || images.length >= 4} onClick={() => picker.current?.click()}><Icon name="image" /></button>
        {active && <button type="button" className="icon-button" aria-label="Stop response" disabled={disabled || busy} onClick={interrupt}><Icon name="stop" /></button>}
        <button className="send-button" aria-label={active ? "Send follow-up" : "Send message"} disabled={disabled || busy || sending || reading || (!draft.trim() && !images.length)}><Icon name="arrow" /></button>
      </div>
    </div>
  </form>;
}
