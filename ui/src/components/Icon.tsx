import type { CSSProperties } from "react";
const paths = {
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  skills: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
  fork: "M6 3v12a6 6 0 0 0 6 6M6 9h6a6 6 0 0 0 6-6m-3 3 3-3 3 3",
  compact: "M4 4h16M4 20h16M8 8l4 4 4-4M8 16l4-4 4 4",
  archive: "M3 3h18v4H3ZM5 7v14h14V7M9 11h6",
  usage: "M4 20h16M6 16v-5M12 16V4M18 16V8",
  image: "M3 3h18v18H3ZM3 16l5-5 4 4 3-3 6 6M8 7h.01",
  host: "M4 3h16v7H4ZM4 14h16v7H4ZM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  plus: "M12 5v14M5 12h14", arrow: "m5 12 7-7 7 7M12 5v14", menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6", chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z",
  refresh: "M21 12a9 9 0 1 1-2.7-6.4L21 9M21 3v6h-6",
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  stop: "M6 6h12v12H6Z", chevron: "m9 5 7 7-7 7", check: "m5 12 4 4L19 6",
  detach: "M9 5H5v14h4M10 12h11m-4-4 4 4-4 4", shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z",
  revert: "M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12h-3",
  down: "m5 9 7 7 7-7", copy: "M9 9h11v11H9ZM15 9V3H3v12h6",
} as const;
export function Icon({ name, className = "", style }: { name: keyof typeof paths; className?: string; style?: CSSProperties }) {
  return <svg className={`size-4 shrink-0 ${className}`} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
