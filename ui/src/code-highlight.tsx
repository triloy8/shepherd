import { createLowlight } from "lowlight";
import type { RootContent } from "hast";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

const highlighter = createLowlight({ bash, css, diff, go, javascript, json, markdown, python, rust, sql, typescript, xml });
function token(node: RootContent, index: number): React.ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  return <span key={index} className={Array.isArray(node.properties.className) ? node.properties.className.join(" ") : undefined}>{node.children.map(token)}</span>;
}

export function highlight(code: string, language: string) {
  if (!highlighter.registered(language) || code.length > 50_000) return null;
  try { return highlighter.highlight(language, code).children.map(token); }
  catch { return null; }
}
