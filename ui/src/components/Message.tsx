import { imageDataParts } from "../../../shared/protocol/image_input";
import { createContext, isValidElement, memo, useDeferredValue, useContext, useId, useState, type MouseEvent, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkChatMath from "../remark-chat-math";
import rehypeKatex from "rehype-katex";
import type { ChatMessage } from "../chat-state";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import { Icon } from "./Icon";
import type { WebImage } from "../../../shared/protocol/web";
import { resolveImageArtifact } from "../image-artifacts";
import { ImageArtifact } from "./ImageArtifact";

// Keep renderer identities stable so updates preserve loaded image elements.
const MessageImages = createContext<readonly WebImage[]>([]);
const FootnotePrefix = createContext("");

function navigateFootnote(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.currentTarget;
  const message = link.closest(".message, .draft-preview");
  const scroll = link.closest<HTMLElement>(".chat-scroll, .draft-preview");
  const href = link.getAttribute("href");
  if (!scroll || !href?.startsWith("#")) return;
  const target = link.ownerDocument.getElementById(decodeURIComponent(href.slice(1)));
  if (!target || !message?.contains(target)) return;
  // Native fragment navigation also scrolls ancestors of the chat, displacing
  // the fixed header/composer on mobile. Move only the conversation viewport.
  event.preventDefault();
  scroll.scrollTo({ top: scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16 });
  if (!target.matches("a[href], [tabindex]")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

const markdownComponents: Components = {
  pre: function MarkdownCodeBlock({ children }) {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>;
    const language = /(?:^|\s)language-([^\s]+)/.exec(children.props.className ?? "")?.[1] ?? "";
    const code = String(children.props.children ?? "").replace(/\n$/, "");
    return language.toLowerCase() === "mermaid" ? <MermaidBlock code={code} /> : <CodeBlock code={code} language={language} />;
  },
  h2: function MarkdownHeading({ id, node: _node, ...props }) {
    const prefix = useContext(FootnotePrefix);
    return <h2 {...props} id={id === "footnote-label" ? `${prefix}footnote-label` : id} />;
  },
  table: function MarkdownTable({ children, ...props }) {
    const { node: _node, ...tableProps } = props;
    return <div className="table-scroll" role="region" aria-label="Table" tabIndex={0}><table {...tableProps}>{children}</table></div>;
  },
  img: function MarkdownImage({ src, alt }) {
    const images = useContext(MessageImages);
    // Only registered conversation artifacts may turn Markdown into image requests.
    const image = resolveImageArtifact(typeof src === "string" ? src : undefined, images);
    return image ? <ImageArtifact key={image.url} image={image} inline alt={alt} /> : <span className="text-muted">[Image: {alt || "attachment"}]</span>;
  },
  a: function MarkdownLink({ href, children, node, ...props }) {
    const images = useContext(MessageImages);
    const prefix = useContext(FootnotePrefix);
    const footnote = node?.properties.dataFootnoteRef !== undefined || node?.properties.dataFootnoteBackref !== undefined;
    return <a {...props} aria-describedby={props["aria-describedby"] === "footnote-label" ? `${prefix}footnote-label` : props["aria-describedby"]}
      href={resolveImageArtifact(href, images)?.url ?? href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer"
      onClick={footnote ? navigateFootnote : undefined}>{children}</a>;
  },
};

const emptyImages: readonly WebImage[] = [];
// History snapshots recreate objects. Compare text and artifact metadata so
// unchanged Markdown stays cached while new image references still resolve.
export const MessageMarkdown = memo(function MessageMarkdown({ text, images, prefix }: { text: string; images: readonly WebImage[]; prefix: string }) {
  return <MessageImages.Provider value={images}><FootnotePrefix.Provider value={prefix}><div className="prose-chat"><Markdown remarkPlugins={[remarkGfm, remarkChatMath]} rehypePlugins={[rehypeKatex]}
    remarkRehypeOptions={{ clobberPrefix: prefix, footnoteBackContent: "↩\uFE0E" }} components={markdownComponents}>{text}</Markdown></div></FootnotePrefix.Provider></MessageImages.Provider>;
}, (previous, next) => previous.text === next.text && previous.prefix === next.prefix &&
  previous.images.length === next.images.length && previous.images.every((image, index) => {
    const other = next.images[index]!;
    return image === other || (image.url === other.url && image.path === other.path && image.name === other.name && image.prompt === other.prompt && image.kind === other.kind);
  }));

const AttachedImage = memo(function AttachedImage({ url, index }: { url: string; index: number }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === url || !imageDataParts(url)) return <p className="text-xs text-muted">Image attachment unavailable.</p>;
  return <img src={url} alt={`Attached image ${index + 1}`} loading="lazy" onError={() => setFailedUrl(url)} className="mb-3 max-h-96 max-w-full rounded-lg border border-line object-contain" />;
});

export function Message({ message, images = emptyImages, progress = false, showAuthor = true, showCopy = true, writingPaused = false, onRevert, revertDisabled = false }: { message: ChatMessage; images?: readonly WebImage[]; progress?: boolean; showAuthor?: boolean; showCopy?: boolean; writingPaused?: boolean; onRevert?: () => void; revertDisabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const footnotePrefix = `message-${useId()}-`;
  const renderedText = useDeferredValue(message.text);
  return <article className={`message timeline-entry ${message.role === "user" ? "message-user" : "message-assistant"}`}>
    {!progress && showAuthor && <div className="mb-3 flex items-center gap-2 text-xs font-medium text-muted">
      {message.role === "user" && <span className="flex size-6 items-center justify-center rounded-full bg-raised text-[10px] text-ink">Y</span>}
      <span>{message.role === "user" ? "You" : "Shepherd"}</span>
      {!message.complete && !writingPaused && <span className="ml-1 text-dim">Writing…</span>}
    </div>}
    {message.role === "user" && message.attachments?.map((url, index) => <AttachedImage key={index} url={url} index={index} />)}
    {message.role === "user" ? <div className="whitespace-pre-wrap break-words text-[15px] leading-7">{message.text}</div>
      : <MessageMarkdown text={renderedText} images={images} prefix={footnotePrefix} />}
    {!progress && <div className="mt-3 flex flex-wrap items-center gap-4">
      {showCopy && message.complete && message.text && <button className="flex items-center gap-1.5 text-xs text-dim hover:text-ink" aria-label={message.role === "user" ? "Copy message" : "Copy response"} onClick={() => {
        void navigator.clipboard.writeText(message.text).then(() => { setCopied(true); setCopyError(false); }, () => setCopyError(true));
      }}><Icon name={copied ? "check" : "copy"} className="size-3.5" />{copyError ? "Could not copy" : copied ? "Copied" : "Copy"}</button>}
      {onRevert && message.role === "user" && message.complete && message.turnId && !message.id.startsWith("local:") && <button className="flex items-center gap-1.5 text-xs text-dim hover:text-ink disabled:opacity-50" disabled={revertDisabled} onClick={onRevert}><Icon name="revert" className="size-3.5" />Revert from here</button>}
    </div>}

  </article>;
}
