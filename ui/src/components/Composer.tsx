import { useState } from "react";
import { Icon } from "./Icon";

export function Composer({ draft, onDraft, send, disabled, busy, active, interrupt }: {
  draft: string; onDraft: (value: string) => void; send: (text: string) => Promise<boolean>;
  disabled: boolean; busy: boolean; active: boolean; interrupt: () => void;
}) {
  const [sending, setSending] = useState(false);
  async function submit() {
    if (!draft.trim() || disabled || busy || sending) return;
    const value = draft;
    setSending(true);
    try { if (await send(value)) onDraft(""); } finally { setSending(false); }
  }
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <textarea aria-label="Message Shepherd" placeholder={active ? "Add a follow-up…" : "Message Shepherd…"}
      value={draft} onChange={(event) => onDraft(event.target.value)} maxLength={32768} rows={3} disabled={sending}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
          event.preventDefault(); void submit();
        }
      }} />
    <div className="flex items-center justify-between gap-3 px-3 pb-3">
      <span className="pl-1 text-xs text-dim">{disabled ? "Waiting for connection" : active ? "Follow-ups steer the active turn" : "A little context goes a long way"}</span>
      <div className="flex items-center gap-2">
        {active && <button type="button" className="icon-button" aria-label="Stop response" disabled={disabled || busy} onClick={interrupt}><Icon name="stop" /></button>}
        <button className="send-button" aria-label={active ? "Send follow-up" : "Send message"} disabled={disabled || busy || sending || !draft.trim()}><Icon name="arrow" /></button>
      </div>
    </div>
  </form>;
}
