import { memo, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { WebImage } from "../../../shared/protocol/web";
import { RevertDialog } from "./RevertDialog";
import { messageKey, type ActivityStep as Step, type ChatMessage, type ChatState } from "../chat-state";
import { timelineGroups, type TimelineGroup } from "../timeline";
import { ImageArtifact } from "./ImageArtifact";
import { Message } from "./Message";
import { describeActivity } from "../../../shared/protocol/activity";

export function Timeline({ chat, waitingForAnswer = false, revertDisabled = true, onRevert, onReload }: { chat: ChatState; waitingForAnswer?: boolean; revertDisabled?: boolean; onRevert?: (turnId: string) => Promise<void>; onReload?: () => Promise<void> }) {
  const [target, setTarget] = useState<ChatMessage | null>(null);
  const images = useMemo(() => chat.messages.flatMap((message) => message.image ? [message.image] : []), [chat.messages]);
  const groups = useMemo(() => timelineGroups(chat), [chat.messages, chat.turns, chat.activeTurnId]);
  // Each group gets only its own steps' subagent rows, so a subagent update re-renders one group.
  const subagentRows = useMemo(() => {
    const rows = new Map<string, ChatMessage[]>();
    // Item IDs are unique within a turn, so a parent is its turn and ID together.
    const key = (turnId: string, id: string) => JSON.stringify([turnId, id]);
    for (const message of chat.messages) if (message.parentId) rows.set(key(message.turnId, message.parentId), [...rows.get(key(message.turnId, message.parentId)) ?? [], message]);
    return groups.map((group) => group.messages.flatMap((message) => rows.get(key(message.turnId, message.id)) ?? []));
  }, [chat.messages, groups]);
  return <><div className="space-y-8">{groups.map((group, index) => <TimelineGroupView key={messageKey(group.messages[0]!)} group={group} subagentRows={subagentRows[index]!} images={images}
    waiting={waitingForAnswer && group.messages[0]!.turnId === chat.activeTurnId} turnStatus={chat.turns[group.messages[0]!.turnId]?.status} revertDisabled={revertDisabled} canRevert={!!onRevert} setTarget={setTarget} />)}</div>{onRevert && onReload && <RevertDialog target={target} disabled={revertDisabled}
    available={!!target && chat.messages.some((message) => message.id === target.id && message.turnId === target.turnId)}
    onClose={() => setTarget(null)} revert={onRevert} reload={onReload} />}</>;
}

const TimelineGroupView = memo(function TimelineGroupView({ group, subagentRows, images, waiting, turnStatus, revertDisabled, canRevert, setTarget }: {
  group: TimelineGroup; subagentRows: readonly ChatMessage[]; images: readonly WebImage[]; waiting: boolean; turnStatus?: string; revertDisabled: boolean; canRevert: boolean;
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
    </DeferredDetails> : message.activity ? <ActivityStep key={message.id} step={message.activity} turnStatus={turnStatus}>
      {subagentRows.some((row) => row.parentId === message.id && row.turnId === message.turnId) && <SubagentRows rows={subagentRows.filter((row) => row.parentId === message.id && row.turnId === message.turnId)} images={images} turnStatus={turnStatus} />}
    </ActivityStep> : <Message key={message.id} message={message} images={images} writingPaused={waiting} progress showCopy={false} />)}</div>;
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
  previous.subagentRows.length === next.subagentRows.length && previous.subagentRows.every((message, index) => message === next.subagentRows[index]) &&
  previous.images.length === next.images.length && previous.images.every((image, index) => image === next.images[index]));

function DeferredDetails({ summary, children, className = "progress-disclosure" }: { summary: ReactNode; children: ReactNode; className?: string }) {
  const [opened, setOpened] = useState(false);
  return <details className={className} onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary className="cursor-pointer text-xs text-muted hover:text-ink">{summary}</summary>
    {opened && <div className="mt-4">{children}</div>}
  </details>;
}

/** A subagent's own work, shown inside the step that delegated it. */
function SubagentRows({ rows, images, turnStatus }: { rows: readonly ChatMessage[]; images: readonly WebImage[]; turnStatus?: string }) {
  return <div className="subagent-rows mt-3 space-y-3 border-l border-line pl-4" aria-label="Subagent work">
    {rows.map((message) => message.image ? <ImageArtifact key={message.id} image={message.image} eager /> :
      message.activity ? <ActivityStep key={message.id} step={message.activity} turnStatus={turnStatus} /> :
      <Message key={message.id} message={message} images={images} progress showCopy={false} />)}
  </div>;
}

function ActivityStep({ step, turnStatus, children }: { step: Step; turnStatus?: string; children?: ReactNode }) {
  const { title, detail } = describeActivity(step.activity);
  const state = step.status === "started" && turnStatus && turnStatus !== "in_progress" ? "Stopped" : step.status === "started" ? "Running" : step.status === "failed" ? "Failed" : "Done";
  return <details className={step.status === "failed" ? "notice" : "text-xs text-muted"}>
    <summary className="cursor-pointer">{title} · {state}</summary>
    {detail && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">{detail.slice(0, 16384)}</pre>}
    {children}
  </details>;
}
