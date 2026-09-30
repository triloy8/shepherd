import { imageDataParts } from "../../../shared/protocol/image_input";
import { memo, useState } from "react";
import Markdown from "react-markdown";
import type { ChatMessage } from "../chat-state";
import { Icon } from "./Icon";

const AttachedImage = memo(function AttachedImage({ url, index }: { url: string; index: number }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url || !imageDataParts(url)) return <p className="text-xs text-muted">Image attachment unavailable.</p>;
  return <img src={url} alt={`Attached image ${index + 1}`} loading="lazy" onError={() => setFailedUrl(url)} className="mb-3 max-h-96 max-w-full rounded-lg border border-line object-contain" />;
});

export function Message({ message, progress = false, showCopy = true, onRevert, revertDisabled = false }: { message: ChatMessage; progress?: boolean; showCopy?: boolean; onRevert?: () => void; revertDisabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return <article className={`message ${message.role === "user" ? "message-user" : "message-assistant"}`}>
    {!progress && <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted">
      {message.role === "user" && <span className="flex size-6 items-center justify-center rounded-full bg-raised text-[10px] text-ink">Y</span>}
      <span>{message.role === "user" ? "You" : "Shepherd"}</span>
      {!message.complete && <span className="ml-1 text-dim">Writing…</span>}
    </div>}
    {message.role === "user" && message.attachments?.map((url, index) => <AttachedImage key={index} url={url} index={index} />)}
    {message.role === "user" ? <div className="whitespace-pre-wrap break-words text-[15px] leading-7">{message.text}</div>
      : <div className="prose-chat"><Markdown components={{
        // Agent text is untrusted: no raw HTML, remote image fetches or active embeds.
        img: ({ alt }) => <span className="text-muted">[Image: {alt || "attachment"}]</span>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      }}>{message.text}</Markdown></div>}
    {!progress && <div className="mt-3 flex flex-wrap items-center gap-4">
      {showCopy && message.complete && message.text && <button className="flex items-center gap-1.5 text-xs text-dim hover:text-ink" aria-label={message.role === "user" ? "Copy message" : "Copy response"} onClick={() => {
        void navigator.clipboard.writeText(message.text).then(() => { setCopied(true); setCopyError(false); }, () => setCopyError(true));
      }}><Icon name={copied ? "check" : "copy"} className="size-3.5" />{copyError ? "Could not copy" : copied ? "Copied" : "Copy"}</button>}
      {onRevert && message.role === "user" && message.complete && message.turnId && !message.id.startsWith("local:") && <button className="flex items-center gap-1.5 text-xs text-dim hover:text-ink disabled:opacity-50" disabled={revertDisabled} onClick={onRevert}><Icon name="revert" className="size-3.5" />Revert from here</button>}
    </div>}

  </article>;
}
