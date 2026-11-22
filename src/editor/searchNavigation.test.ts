import { describe, expect, it } from "vitest";
import { searchMatchOffset } from "./searchNavigation";

describe("searchMatchOffset", () => {
  it("locates a 1-based line and Unicode-character column", () => {
    const text = "# 标题\n第一行\n你好 hello\n";
    expect(searchMatchOffset(text, 3, 3)).toBe(text.indexOf("hello"));
    expect(searchMatchOffset(text, 1, 0)).toBe(0);
  });

  it("clamps a stale column to the current line ending", () => {
    expect(searchMatchOffset("short\nnext", 1, 99)).toBe(5);
  });

  it("rejects invalid or vanished targets", () => {
    expect(searchMatchOffset("one", 0, 0)).toBeNull();
    expect(searchMatchOffset("one", 2, 0)).toBeNull();
    expect(searchMatchOffset("one", 1, -1)).toBeNull();
    expect(searchMatchOffset("one", 1.5, 0)).toBeNull();
  });
});
