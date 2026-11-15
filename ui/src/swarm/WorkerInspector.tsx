import type { SwarmMember } from "../../../shared/protocol/swarm";
import type { SurfaceConversation } from "../../../shared/protocol/conversation";
import { useConversation } from "../use-conversation";
import { Timeline } from "../components/Timeline";
import { Identity } from "./Identity";
import { SwarmDialog as Modal } from "./SwarmDialog";

export function WorkerInspector({ member, conversation, close }: { member: SwarmMember; conversation: SurfaceConversation; close: () => void }) {
  const controller = useConversation(conversation);
  return <Modal title={member.name} close={close} wide>
    <div className="worker-inspector">
      <div className="worker-identity"><Identity seed={member.iconSeed} large /><div><p className="swarm-eyebrow">Worker conversation</p><p>{member.assignment || "No assignment recorded."}</p></div></div>
      <p className="swarm-caption">Inspecting this worker keeps the main composer addressed to the manager.</p>
      {(controller.error || controller.chat.error) && <p className="notice" role="alert">{controller.error || controller.chat.error}</p>}
      {controller.approvals.length > 0 && <p className="swarm-caption">This worker needs a decision. Your manager can bring it into the conversation.</p>}
      <div className="chat-scroll worker-history">
        {controller.historyCursor && <button className="alloy-button" disabled={controller.loadingHistory} onClick={() => void controller.loadOlder()}>Load earlier messages</button>}
        <Timeline chat={controller.chat} onReload={controller.recoverHistory} />
        {!controller.chat.messages.length && <p className="swarm-caption">No messages loaded yet.</p>}
      </div>
    </div>
  </Modal>;
}
