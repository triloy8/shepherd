import type { DraftImage } from "../image-input";
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent } from "react";
import { Icon } from "./Icon";

export function Composer({ draft, draftRevision, onDraft, clearDraft, images, onImages, reading, imageError, addFiles: readFiles, clearImageError, send, disabled, busy, active, interrupt }: {
  draft: string; draftRevision: number; onDraft: (value: string) => void; clearDraft: (revision: number) => void;
  images: DraftImage[]; onImages: (update: (current: DraftImage[]) => DraftImage[]) => void; send: (text: string, images: string[]) => Promise<boolean>;
  reading: boolean; imageError: string | null; addFiles: (files: File[]) => Promise<void>; clearImageError: () => void;
  disabled: boolean; busy: boolean; active: boolean; interrupt: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  };
  useLayoutEffect(resize, [draft]);
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; resize(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const readingRef = useRef(false);
  async function addFiles(files: File[]) {
    if (sendingRef.current || reading || readingRef.current) return;
    readingRef.current = true;
    try { await readFiles(files); } finally { readingRef.current = false; }
  }
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (!files.length || sendingRef.current) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) {
      const element = event.currentTarget;
      const remaining = Math.max(0, element.maxLength - element.value.length + element.selectionEnd - element.selectionStart);
      element.setRangeText(text.slice(0, remaining), element.selectionStart, element.selectionEnd, "end");
      onDraft(element.value);
    }
    void addFiles(files);
  }
  async function submit() {
    if ((!draft.trim() && !images.length) || disabled || busy || sendingRef.current || reading || readingRef.current) return;
    const value = draft;
    const revision = draftRevision;
    sendingRef.current = true; setSending(true);
    try {
      if (await send(value, images.map((image) => image.url))) {
        clearDraft(revision);
        onImages((current) => current.filter((image) => !images.some((sent) => sent.id === image.id)));
        clearImageError();
      }
    } finally { sendingRef.current = false; if (mounted.current) setSending(false); }
  }
  const stop = active && !draft.trim() && !images.length && !reading;
  const actionLabel = stop ? "Interrupt response" : active ? "Send follow-up" : "Send message";
  return <form className="composer" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); void addFiles(files); } }} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <input ref={picker} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Choose images" className="sr-only" disabled={sending || reading} onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    {images.length > 0 && <div className="flex flex-wrap gap-3 p-3" aria-label="Attached images">{images.map((image) => <figure key={image.id} className="w-24"><img src={image.url} alt={image.name} className="h-20 w-24 rounded-lg border border-line object-contain" /><figcaption className="truncate text-xs text-muted">{image.name}</figcaption><button type="button" className="text-xs underline" aria-label={`Remove ${image.name}`} disabled={sending || reading} onClick={() => onImages((current) => current.filter((item) => item.id !== image.id))}>Remove</button></figure>)}</div>}
    {imageError && <p role="alert" className="notice m-3">{imageError}</p>}
    {reading && <p role="status" className="px-3 text-xs text-muted">Reading images…</p>}
    <textarea ref={textarea} aria-label="Message Shepherd" aria-describedby="composer-help" placeholder={active ? "Add a follow-up…" : "Message Shepherd…"}
      onPaste={pasteImages}
      value={draft} onChange={(event) => onDraft(event.target.value)} maxLength={32768} rows={1} disabled={sending}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
          event.preventDefault(); void submit();
        }
      }} />
    <span id="composer-help" className="sr-only">Enter to send on a keyboard. Shift + Enter for a new line. Follow-ups steer the active turn.</span>
    <div className="composer-toolbar">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className="icon-button attach-button" aria-label="Attach images" title="Attach images (PNG, JPEG, GIF, WebP)" disabled={sending || reading || images.length >= 4} onClick={() => picker.current?.click()}><Icon name="image" className="size-5!" /></button>
        {(disabled || active) && <span className="truncate text-xs text-dim">{disabled ? "Waiting for connection" : "Follow-up"}</span>}
      </div>
      <div className="flex items-center gap-2">
        <button type={stop ? "button" : "submit"} className={`send-button${stop ? " stop-button" : ""}`} aria-label={actionLabel} title={actionLabel}
          disabled={disabled || busy || sending || reading || (!stop && !draft.trim() && !images.length)} onClick={stop ? interrupt : undefined}><Icon name={stop ? "stop" : "arrow"} /></button>
      </div>
    </div>
  </form>;
}
