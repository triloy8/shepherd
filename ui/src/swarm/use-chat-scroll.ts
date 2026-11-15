import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../chat-state";

/** Layout and explicit scroll gestures, independent of provider and team state. */
export function useChatScroll(messages: readonly ChatMessage[]) {
  const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const chat = useRef<HTMLDivElement>(null), composeZone = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const pendingJump = useRef<{ element: HTMLDivElement; overflow: string; frame: number } | null>(null);
  const [latest, setLatest] = useState(false);
  const bottom = () => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; following.current = true; setLatest(false); };
  const cancelJump = () => {
    const pending = pendingJump.current;
    if (!pending) return;
    cancelAnimationFrame(pending.frame);
    pending.element.style.overflowY = pending.overflow;
    pendingJump.current = null;
  };
  const jumpToLatest = () => {
    cancelJump();
    const element = scroller.current;
    if (!element) return;
    const overflow = element.style.overflowY;
    // Changing scrollTop alone leaves native touch inertia running. Remove the
    // scrolling surface for one frame to cancel it before restoring scrolling.
    element.style.overflowY = "hidden";
    element.getBoundingClientRect();
    bottom();
    const frame = requestAnimationFrame(() => {
      element.style.overflowY = overflow;
      pendingJump.current = null;
      bottom();
    });
    pendingJump.current = { element, overflow, frame };
  };
  useEffect(() => cancelJump, []);
  useLayoutEffect(() => { if (following.current) bottom(); }, [messages]);
  useLayoutEffect(() => {
    const update = () => {
      const dock = composeZone.current;
      if (dock) chat.current?.style.setProperty("--swarm-compose-height", `${dock.getBoundingClientRect().height + parseFloat(getComputedStyle(dock).marginBottom) + 12}px`);
      if (following.current) bottom();
    };
    const resize = new ResizeObserver(update);
    if (scroller.current) resize.observe(scroller.current);
    if (content.current) resize.observe(content.current);
    if (composeZone.current) resize.observe(composeZone.current);
    update();
    return () => resize.disconnect();
  }, []);
  const onScroll = () => {
    if (pendingJump.current) return;
    const element = scroller.current!;
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    setLatest(!following.current);
  };
  return { scroller, content, chat, composeZone, latest, jumpToLatest, onScroll, stopFollowing: () => { following.current = false; } };
}
