import { memo, useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

let highlighter: Promise<typeof import("../code-highlight")> | undefined;

export const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language: string }) {
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; content: ReactNode } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!language || code.length > 50_000) return;
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
    <div className="code-block-toolbar"><span className="truncate">{language || "Plain text"}</span><button type="button" className="flex min-h-11 items-center gap-1.5 px-2 hover:text-ink" aria-label="Copy code" onClick={() => {
      void navigator.clipboard.writeText(code).then(() => { setCopied(code); setError(null); }, () => { setError(code); setCopied(null); });
    }}><Icon name={copied === code ? "check" : "copy"} className="size-3.5" /><span role="status">{error === code ? "Could not copy" : copied === code ? "Copied" : "Copy"}</span></button></div>
    <pre><code className={language ? `language-${language}` : undefined}>{highlighted?.code === code && highlighted.language === language ? highlighted.content ?? code : code}</code></pre>
  </div>;
});
