import { useEffect, useId, useRef, type ReactNode } from "react";

export function SwarmDialog({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className={`swarm-dialog ${wide ? "swarm-dialog-wide" : ""}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
    <header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={close}>✕</button></header>{children}
  </dialog>;
}
