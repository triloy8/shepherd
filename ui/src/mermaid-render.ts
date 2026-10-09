import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: "dark",
  htmlLabels: false,
  fontFamily: '"Segoe UI", system-ui, sans-serif',
});

let sequence = 0;

export async function renderDiagram(code: string): Promise<string> {
  const { svg } = await mermaid.render(`shepherd-diagram-${++sequence}`, code);
  // Mermaid can emit xlink attributes without a namespace on the root.
  const source = svg.slice(0, svg.indexOf(">") + 1).includes("xmlns:xlink=") ? svg
    : svg.replace("<svg ", '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ');
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document.querySelector("parsererror")) throw new Error("Invalid diagram SVG");
  for (const link of document.querySelectorAll("a")) link.replaceWith(...link.childNodes);
  // An SVG image isolates diagram styles and disables embedded scripts/links.
  // It also works with the host's existing img-src data: policy.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(document.documentElement))}`;
}
