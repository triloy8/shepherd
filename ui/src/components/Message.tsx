import { useState } from "react";
import Markdown from "react-markdown";
import type { ChatMessage } from "../chat-state";
import { Icon } from "./Icon";

export function Message({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return <article className={`message ${message.role === "user" ? "message-user" : "message-assistant"}`}>
    <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted">
      {message.role === "user" && <span className="flex size-6 items-center justify-center rounded-full bg-raised text-[10px] text-ink">Y</span>}
      <span>{message.role === "user" ? "You" : "Shepherd"}</span>
      {!message.complete && <span className="ml-1 text-dim">Writing…</span>}
    </div>
    {message.role === "user" ? <div className="whitespace-pre-wrap break-words text-[15px] leading-7">{message.text}</div>
      : <div className="prose-chat"><Markdown components={{
        // Agent text is untrusted: no raw HTML, remote image fetches or active embeds.
        img: ({ alt }) => <span className="text-muted">[Image: {alt || "attachment"}]</span>,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      }}>{message.text}</Markdown></div>}
    {message.complete && message.role === "assistant" && <button className="mt-3 flex items-center gap-1.5 text-xs text-dim hover:text-ink" aria-label="Copy response" onClick={() => {
      void navigator.clipboard.writeText(message.text).then(() => { setCopied(true); setCopyError(false); }, () => setCopyError(true));
    }}><Icon name={copied ? "check" : "copy"} className="size-3.5" />{copyError ? "Could not copy" : copied ? "Copied" : "Copy"}</button>}
  </article>;
}
