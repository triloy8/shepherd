import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "../components/Icon";

export function SwarmDialog({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className={`project-dialog settings-dialog${wide ? " max-w-[960px]" : ""}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
    <header className="mb-5 flex items-center justify-between gap-3">
      <h2 id={titleId} className="min-w-0 break-words text-lg font-medium">{title}</h2>
      <button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={close}><Icon name="close" /></button>
    </header>
    {children}
  </dialog>;
}
