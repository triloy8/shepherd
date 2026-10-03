import { useState } from "react";
import { RevertDialog } from "./RevertDialog";
import type { ChatMessage, ChatState } from "../chat-state";
import { timelineGroups } from "../timeline";
import { ImageArtifact } from "./ImageArtifact";
import { Message } from "./Message";

export function Timeline({ chat, revertDisabled = true, onRevert, onReload }: { chat: ChatState; revertDisabled?: boolean; onRevert?: (turnId: string) => Promise<void>; onReload?: () => Promise<void> }) {
  const [target, setTarget] = useState<ChatMessage | null>(null);
  const images = chat.messages.flatMap((message) => message.image ? [message.image] : []);
  return <><div className="space-y-8">{timelineGroups(chat).map((group) => {
    if (group.messages[0]!.image && group.messages[0]!.image!.kind !== "viewed") return <ImageArtifact key={group.id} image={group.messages[0]!.image!} />;
    if (group.messages[0]!.role === "user") return <Message key={group.id} message={group.messages[0]!} revertDisabled={revertDisabled} onRevert={onRevert ? () => setTarget(group.messages[0]!) : undefined} />;
    const progress = group.messages.filter((message) => !group.finalIds.includes(message.id));
    const finals = group.messages.filter((message) => group.finalIds.includes(message.id));
    const failures = progress.filter((message) => message.activity?.status === "failed").length;
    const updates = <div className="space-y-4 border-l border-line pl-4 text-muted">{progress.map((message) => message.image ? <details key={message.id} className="viewed-image-disclosure text-xs text-muted">
      <summary className="cursor-pointer">Viewed image{message.image.name ? ` · ${message.image.name}` : ""}</summary>
      <div className="mt-3"><ImageArtifact image={message.image} /></div>
    </details> : message.activity ? <details key={message.id} className={message.activity.status === "failed" ? "notice" : "text-xs text-muted"}>
      <summary className="cursor-pointer">{message.activity.label} · {message.activity.status === "started" && chat.turns[message.turnId]?.status && chat.turns[message.turnId]?.status !== "inProgress" ? "Stopped" : message.activity.status === "started" ? "Running" : message.activity.status === "failed" ? "Failed" : "Done"}</summary>
      {message.activity.detail && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{message.activity.detail.slice(0, 16384)}</pre>}
    </details> : <Message key={message.id} message={message} images={images} progress showCopy={false} />)}</div>;
    return <section key={group.id} className="space-y-5" aria-label="Assistant turn">
      {progress.length > 0 && (group.settled ?
        <details className="progress-disclosure"><summary className="cursor-pointer text-xs text-muted hover:text-ink">{group.label}{failures > 0 && <span className="text-amber-400"> · {failures} failed {failures === 1 ? "step" : "steps"}</span>}</summary><div className="mt-4">{updates}</div></details> :
        <div><p className="mb-3 text-xs text-muted">{group.label}</p>{updates}</div>)}
      {finals.map((message) => <Message key={message.id} message={message} images={images} showCopy={group.settled} />)}
    </section>;
  })}</div>{onRevert && onReload && <RevertDialog target={target} disabled={revertDisabled}
    available={!!target && chat.messages.some((message) => message.id === target.id && message.turnId === target.turnId)}
    onClose={() => setTarget(null)} revert={onRevert} reload={onReload} />}</>;
}
