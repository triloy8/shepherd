import { memo, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { WebImage } from "../../../shared/protocol/web";
import { RevertDialog } from "./RevertDialog";
import type { ChatMessage, ChatState } from "../chat-state";
import { timelineGroups, type TimelineGroup } from "../timeline";
import { ImageArtifact } from "./ImageArtifact";
import { Message } from "./Message";

export function Timeline({ chat, waitingForAnswer = false, revertDisabled = true, onRevert, onReload }: { chat: ChatState; waitingForAnswer?: boolean; revertDisabled?: boolean; onRevert?: (turnId: string) => Promise<void>; onReload?: () => Promise<void> }) {
  const [target, setTarget] = useState<ChatMessage | null>(null);
  const images = useMemo(() => chat.messages.flatMap((message) => message.image ? [message.image] : []), [chat.messages]);
  const groups = useMemo(() => timelineGroups(chat), [chat.messages, chat.turns, chat.activeTurnId]);
  return <><div className="space-y-8">{groups.map((group) => <TimelineGroupView key={group.id} group={group} images={images}
    waiting={waitingForAnswer && group.messages[0]!.turnId === chat.activeTurnId} turnStatus={chat.turns[group.messages[0]!.turnId]?.status} revertDisabled={revertDisabled} canRevert={!!onRevert} setTarget={setTarget} />)}</div>{onRevert && onReload && <RevertDialog target={target} disabled={revertDisabled}
    available={!!target && chat.messages.some((message) => message.id === target.id && message.turnId === target.turnId)}
    onClose={() => setTarget(null)} revert={onRevert} reload={onReload} />}</>;
}

const TimelineGroupView = memo(function TimelineGroupView({ group, images, waiting, turnStatus, revertDisabled, canRevert, setTarget }: {
  group: TimelineGroup; images: readonly WebImage[]; waiting: boolean; turnStatus?: string; revertDisabled: boolean; canRevert: boolean;
  setTarget: Dispatch<SetStateAction<ChatMessage | null>>;
}) {
    if (group.messages[0]!.role === "user") return <Message message={group.messages[0]!} revertDisabled={revertDisabled} onRevert={canRevert ? () => setTarget(group.messages[0]!) : undefined} />;
    const finalIds = new Set(group.finalIds);
    const progress = group.messages.filter((message) => !finalIds.has(message.id));
    const finals = group.messages.filter((message) => finalIds.has(message.id));
    const hasGeneratedImage = finals.some((message) => message.image);
    const failures = progress.filter((message) => message.activity?.status === "failed").length;
    const updates = <div className="space-y-4 border-l border-line pl-4 text-muted">{progress.map((message) => message.image ? <DeferredDetails key={message.id} className="viewed-image-disclosure text-xs text-muted"
      summary={<>Viewed image{message.image.name ? ` · ${message.image.name}` : ""}</>}>
      <ImageArtifact image={message.image} eager />
    </DeferredDetails> : message.activity ? <details key={message.id} className={message.activity.status === "failed" ? "notice" : "text-xs text-muted"}>
      <summary className="cursor-pointer">{message.activity.label} · {message.activity.status === "started" && turnStatus && turnStatus !== "in_progress" ? "Stopped" : message.activity.status === "started" ? "Running" : message.activity.status === "failed" ? "Failed" : "Done"}</summary>
      {message.activity.detail && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{message.activity.detail.slice(0, 16384)}</pre>}
    </details> : <Message key={message.id} message={message} images={images} writingPaused={waiting} progress showCopy={false} />)}</div>;
    return <section className="timeline-entry space-y-5" aria-label="Assistant turn">
      {progress.length > 0 && (group.settled ?
        <DeferredDetails summary={<>{group.label}{failures > 0 && <span className="text-amber-400"> · {failures} failed {failures === 1 ? "step" : "steps"}</span>}</>} >{updates}</DeferredDetails> :
        <div><p className="mb-3 text-xs text-muted">{waiting ? "Waiting for your answer…" : group.label}</p>{updates}</div>)}
      {finals.length > 0 && <div className="assistant-response space-y-5">
        {hasGeneratedImage && <div className="text-xs font-medium text-muted">Shepherd</div>}
        {finals.map((message) => message.image ? <ImageArtifact key={message.id} image={message.image} collapsePrompt /> : <Message key={message.id} message={message} images={images} writingPaused={waiting} showAuthor={!hasGeneratedImage} showCopy={group.settled} />)}
      </div>}
    </section>;
}, (previous, next) => previous.waiting === next.waiting && previous.turnStatus === next.turnStatus && previous.revertDisabled === next.revertDisabled && previous.canRevert === next.canRevert &&
  previous.group.settled === next.group.settled && previous.group.label === next.group.label &&
  previous.group.finalIds.length === next.group.finalIds.length && previous.group.finalIds.every((id, index) => id === next.group.finalIds[index]) &&
  previous.group.messages.length === next.group.messages.length && previous.group.messages.every((message, index) => message === next.group.messages[index]) &&
  previous.images.length === next.images.length && previous.images.every((image, index) => image === next.images[index]));

function DeferredDetails({ summary, children, className = "progress-disclosure" }: { summary: ReactNode; children: ReactNode; className?: string }) {
  const [opened, setOpened] = useState(false);
  return <details className={className} onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary className="cursor-pointer text-xs text-muted hover:text-ink">{summary}</summary>
    {opened && <div className="mt-4">{children}</div>}
  </details>;
}
