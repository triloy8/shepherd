import remarkMath from "remark-math";
import type { Processor } from "unified";
import type { Extension } from "micromark-util-types";

/** Keep dollar prices as Markdown text while retaining $formula$ math. */
export default function remarkChatMath(this: Processor) {
  remarkMath.call(this);
  const data = this.data() as { micromarkExtensions?: Extension[] };
  const construct = data.micromarkExtensions?.at(-1)?.text?.[36];
  if (!construct || Array.isArray(construct)) throw new Error("Inline math tokenizer is unavailable.");
  const tokenize = construct.tokenize;
  construct.tokenize = function (effects, ok, nok) {
    const context = this;
    return tokenize.call(context, effects, (code) => {
      const token = context.events.at(-1)![1];
      const source = context.sliceSerialize(token);
      // Match the conventional dollar-math boundaries: no whitespace inside
      // either delimiter, and no digit after the closing $. Reject at parsing
      // time so prices still participate in bold, links, and table formatting.
      // Explicit double-dollar math keeps remark-math's existing behavior.
      if (!source.startsWith("$$") && (
        /\s/.test(source[1] ?? "") || /\s/.test(source.at(-2) ?? "") ||
        (code !== null && code >= 48 && code <= 57)
      )) return nok(code);
      return ok(code);
    }, nok);
  };
}
