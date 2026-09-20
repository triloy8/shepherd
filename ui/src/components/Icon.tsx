import type { CSSProperties } from "react";
const paths = {
  more: "M5 12h.01M12 12h.01M19 12h.01",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  plus: "M12 5v14M5 12h14", arrow: "m5 12 7-7 7 7M12 5v14", menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6", chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1",
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  stop: "M6 6h12v12H6Z", chevron: "m9 5 7 7-7 7", check: "m5 12 4 4L19 6",
  detach: "M9 5H5v14h4M10 12h11m-4-4 4 4-4 4", shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z",
  down: "m5 9 7 7 7-7", copy: "M9 9h11v11H9ZM15 9V3H3v12h6",
} as const;
export function Icon({ name, className = "", style }: { name: keyof typeof paths; className?: string; style?: CSSProperties }) {
  return <svg className={`size-4 shrink-0 ${className}`} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
