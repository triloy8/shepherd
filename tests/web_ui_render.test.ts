import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Message } from "../ui/src/components/Message";

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
