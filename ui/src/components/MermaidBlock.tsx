import { memo, useEffect, useState } from "react";
import { CodeBlock } from "./CodeBlock";

let renderer: Promise<typeof import("../mermaid-render")> | undefined;

export const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const [result, setResult] = useState<{ code: string; url?: string } | null>(null);
  useEffect(() => {
    if (!code.trim() || code.length > 50_000) return;
    let cancelled = false;
    // Debounce incomplete streamed diagrams, and ignore obsolete render results.
    const timer = setTimeout(() => {
      renderer ??= import("../mermaid-render").catch(error => { renderer = undefined; throw error; });
      void renderer.then(module => cancelled ? undefined : module.renderDiagram(code))
        .then(url => { if (!cancelled && url) setResult({ code, url }); })
        .catch(() => { if (!cancelled) setResult({ code }); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [code]);
  const current = result?.code === code ? result : null;
  return <div className="mermaid-block">
    <CodeBlock code={code} language="mermaid" preview={current?.url ? <div className="diagram-scroll" role="region" aria-label="Mermaid diagram" tabIndex={0}>
      <img src={current.url} alt="Mermaid diagram" onError={() => setResult({ code })} />
    </div> : undefined} />
    {(current && !current.url || code.length > 50_000) && <p className="text-xs text-muted" role="status">Diagram unavailable. Showing source.</p>}
  </div>;
});
