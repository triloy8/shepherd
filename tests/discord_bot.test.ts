import { describe, expect, test } from "bun:test";

import { formatCommentaryDelta, phaseHeader } from "../server/core/response_stream_reducer.js";

describe("Response stream reducer phaseHeader", () => {
  test("omits a heading for commentary updates", () => {
    expect(phaseHeader("commentary", false)).toBe("");
  });

  test("adds spacing before final answers without a visible heading", () => {
    expect(phaseHeader("final_answer", true)).toBe("\n\n");
  });
});

describe("Response stream reducer commentary formatting", () => {
  test("prefixes each commentary line with a blockquote marker", () => {
    expect(formatCommentaryDelta("first line\nsecond line", true)).toEqual({
      text: "> first line\n> second line",
      endsAtLineStart: false,
    });
  });

  test("continues an existing commentary line without adding an extra prefix", () => {
    expect(formatCommentaryDelta("continued", false)).toEqual({
      text: "continued",
      endsAtLineStart: false,
    });
  });

  test("marks the next chunk as starting on a new quoted line after a newline", () => {
    expect(formatCommentaryDelta("line one\n", true)).toEqual({
      text: "> line one\n",
      endsAtLineStart: true,
    });
  });

  test("quotes empty lines inside commentary without leaving a dangling quote marker", () => {
    expect(formatCommentaryDelta("line one\n\nline three", true)).toEqual({
      text: "> line one\n> \n> line three",
      endsAtLineStart: false,
    });
  });
});
