import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Message } from "../ui/src/components/Message";
import type { WebImage } from "../shared/protocol/web";

function renderAssistantMarkdown(text: string) {
  return renderToStaticMarkup(createElement(Message, { message: {
    id: "markdown", turnId: "turn", role: "assistant", complete: true, text,
  } }));
}

test("assistant Markdown renders inline and display math with accessible MathML", () => {
  const html = renderAssistantMarkdown("Energy: $E = mc^2$.\n\n$$\n\\frac{a}{b} = \\sqrt{c}\n$$");
  expect(html).toContain('class="katex"');
  expect(html).toContain('class="katex-display"');
  expect(html).toContain('<math xmlns="http://www.w3.org/1998/Math/MathML"');
  expect(html).toContain("<mfrac>");
  expect(html).toContain("<msqrt>");
});

test("math keeps code and escaped dollars literal and malformed formulas readable", () => {
  const literal = renderAssistantMarkdown("`$x^2$`\n\n```tex\n$x^2$\n```\n\nPrice: \\$5.\n\nUnfinished $x^2");
  expect(literal).not.toContain('class="katex"');
  expect(literal).toContain("<code>$x^2$</code>");
  expect(literal).toContain("Price: $5.");
  expect(literal).toContain("Unfinished $x^2");
  const invalid = renderAssistantMarkdown("$\\unknowncommand{x}$\n\nStill readable.");
  expect(invalid).toContain("Still readable.");
  expect(invalid).toContain("unknowncommand");
  const untrusted = renderAssistantMarkdown("$\\href{javascript:alert(1)}{click}$\n\n$\\includegraphics{https://tracking.test/pixel.png}$");
  expect(untrusted).not.toContain('href="javascript:');
  expect(untrusted).not.toContain("<img");
});

test("assistant Markdown supports tables, task lists, strikethrough and footnotes", () => {
  const html = renderAssistantMarkdown("| Name | Value |\n| --- | ---: |\n| Formula | $x^2$ |\n\n- [x] Done\n- [ ] Pending\n\n~~Old~~ and a note[^1].\n\n[^1]: Details.");
  expect(html).toContain('class="table-scroll"');
  expect(html).toContain("<table>");
  expect(html).toContain('style="text-align:right"');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('checked=""');
  expect(html).toContain("<del>Old</del>");
  expect(html).toContain('data-footnotes="true"');
  expect(html).toContain('class="katex"');
});

test("assistant Markdown embeds and links only known image artifacts", () => {
  const image: WebImage = { url: "/api/v1/conversations/abc/images/def", path: "/tmp/desktop screenshot.png", name: "desktop screenshot.png", prompt: null };
  const render = (text: string, images = [image]) => renderToStaticMarkup(createElement(Message, { images, message: {
    id: "answer", turnId: "turn", role: "assistant", complete: true, phase: "final_answer", text,
  } }));
  const html = render("Here is the desktop view.\n\n![Desktop view](/tmp/desktop%20screenshot.png)\n\n[Open original](/tmp/desktop%20screenshot.png)");
  expect(html).toContain(`src="${image.url}"`);
  expect(html).toContain('alt="Desktop view"');
  expect(html).toContain(`href="${image.url}"`);
  expect(html).not.toContain('src="/tmp/');
  expect(html).not.toContain("<figure");
  expect(render(`![Asset](${image.url})`)).toContain(`src="${image.url}"`);
  for (const source of ["/tmp/unregistered.png", "desktop%20screenshot.png", "/api/v1/conversations/other/images/def", "https://tracking.test/pixel.png", "file:///tmp/desktop%20screenshot.png", "javascript:alert(1)", "data:image/png;base64,aGVsbG8="]) {
    expect(render(`![Blocked](${source})`)).not.toContain("<img");
  }
  expect(render("![Missing](/tmp/desktop%20screenshot.png)", [])).toContain("[Image: Missing]");
  expect(render("`![Code](/tmp/desktop%20screenshot.png)`")).not.toContain("<img");
  expect(render("![Bad](/tmp/desktop%20screenshot.png)", [{ ...image, url: "https://tracking.test/pixel.png" }])).not.toContain("<img");
});

test("agent Markdown cannot inject HTML, active links or remote image requests", () => {
  const html = renderToStaticMarkup(createElement(Message, { message: {
    id: "message", turnId: "turn", role: "assistant", complete: true,
    text: '<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![tracking](https://untrusted.test/track.png)\n\n**Safe formatting**',
  } }));
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<img");
  expect(html).toContain("[Image: tracking]");
  expect(html).toContain("<strong>Safe formatting</strong>");
});

test("persisted user messages put revert beside copy; optimistic and assistant messages cannot revert", () => {
  const message = { id: "user-item", turnId: "turn-1", role: "user" as const, text: "Revert this turn", complete: true };
  const render = (changes = {}, disabled = false) => renderToStaticMarkup(createElement(Message, { message: { ...message, ...changes }, onRevert: () => {}, revertDisabled: disabled }));
  const html = render();
  expect(html).toContain('aria-label="Copy message"');
  expect(html).toContain("Revert from here");
  expect(html.indexOf("Revert this turn")).toBeLessThan(html.indexOf("Copy message"));
  expect(html.indexOf("Copy message")).toBeLessThan(html.indexOf("Revert from here"));
  expect(render({}, true)).toContain('disabled=""');
  for (const changes of [{ id: "local:optimistic" }, { turnId: "" }, { complete: false }, { role: "assistant" }]) expect(render(changes)).not.toContain("Revert from here");
  const image = render({ text: "", attachments: ["data:image/png;base64,aGVsbG8="] });
  expect(image).toContain("Revert from here");
  expect(image).not.toContain("Copy message");
});
