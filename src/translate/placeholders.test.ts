import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_CLOSE,
  PLACEHOLDER_OPEN,
  protectInlineSpans,
  replaceInlineSpans,
  restoreInlineSpans,
} from "./placeholders";

describe("protectInlineSpans", () => {
  it("leaves text without spans untouched", () => {
    const text = "普通段落文本。\n";
    const protectedText = protectInlineSpans(text);
    expect(protectedText.text).toBe(text);
    expect(protectedText.spans).toEqual([]);
  });

  it("swaps a single-backtick code span for a placeholder", () => {
    const protectedText = protectInlineSpans("调用 `parse(input)` 继续。\n");
    expect(protectedText.text).toBe("调用 ⟪1⟫ 继续。\n");
    expect(protectedText.spans).toEqual([
      { index: 1, placeholder: "⟪1⟫", original: "`parse(input)`" },
    ]);
  });

  it("swaps single-dollar math spans but leaves $$ display math as text", () => {
    const protectedText = protectInlineSpans(
      "由 $x^2$ 与 $$ E = mc^2 $$ 以及 $a+b$ 组成。\n",
    );
    expect(protectedText.text).toBe("由 ⟪1⟫ 与 $$ E = mc^2 $$ 以及 ⟪2⟫ 组成。\n");
    expect(protectedText.spans.map((span) => span.original)).toEqual([
      "$x^2$",
      "$a+b$",
    ]);
  });

  it("never nests: a code span containing dollars is one span", () => {
    const protectedText = protectInlineSpans("看 `$x$` 这段。\n");
    expect(protectedText.text).toBe("看 ⟪1⟫ 这段。\n");
    expect(protectedText.spans).toHaveLength(1);
    expect(protectedText.spans[0].original).toBe("`$x$`");
  });

  it("protects multi-backtick code spans as a single unit", () => {
    const protectedText = protectInlineSpans("用 `` `x` `` 表示。\n");
    expect(protectedText.text).toBe("用 ⟪1⟫ 表示。\n");
    expect(protectedText.spans).toEqual([
      { index: 1, placeholder: "⟪1⟫", original: "`` `x` ``" },
    ]);
  });

  it("leaves unmatched backticks and dollars as literal text", () => {
    expect(protectInlineSpans("一个 ` 符号\n").text).toBe("一个 ` 符号\n");
    expect(protectInlineSpans("价格 $5 且无闭合。\n").text).toBe(
      "价格 $5 且无闭合。\n",
    );
  });

  it("numbers placeholders past literal ⟪n⟫ tokens in the source", () => {
    const protectedText = protectInlineSpans("见 ⟪1⟫ 与 `code`。\n");
    expect(protectedText.text).toBe("见 ⟪1⟫ 与 ⟪2⟫。\n");
    expect(protectedText.spans[0].index).toBe(2);
  });

  it("assigns sequential indexes across a whole segment", () => {
    const protectedText = protectInlineSpans(
      "`a` 然后 $b$ 再 `c`。\n" + "第二行 $d$。\n",
    );
    expect(protectedText.spans.map((span) => span.index)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("round-trips through replaceInlineSpans byte-for-byte", () => {
    const text = "`a` 与 $x_i$ 混合，`` `code` `` 和 $$ long $$ 以及普通文字。\n";
    const protectedText = protectInlineSpans(text);
    expect(replaceInlineSpans(protectedText.text, protectedText.spans)).toBe(
      text,
    );
  });

  it("does not swallow newline-crossing spans", () => {
    // A backtick or dollar opener with no closing on the same line stays text.
    const protectedText = protectInlineSpans("`未闭合\n继续\n");
    expect(protectedText.text).toBe("`未闭合\n继续\n");
    expect(protectedText.spans).toEqual([]);
  });
});

describe("restoreInlineSpans", () => {
  const span = (index: number, original: string) => ({
    index,
    placeholder: `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`,
    original,
  });

  it("restores every placeholder in the reply", () => {
    const spans = [span(1, "`code`"), span(2, "$x$")];
    expect(
      restoreInlineSpans("⟪1⟫ 与 ⟪2⟫", "译文 ⟪1⟫ 与 ⟪2⟫", spans),
    ).toBe("译文 `code` 与 $x$");
  });

  it("restores out-of-order placeholders by index", () => {
    const spans = [span(1, "`a`"), span(2, "$b$")];
    expect(restoreInlineSpans("⟪1⟫ 与 ⟪2⟫", "⟪2⟫ 先 ⟪1⟫ 后", spans)).toBe(
      "$b$ 先 `a` 后",
    );
  });

  it("returns null when the reply drops a placeholder", () => {
    const spans = [span(1, "`code`"), span(2, "$x$")];
    expect(restoreInlineSpans("⟪1⟫ 与 ⟪2⟫", "只剩 ⟪1⟫", spans)).toBeNull();
  });

  it("returns null when a placeholder is duplicated", () => {
    const spans = [span(1, "`code`")];
    expect(restoreInlineSpans("⟪1⟫", "⟪1⟫ ⟪1⟫", spans)).toBeNull();
  });

  it("returns null when the reply invents a new token", () => {
    const spans = [span(2, "`code`")];
    expect(restoreInlineSpans("⟪2⟫", "⟪2⟫ 与 ⟪3⟫", spans)).toBeNull();
  });

  it("returns null when a token is renumbered out of range", () => {
    const spans = [span(1, "`code`")];
    expect(restoreInlineSpans("⟪1⟫", "⟪2⟫", spans)).toBeNull();
  });

  it("returns null when a lone bracket fragment survives", () => {
    const spans = [span(1, "`code`")];
    expect(restoreInlineSpans("⟪1⟫", "⟪x⟫", spans)).toBeNull();
    expect(restoreInlineSpans("⟪1⟫", "⟪", spans)).toBeNull();
    expect(restoreInlineSpans("⟪1⟫", "⟫", spans)).toBeNull();
  });

  it("passes a token-less chunk through unchanged", () => {
    expect(
      restoreInlineSpans("无 token", "译好的无 token", [span(1, "`c`")]),
    ).toBe("译好的无 token");
  });
});