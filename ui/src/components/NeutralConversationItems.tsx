import type { BoundedText, ConversationItem } from "../../../shared/protocol/v2/conversation_items.js";

function Text({ value }: { value: BoundedText | null }) {
  if (!value) return null;
  return <><pre className="whitespace-pre-wrap break-words">{value.text}</pre>{value.truncated && <p className="text-sm text-muted">Preview shortened.</p>}</>;
}
/** One renderer for projected history and live items. Mounted on v2 client cutover. */
export function NeutralConversationItems({ items, assetUrl }: { items: ConversationItem[]; assetUrl: (id: string) => string }) {
  return <div className="space-y-3">{items.map(item => <article key={item.id} data-item-id={item.id} data-status={item.status} className="rounded-lg border border-line p-3">
    {item.type === "user_message" && item.content.map((part, index) => part.type === "text" ? <Text key={index} value={part.text} />
      : part.type === "asset" ? <a key={index} href={assetUrl(part.assetId)}>Open {part.media}</a> : <span key={index}>{part.name}</span>)}
    {item.type === "assistant_message" && <Text value={item.text} />}
    {item.type === "reasoning" && item.summary.map((summary, index) => <Text key={index} value={summary} />)}
    {item.type === "command" && <><Text value={item.command} /><Text value={item.output} /></>}
    {item.type === "tool" && <><strong>{item.name}</strong><Text value={item.input} /><Text value={item.output} /></>}
    {item.type === "file_change" && item.changes.map((change, index) => <div key={index}><strong>{change.path}</strong><Text value={change.diff} /></div>)}
    {(item.type === "file_read" || item.type === "search" || item.type === "web") && <Text value={item.output} />}
    {item.type === "plan" && <><Text value={item.text} />{item.steps.map((step, index) => <div key={index}>{step.status}: {step.text.text}</div>)}</>}
    {item.type === "subagent" && <><Text value={item.description} /><Text value={item.report} /></>}
    {item.type === "notice" && <Text value={item.text} />}
    {item.type === "image" && (item.asset.availability === "available" ? <a href={assetUrl(item.asset.id)}>Open image</a> : <p>Image unavailable.</p>)}
    {item.error && <Text value={item.error} />}
    {item.detailAsset && (item.detailAsset.availability === "available" ? <a href={assetUrl(item.detailAsset.id)}>Download full text or details</a> : <p>Full details unavailable.</p>)}
    {item.recovery !== "complete" && <p className="text-sm text-muted">{item.recovery === "transient" ? "Available in this session only." : "Some details are unavailable."}</p>}
  </article>)}</div>;
}
