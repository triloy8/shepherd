import { useState } from "react";
import { MessageMarkdown } from "./Message";
import { RevertDialog } from "./RevertDialog";
import type { BoundedText, ConversationItem } from "../../../shared/protocol/v2/conversation_items.js";

function CopyText({ text }: { text: string }) {
  const [status, setStatus] = useState("Copy response");
  return <button className="button-secondary mt-2" onClick={() => { void navigator.clipboard.writeText(text).then(() => setStatus("Copied"), () => setStatus("Could not copy")); }}>{status}</button>;
}

function Text({ value }: { value: BoundedText | null }) {
  if (!value) return null;
  return <><pre className="whitespace-pre-wrap break-words">{value.text}</pre>{value.truncated && <p className="text-sm text-muted">Preview shortened.</p>}</>;
}
/** The default renderer uses one shared item model for history and live work. */
export function NeutralConversationItems({ items, assetUrl, onRevert, onReload, revertDisabled = true }: { items: ConversationItem[]; assetUrl: (id: string) => string; onRevert?: (turnId: string) => Promise<void>; onReload?: () => Promise<void>; revertDisabled?: boolean }) {
  const [target, setTarget] = useState<{ id: string; turnId: string; text: string } | null>(null);
  return <><div className="space-y-3">{items.map(item => <article key={item.id} data-item-id={item.id} data-status={item.status} className="rounded-lg border border-line p-3">
    <div className="mb-2 text-xs text-muted">{item.type === "user_message" ? "You" : item.type === "assistant_message" ? "Shepherd" : item.type.replaceAll("_", " ")}{item.status === "in_progress" ? " · Working" : item.status === "failed" ? " · Failed" : item.status === "interrupted" ? " · Interrupted" : ""}</div>
    {item.type === "user_message" && onRevert && <button className="button-secondary float-right" disabled={revertDisabled} onClick={() => setTarget({ id: item.id, turnId: item.turnId, text: item.content.filter(part => part.type === "text").map(part => part.text.text).join("\n") })}>Revert from here</button>}
    {item.type === "user_message" && item.content.map((part, index) => part.type === "text" ? <Text key={index} value={part.text} />
      : part.type === "asset" ? <a key={index} href={assetUrl(part.assetId)}>{part.media === "image" ? <img className="max-h-80 rounded-lg" src={assetUrl(part.assetId)} alt="Attached image" /> : "Open audio"}</a> : <span key={index}>{part.name}</span>)}
    {item.type === "assistant_message" && <><MessageMarkdown text={item.text.text} images={[]} prefix={`neutral-${item.id}`} />{item.status !== "in_progress" && item.text.text && <CopyText text={item.text.text} />}{item.text.truncated && <p className="text-sm text-muted">Preview shortened.</p>}</>}
    {item.type === "reasoning" && item.summary.map((summary, index) => <Text key={index} value={summary} />)}
    {item.type === "command" && <><Text value={item.command} />{item.cwd && <p className="text-xs text-muted">Working directory: {item.cwd}</p>}<Text value={item.output} />{item.exitCode !== null && <p className="text-xs text-muted">Exit code: {item.exitCode}</p>}</>}
    {item.type === "tool" && <><strong>{item.name}</strong><Text value={item.input} /><Text value={item.output} /></>}
    {item.type === "file_change" && item.changes.map((change, index) => <div key={index}><strong>{change.path}</strong><Text value={change.diff} /></div>)}
    {item.type === "file_read" && <>{item.reads.map((read, index) => <p key={index} className="text-xs text-muted">{read.path}</p>)}<Text value={item.output} /></>}
    {item.type === "search" && <>{item.queries.map((query, index) => <Text key={index} value={query} />)}<p className="text-xs text-muted">{item.paths.join(", ")}</p><Text value={item.output} /></>}
    {item.type === "web" && <>{item.queries.map((query, index) => <Text key={index} value={query} />)}{item.url && <p className="text-xs text-muted">{item.url}</p>}<Text value={item.output} /></>}
    {item.type === "plan" && <><Text value={item.text} />{item.steps.map((step, index) => <div key={index}>{step.status}: {step.text.text}</div>)}</>}
    {item.type === "subagent" && <><Text value={item.description} /><Text value={item.report} /></>}
    {item.type === "notice" && <Text value={item.text} />}
    {item.type === "image" && (item.asset.availability === "available" ? <a href={assetUrl(item.asset.id)}><img className="max-h-96 rounded-lg" src={assetUrl(item.asset.id)} alt={item.prompt?.text ?? "Agent image"} /></a> : <p>Image unavailable.</p>)}
    {item.error && <Text value={item.error} />}
    {item.detailAsset && (item.detailAsset.availability === "available" ? <a href={assetUrl(item.detailAsset.id)}>Download full text or details</a> : <p>Full details unavailable.</p>)}
    {Object.entries(item.omitted).map(([field, count]) => <p key={field} className="text-sm text-muted">{count} more {field.replaceAll("_", " ")} omitted.</p>)}
    {item.recovery !== "complete" && <p className="text-sm text-muted">{item.recovery === "transient" ? "Available in this session only." : "Some details are unavailable."}</p>}
  </article>)}</div>{onRevert && onReload && <RevertDialog target={target} disabled={revertDisabled} available={!!target && items.some(item => item.id === target.id && item.turnId === target.turnId)} onClose={() => setTarget(null)} revert={onRevert} reload={onReload} />}</>;
}
