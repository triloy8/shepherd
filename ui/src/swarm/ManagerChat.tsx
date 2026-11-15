import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { WebConversation } from "../../../shared/protocol/web";
import { useConversation, type Connection } from "../use-conversation";
import type { useImageDrafts } from "../use-image-drafts";
import { Timeline } from "../components/Timeline";
import { Composer } from "../components/Composer";
import { Approvals } from "../components/Approvals";
import { ConversationControls } from "../components/ConversationControls";
import { ManagerMenu } from "./ManagerMenu";
import { Identity } from "./Identity";
import { useChatScroll } from "./use-chat-scroll";

export type ManagerConnection = { id: string; connection: Connection };
export type Drafts = Map<string, { text: string; revision: number }>;
export function ManagerChat({ conversation, drafts, imageDrafts, menuTarget, onConnectionChange }: { conversation: WebConversation; drafts: RefObject<Drafts>; imageDrafts: ReturnType<typeof useImageDrafts>; menuTarget: HTMLDivElement | null; onConnectionChange: (value: ManagerConnection) => void }) {
  const controller = useConversation(conversation);
  useEffect(() => { onConnectionChange({ id: conversation.id, connection: controller.connection }); }, [conversation.id, controller.connection, onConnectionChange]);
  const [, redraw] = useState(0);
  const id = conversation.threadId;
  const draft = drafts.current.get(id) ?? { text: "", revision: 0 };
  const updateDraft = (text: string) => { const previous = drafts.current.get(id); drafts.current.set(id, { text, revision: (previous?.revision ?? 0) + 1 }); redraw(n => n + 1); };
  const { scroller, content, chat, composeZone, latest, jumpToLatest, onScroll, stopFollowing } = useChatScroll(controller.chat.messages);
  const error = controller.error ?? controller.chat.error;
  const active = Boolean(controller.chat.activeTurnId);
  const imageSupported = controller.capabilities?.inputKinds.includes("image") === true && (controller.modelCapabilities?.inputModalities == null || controller.modelCapabilities.inputModalities.includes("image"));
  return <div ref={chat} className="swarm-chat">
    {menuTarget && createPortal(<ManagerMenu conversation={conversation} capabilities={controller.capabilities} disabled={controller.connection !== "online" || controller.busy} active={active || controller.approvals.length > 0} onHistoryChange={controller.recoverHistory} />, menuTarget)}
    <div className="swarm-connection sr-only" role="status">{controller.connection === "online" ? active ? "Manager working" : "Manager connected" : controller.connection === "detached" ? "Resume this conversation after a host restart" : "Connecting to manager…"}</div>
    <div className="swarm-reading-area"><div ref={scroller} className="chat-scroll swarm-chat-scroll" onScroll={onScroll}><div ref={content} className="chat-content swarm-chat-content">
      {controller.historyCursor && <button className="alloy-button older-messages" disabled={controller.loadingHistory} onClick={() => { stopFollowing(); void controller.loadOlder(); }}>{controller.loadingHistory ? "Loading…" : "Load earlier messages"}</button>}
      {!controller.chat.messages.length && <div className="swarm-chat-empty"><Identity kind="manager" large /><h2>What shall we work on?</h2><p>Describe the task. Your manager will discuss a team with you.</p></div>}
      <Timeline chat={controller.chat} waitingForAnswer={controller.approvals.some(a => a.userInput?.isBlocking)} onReload={controller.recoverHistory} />
    </div></div>
      {latest && <button className="alloy-button latest-messages" onClick={jumpToLatest}>Latest messages ↓</button>}
    </div>
    <div ref={composeZone} className="swarm-compose-zone composer-dock">
      {error && <p className="notice" role="alert">{error}</p>}
      <Approvals approvals={controller.approvals} busy={controller.busy} decide={controller.decide} />
      <Composer placeholder="Message…" sendIcon="arrowRight" draft={draft.text} draftRevision={draft.revision} onDraft={updateDraft}
        clearDraft={revision => { if (drafts.current.get(id)?.revision === revision) updateDraft(""); }}
        images={imageDrafts.images[id] ?? []} onImages={change => imageDrafts.update(id, change)} reading={imageDrafts.reading[id] ?? false}
        imageError={imageDrafts.errors[id] ?? null} addFiles={files => imageDrafts.addFiles(id, files)} clearImageError={() => imageDrafts.clearError(id)}
        imageSupported={imageSupported} disabled={controller.connection !== "online"} busy={controller.busy} active={active}
        steerSupported={controller.capabilities?.steer === true} interruptSupported={controller.capabilities?.interrupt === true}
        interrupt={() => void controller.interrupt()} send={controller.send} />
      <ConversationControls conversation={conversation} capabilities={controller.capabilities} activeTurnId={controller.chat.activeTurnId} disabled={controller.connection !== "online" || controller.busy} active={active || controller.approvals.length > 0} draft={draft.text} onHistoryChange={controller.recoverHistory} />
    </div>
  </div>;
}
