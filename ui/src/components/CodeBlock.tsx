import { memo, useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

let highlighter: Promise<typeof import("../code-highlight")> | undefined;

export const CodeBlock = memo(function CodeBlock({ code, language, preview }: { code: string; language: string; preview?: ReactNode }) {
  const [showSource, setShowSource] = useState(false);
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; content: ReactNode } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!language || language === "mermaid" || code.length > 50_000) return;
    let cancelled = false;
    // Let streamed blocks settle before highlighting another partial token.
    const timer = setTimeout(() => {
      highlighter ??= import("../code-highlight");
      void highlighter.then(module => { if (!cancelled) setHighlighted({ code, language, content: module.highlight(code, language) }); })
        .catch(() => { highlighter = undefined; });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code, language]);
  return <div className="code-block">
    <div className="code-block-toolbar"><span className="truncate">{language || "Plain text"}</span><div className="flex items-center gap-2">
      {preview && <button type="button" className="min-h-11 px-2 hover:text-ink" onClick={() => setShowSource(value => !value)}>{showSource ? "Show diagram" : "Show source"}</button>}
      <button type="button" className="flex min-h-11 items-center gap-1.5 px-2 hover:text-ink" aria-label="Copy code" onClick={() => {
      void navigator.clipboard.writeText(code).then(() => { setCopied(code); setError(null); }, () => { setError(code); setCopied(null); });
    }}><Icon name={copied === code ? "check" : "copy"} className="size-3.5" /><span role="status">{error === code ? "Could not copy" : copied === code ? "Copied" : "Copy"}</span></button></div></div>
    {preview && !showSource ? preview : <pre><code className={language ? `language-${language}` : undefined}>{highlighted?.code === code && highlighted.language === language ? highlighted.content ?? code : code}</code></pre>}
  </div>;
});
