import { describe, expect, it } from "vitest";
import {
  packBlocksByHeight,
  splitManualSlides,
  splitNaturalBlocks,
} from "./presentationPlan";

describe("splitManualSlides", () => {
  it("returns null for an empty document", () => {
    expect(splitManualSlides("")).toBeNull();
  });

  it("returns null for a document without separators", () => {
    expect(splitManualSlides("Slide A\n\nSlide B\n")).toBeNull();
    expect(splitManualSlides("\n\n")).toBeNull();
  });

  it("splits on --- between blank lines", () => {
    const doc = "Slide A\n\n---\n\nSlide B\n";
    expect(splitManualSlides(doc)).toEqual(["Slide A", "Slide B"]);
  });

  it("splits on separator variants - - - and ----, trims slides", () => {
    expect(
      splitManualSlides("Slide one\nwith two lines\n\n- - -\n\nSlide two\n"),
    ).toEqual(["Slide one\nwith two lines", "Slide two"]);
    expect(splitManualSlides("A\n\n----\n\nB\n")).toEqual(["A", "B"]);
    expect(splitManualSlides("  A  \n\n---\n\n  B  \n")).toEqual(["A", "B"]);
  });

  it("rejects too-short dash runs as separators", () => {
    expect(splitManualSlides("A\n\n--\n\nB\n")).toBeNull();
    expect(splitManualSlides("A\n\n- -\n\nB\n")).toBeNull();
  });

  it("does not treat *** or ___ as separators", () => {
    expect(splitManualSlides("A\n\n***\n\nB\n")).toBeNull();
    expect(splitManualSlides("A\n\n___\n\nB\n")).toBeNull();
    // A non-separator rule stays in the slide content.
    expect(splitManualSlides("A\n\n***\n\n---\n\nB\n")).toEqual([
      "A\n\n***",
      "B",
    ]);
  });

  it("does not split a setext H2 underline directly after content", () => {
    expect(splitManualSlides("Title\n---\n\nBody\n")).toBeNull();
    expect(splitManualSlides("Title\n---\n")).toBeNull();
  });

  it("splits when the dashes are not directly after content", () => {
    expect(splitManualSlides("Title\n\n---\n\nBody\n")).toEqual([
      "Title",
      "Body",
    ]);
  });

  it("prepends closed frontmatter to the first slide without splitting on it", () => {
    const doc = "---\ntitle: Hi\n---\n\nSlide A\n\n---\n\nSlide B\n";
    expect(splitManualSlides(doc)).toEqual([
      "---\ntitle: Hi\n---\n\nSlide A",
      "Slide B",
    ]);
  });

  it("accepts ... as the frontmatter closing line", () => {
    const doc = "---\ntitle: Hi\n...\n\nA\n\n---\n\nB\n";
    expect(splitManualSlides(doc)).toEqual([
      "---\ntitle: Hi\n...\n\nA",
      "B",
    ]);
  });

  it("treats an unclosed frontmatter opener as a separator at document start", () => {
    expect(splitManualSlides("---\ntitle: x\n\nContent\n")).toEqual([
      "title: x\n\nContent",
    ]);
  });

  it("does not split on --- inside a fenced code block", () => {
    expect(splitManualSlides("```\n---\n```\n\nA\n")).toBeNull();
    expect(splitManualSlides("~~~\n---\n~~~\n\nA\n")).toBeNull();
  });

  it("keeps a fenced --- as slide content and splits after the fence", () => {
    const doc =
      "Before\n\n```md\n---\n```\n\nMiddle\n\n---\n\nAfter\n";
    expect(splitManualSlides(doc)).toEqual([
      "Before\n\n```md\n---\n```\n\nMiddle",
      "After",
    ]);
  });

  it("splits on --- right after a fence closing line (protected-block end)", () => {
    const doc = "```js\nx\n```\n---\n\nB\n";
    expect(splitManualSlides(doc)).toEqual(["```js\nx\n```", "B"]);
  });

  it("does not split on --- inside a display-math block", () => {
    expect(splitManualSlides("$$\n---\n$$\n\nA\n")).toBeNull();
    expect(
      splitManualSlides("$$\n---\n$$\n\nA\n\n---\n\nB\n"),
    ).toEqual(["$$\n---\n$$\n\nA", "B"]);
  });

  it("does not split on --- inside an HTML comment block", () => {
    expect(splitManualSlides("<!--\n---\n-->\n\nA\n")).toBeNull();
  });

  it("splits on --- right after a single-line comment", () => {
    expect(splitManualSlides("<!-- note -->\n---\n\nA\n")).toEqual([
      "<!-- note -->",
      "A",
    ]);
  });

  it("treats a separator at document start as a boundary", () => {
    expect(splitManualSlides("---\n\nSlide\n")).toEqual(["Slide"]);
    expect(splitManualSlides("---\nSlide\n")).toEqual(["Slide"]);
  });

  it("drops empty slides between consecutive separators", () => {
    expect(splitManualSlides("A\n\n---\n\n---\n\nB\n")).toEqual(["A", "B"]);
    expect(splitManualSlides("A\n\n---\n---\n\nB\n")).toEqual(["A", "B"]);
  });

  it("drops the empty slide after a trailing separator", () => {
    expect(splitManualSlides("A\n\n---\n")).toEqual(["A"]);
    expect(splitManualSlides("A\n\n---\n\n")).toEqual(["A"]);
  });

  it("handles CRLF line endings", () => {
    expect(splitManualSlides("A\r\n\r\n---\r\n\r\nB\r\n")).toEqual([
      "A",
      "B",
    ]);
  });
});

describe("splitNaturalBlocks", () => {
  it("returns no blocks for an empty document", () => {
    expect(splitNaturalBlocks("")).toEqual([]);
  });

  it("splits paragraph runs on blank runs and drops the blanks", () => {
    expect(splitNaturalBlocks("a\nb\n\nc\n\nd\n")).toEqual(["a\nb", "c", "d"]);
    expect(splitNaturalBlocks("a\n\n\n\nb\n")).toEqual(["a", "b"]);
  });

  it("trims each block", () => {
    expect(splitNaturalBlocks("  a  \n\nb\n")).toEqual(["a", "b"]);
  });

  it("keeps a fenced code block with interior blank lines as one block", () => {
    expect(
      splitNaturalBlocks("```js\nx\n\ny\n```\n\nafter\n"),
    ).toEqual(["```js\nx\n\ny\n```", "after"]);
  });

  it("keeps a tilde-fenced block as one block", () => {
    expect(splitNaturalBlocks("~~~\na\n\n~~~\n")).toEqual(["~~~\na\n\n~~~"]);
  });

  it("runs an unclosed fence to EOF", () => {
    expect(splitNaturalBlocks("```\na\n\nb")).toEqual(["```\na\n\nb"]);
  });

  it("closes a fence only with the same character of equal or greater length", () => {
    expect(splitNaturalBlocks("```js\nx\n````\n")).toEqual(["```js\nx\n````"]);
    expect(splitNaturalBlocks("```\nx\n~~~\n")).toEqual(["```\nx\n~~~"]);
  });

  it("keeps a display-math block with interior blank lines as one block", () => {
    expect(splitNaturalBlocks("$$\na\n\nb\n$$\n\nafter\n")).toEqual([
      "$$\na\n\nb\n$$",
      "after",
    ]);
  });

  it("runs an unclosed math block to EOF", () => {
    expect(splitNaturalBlocks("$$\na\n\nb")).toEqual(["$$\na\n\nb"]);
  });

  it("keeps YAML frontmatter as one block", () => {
    expect(splitNaturalBlocks("---\ntitle: x\n---\n\ntext\n")).toEqual([
      "---\ntitle: x\n---",
      "text",
    ]);
    // Interior blank lines inside frontmatter are protected too.
    expect(
      splitNaturalBlocks("---\ntitle: x\n\nmore: y\n---\n\ntext\n"),
    ).toEqual(["---\ntitle: x\n\nmore: y\n---", "text"]);
  });

  it("keeps an HTML comment block with interior blank lines as one block", () => {
    expect(splitNaturalBlocks("<!--\na\n\nb\n-->\n\nafter\n")).toEqual([
      "<!--\na\n\nb\n-->",
      "after",
    ]);
  });

  it("keeps a single-line comment separate from the next paragraph", () => {
    expect(splitNaturalBlocks("<!-- note -->\ntext\n")).toEqual([
      "<!-- note -->",
      "text",
    ]);
  });

  it("runs an unclosed comment to EOF", () => {
    expect(splitNaturalBlocks("<!--\na")).toEqual(["<!--\na"]);
  });
});

describe("packBlocksByHeight", () => {
  it("returns no groups for no items", () => {
    expect(packBlocksByHeight([], () => 1, 10)).toEqual([]);
  });

  it("packs greedily while the cumulative height fits exactly", () => {
    const items = ["a", "b", "c"];
    const heights: Record<string, number> = { a: 10, b: 20, c: 10 };
    expect(packBlocksByHeight(items, (item) => heights[item], 30)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(
      packBlocksByHeight(["a", "b"], (item) => (item === "a" ? 10 : 20), 30),
    ).toEqual([["a", "b"]]);
  });

  it("starts a new group when the next item would overflow", () => {
    const items = ["a", "b", "c"];
    const heights: Record<string, number> = { a: 10, b: 10, c: 15 };
    expect(packBlocksByHeight(items, (item) => heights[item], 20)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  it("gives an oversized item its own group", () => {
    const items = ["a", "b", "c"];
    expect(
      packBlocksByHeight(
        items,
        (item) => [10, 40, 10][items.indexOf(item)],
        20,
      ),
    ).toEqual([["a"], ["b"], ["c"]]);
    expect(
      packBlocksByHeight(
        items,
        (item) => [50, 10, 10][items.indexOf(item)],
        20,
      ),
    ).toEqual([["a"], ["b", "c"]]);
  });

  it("counts zero and negative heights as zero", () => {
    const items = ["a", "b", "c"];
    expect(
      packBlocksByHeight(
        items,
        (item) => [5, 0, 5][items.indexOf(item)],
        10,
      ),
    ).toEqual([["a", "b", "c"]]);
    expect(
      packBlocksByHeight(
        items,
        (item) => [5, -3, 5][items.indexOf(item)],
        10,
      ),
    ).toEqual([["a", "b", "c"]]);
    expect(packBlocksByHeight(items, () => 0, 0)).toEqual([["a", "b", "c"]]);
  });

  it("moves an orphaned ATX heading to the start of the next group", () => {
    expect(
      packBlocksByHeight(["para", "# Big", "tail"], () => 10, 20),
    ).toEqual([["para"], ["# Big", "tail"]]);
  });

  it("recognizes heading levels one through six", () => {
    expect(
      packBlocksByHeight(["a", "###### x", "b"], () => 10, 20),
    ).toEqual([["a"], ["###### x", "b"]]);
    expect(
      packBlocksByHeight(["a", "####### x", "b"], () => 10, 20),
    ).toEqual([["a", "####### x"], ["b"]]);
    expect(
      packBlocksByHeight(["a", "#Nospace", "b"], () => 10, 20),
    ).toEqual([["a", "#Nospace"], ["b"]]);
  });

  it("does not move the heading out of the final group", () => {
    expect(packBlocksByHeight(["a", "# H"], () => 5, 10)).toEqual([
      ["a", "# H"],
    ]);
  });

  it("does not move a singleton heading group", () => {
    expect(packBlocksByHeight(["a", "# H", "b"], () => 10, 15)).toEqual([
      ["a"],
      ["# H"],
      ["b"],
    ]);
  });

  it("does not repack the group that receives the heading", () => {
    // The move leaves the recipient at 11 > 10; the single non-cascading
    // pass leaves it intact.
    const items = ["a", "# H", "b"];
    expect(
      packBlocksByHeight(
        items,
        (item) => [4, 4, 7][items.indexOf(item)],
        10,
      ),
    ).toEqual([["a"], ["# H", "b"]]);
  });

  it("only moves string headings", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(packBlocksByHeight(items, () => 10, 20)).toEqual([
      [{ id: 1 }, { id: 2 }],
      [{ id: 3 }],
    ]);
  });
});