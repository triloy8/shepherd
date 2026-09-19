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
