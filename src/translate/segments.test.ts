import { describe, expect, it } from "vitest";
import {
  MAX_TRANSLATABLE_CHUNK_LENGTH,
  reassembleTranslation,
  splitMarkdownSegments,
  subdivideSegment,
  type Segment,
} from "./segments";

const kinds = (segments: readonly Segment[]): string[] =>
  segments.map((segment) => segment.kind);

const texts = (
  segments: readonly Segment[],
  kind: Segment["kind"],
): string[] =>
  segments.filter((segment) => segment.kind === kind).map((segment) => segment.text);

const joined = (segments: readonly Segment[]): string =>
  segments.map((segment) => segment.text).join("");

describe("splitMarkdownSegments", () => {
  it("splits plain text into paragraph blocks separated by blank lines", () => {
    const doc = "first\nline\n\nsecond para\n";
    const segments = splitMarkdownSegments(doc);
    expect(kinds(segments)).toEqual([
      "translatable",
      "protected",
      "translatable",
    ]);
    expect(texts(segments, "translatable")).toEqual([
      "first\nline\n",
      "second para\n",
    ]);
    expect(texts(segments, "protected")).toEqual(["\n"]);
    expect(joined(segments)).toBe(doc);
  });

  it("returns no segments for an empty document", () => {
    expect(splitMarkdownSegments("")).toEqual([]);
  });

  it("keeps blank-only documents lossless", () => {
    expect(splitMarkdownSegments("\n\n")).toEqual([
      { kind: "protected", text: "\n\n" },
    ]);
  });

  it("protects YAML frontmatter at the document start", () => {
    const doc = "---\ntitle: 标题\ntags: [a, b]\n---\n\nbody\n";
    const segments = splitMarkdownSegments(doc);
    expect(segments).toEqual([
      { kind: "protected", text: "---\ntitle: 标题\ntags: [a, b]\n---\n" },
      { kind: "protected", text: "\n" },
      { kind: "translatable", text: "body\n" },
    ]);
  });

  it("protects an unclosed frontmatter block to the end of the document", () => {
    const doc = "---\ntitle: 标题\n";
    expect(splitMarkdownSegments(doc)).toEqual([
      { kind: "protected", text: doc },
    ]);
  });

  it("does not treat a mid-document --- line as frontmatter", () => {
    const segments = splitMarkdownSegments("text\n\n---\n");
    expect(texts(segments, "translatable")).toEqual(["text\n", "---\n"]);
  });

  it("protects ``` fenced code blocks including their fences", () => {
    const doc = "```ts\nconst x = 1;\n```\n\nafter\n";
    const segments = splitMarkdownSegments(doc);
    expect(segments[0]).toEqual({
      kind: "protected",
      text: "```ts\nconst x = 1;\n```\n",
    });
    expect(segments.at(-1)).toEqual({ kind: "translatable", text: "after\n" });
    expect(joined(segments)).toBe(doc);
  });

  it("protects ~~~ fenced code blocks", () => {
    const doc = "~~~\ncode\n~~~\nafter\n";
    const segments = splitMarkdownSegments(doc);
    expect(segments[0]).toEqual({ kind: "protected", text: "~~~\ncode\n~~~\n" });
    expect(segments.at(-1)).toEqual({ kind: "translatable", text: "after\n" });
  });

  it("protects an unclosed fence to the end of the document", () => {
    const doc = "```\ncode line\n";
    expect(splitMarkdownSegments(doc)).toEqual([
      { kind: "protected", text: doc },
    ]);
  });

  it("requires the closing fence to use the same char and length", () => {
    const shorter = "````\na\n```\nb\n````\n";
    expect(splitMarkdownSegments(shorter)).toEqual([
      { kind: "protected", text: shorter },
    ]);
    const different = "```\n~~~\n```\n";
    expect(splitMarkdownSegments(different)).toEqual([
      { kind: "protected", text: different },
    ]);
  });

  it("protects whole-block display math including the delimiters", () => {
    const doc = "$$\nE = mc^2\n$$\n\ntext\n";
    const segments = splitMarkdownSegments(doc);
    expect(segments[0]).toEqual({
      kind: "protected",
      text: "$$\nE = mc^2\n$$\n",
    });
    expect(segments.at(-1)).toEqual({ kind: "translatable", text: "text\n" });
  });

  it("treats one-line $$...$$ as ordinary translatable text", () => {
    const doc = "$$ E = mc^2 $$\n\nmore\n";
    const segments = splitMarkdownSegments(doc);
    expect(segments[0]).toEqual({
      kind: "translatable",
      text: "$$ E = mc^2 $$\n",
    });
    expect(segments.at(-1)).toEqual({ kind: "translatable", text: "more\n" });
  });

  it("does not treat prose such as `$$ 500 元/人` as a math block", () => {
    const doc = "$$ 500 元/人\n\n后面这段也要翻译\n";
    const segments = splitMarkdownSegments(doc);
    expect(texts(segments, "translatable")).toEqual([
      "$$ 500 元/人\n",
      "后面这段也要翻译\n",
    ]);
    expect(joined(segments)).toBe(doc);
  });

  it("protects an unclosed display math block to the end of the document", () => {
    const doc = "$$\nE = mc^2\n";
    expect(splitMarkdownSegments(doc)).toEqual([
      { kind: "protected", text: doc },
    ]);
  });

  it("protects HTML comment blocks", () => {
    const doc = "<!--\n这是注释\n-->\n\ntext\n";
    const segments = splitMarkdownSegments(doc);
    expect(segments[0]).toEqual({
      kind: "protected",
      text: "<!--\n这是注释\n-->\n",
    });
    expect(segments.at(-1)).toEqual({ kind: "translatable", text: "text\n" });
  });

  it("protects single-line comments and unclosed comment blocks", () => {
    expect(splitMarkdownSegments("<!-- note -->\n")).toEqual([
      { kind: "protected", text: "<!-- note -->\n" },
    ]);
    const unclosed = "<!--\nnote\n";
    expect(splitMarkdownSegments(unclosed)).toEqual([
      { kind: "protected", text: unclosed },
    ]);
  });

  it("only treats a line-start `<!--` as a comment block opener", () => {
    const doc = "text with <!-- inline marker\n\n<!--\n注释\n-->\n";
    const segments = splitMarkdownSegments(doc);
    expect(texts(segments, "translatable")).toEqual([
      "text with <!-- inline marker\n",
    ]);
    expect(
      segments.some(
        (segment) =>
          segment.kind === "protected" && segment.text.includes("注释"),
      ),
    ).toBe(true);
    expect(joined(segments)).toBe(doc);
  });

  it("splits CRLF documents losslessly", () => {
    const doc = "---\r\ntitle: X\r\n---\r\n\r\nbody\r\n";
    const segments = splitMarkdownSegments(doc);
    expect(joined(segments)).toBe(doc);
    expect(segments[0]).toEqual({
      kind: "protected",
      text: "---\r\ntitle: X\r\n---\r\n",
    });
    expect(texts(segments, "translatable")).toEqual(["body\r\n"]);
  });

  it("handles a document mixing every protected block type", () => {
    const doc =
      [
        "---",
        "title: T",
        "---",
        "",
        "# Heading",
        "",
        "```rust",
        "fn main() {}",
        "```",
        "",
        "$$",
        "a^2 + b^2 = c^2",
        "$$",
        "",
        "<!--",
        "hidden",
        "-->",
        "",
        "tail",
      ].join("\n") + "\n";
    const segments = splitMarkdownSegments(doc);
    expect(kinds(segments)).toEqual([
      "protected", // frontmatter
      "protected", // blank
      "translatable", // heading
      "protected", // blank
      "protected", // fence
      "protected", // blank
      "protected", // math
      "protected", // blank
      "protected", // comment
      "protected", // blank
      "translatable", // tail
    ]);
    expect(texts(segments, "translatable")).toEqual(["# Heading\n", "tail\n"]);
    expect(joined(segments)).toBe(doc);
  });
});

describe("subdivideSegment", () => {
  it("returns the text unchanged when it fits the limit", () => {
    const text = "a\nb\n" + "c".repeat(100) + "\n";
    expect(subdivideSegment(text)).toEqual([text]);
    expect(
      subdivideSegment("x".repeat(MAX_TRANSLATABLE_CHUNK_LENGTH)),
    ).toEqual(["x".repeat(MAX_TRANSLATABLE_CHUNK_LENGTH)]);
  });

  it("splits an over-long paragraph along line boundaries", () => {
    const line = "l".repeat(300) + "\n"; // 301 chars
    const text = line.repeat(6); // 1806 chars
    const chunks = subdivideSegment(text);
    // Two lines (602 chars) no longer fit under the 600-char target, so each
    // 301-char line stays intact as its own chunk.
    expect(chunks).toEqual([
      line,
      line,
      line,
      line,
      line,
      line,
    ]);
    expect(chunks.join("")).toBe(text);
  });

  it("splits an over-long single line at sentence boundaries", () => {
    const sentence = "句".repeat(300) + "。"; // 301 chars
    const text = sentence.repeat(5) + "\n"; // 1506 chars
    const chunks = subdivideSegment(text);
    // Two sentences (602 chars) exceed the 600-char target, so each sentence
    // becomes its own chunk and the last one carries the trailing newline.
    expect(chunks).toEqual([
      sentence,
      sentence,
      sentence,
      sentence,
      sentence + "\n",
    ]);
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every(
        (chunk) => chunk.length <= MAX_TRANSLATABLE_CHUNK_LENGTH,
      ),
    ).toBe(true);
  });

  it("hard-splits a sentence longer than the limit as a last resort", () => {
    const text = "x".repeat(5000) + "\n";
    const chunks = subdivideSegment(text);
    expect(chunks).toEqual([
      ...Array.from({ length: 8 }, () => "x".repeat(600)),
      "x".repeat(200) + "\n",
    ]);
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every(
        (chunk) => chunk.length <= MAX_TRANSLATABLE_CHUNK_LENGTH,
      ),
    ).toBe(true);
  });

  it("splits consecutive over-long lines independently", () => {
    const text = "x".repeat(1600) + "\n" + "y".repeat(1700) + "\n";
    expect(subdivideSegment(text)).toEqual([
      "x".repeat(600),
      "x".repeat(600),
      "x".repeat(400) + "\n",
      "y".repeat(600),
      "y".repeat(600),
      "y".repeat(500) + "\n",
    ]);
  });

  it("never hard-splits across a placeholder token", () => {
    // 600-character cuts land inside ⟪1⟫ (positions 595-599) on the first
    // split and directly after ⟫ on the next; both must leave the token whole.
    const text = "x".repeat(598) + "⟪1⟫" + "y".repeat(400);
    const chunks = subdivideSegment(text);
    expect(chunks).toEqual([
      "x".repeat(598),
      "⟪1⟫" + "y".repeat(400),
    ]);
    expect(chunks.join("")).toBe(text);
    // A token ending exactly at the naive cut boundary stays in one chunk too.
    const around = subdivideSegment("x".repeat(597) + "⟪1⟫" + "y".repeat(400));
    expect(around).toEqual([
      "x".repeat(597) + "⟪1⟫",
      "y".repeat(400),
    ]);
    expect(around.join("")).toBe("x".repeat(597) + "⟪1⟫" + "y".repeat(400));
  });

  it("honors an explicit maxLength", () => {
    expect(subdivideSegment("aaaa\nbbbb\ncccc\n", 10)).toEqual([
      "aaaa\nbbbb\n",
      "cccc\n",
    ]);
    expect(subdivideSegment("x".repeat(12), 5)).toEqual([
      "x".repeat(5),
      "x".repeat(5),
      "xx",
    ]);
    expect(subdivideSegment("甲。乙。丙。", 3)).toEqual(["甲。", "乙。", "丙。"]);
  });

  it("is lossless for mixed paragraphs, sentence-split lines and CRLF", () => {
    const text =
      "短行\n" +
      "medium line with text\n".repeat(3) +
      ("句".repeat(600) + "。").repeat(4) +
      "又一段。\n" +
      "结尾\r\n";
    const chunks = subdivideSegment(text);
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every(
        (chunk) => chunk.length <= MAX_TRANSLATABLE_CHUNK_LENGTH,
      ),
    ).toBe(true);
  });
});

describe("reassembleTranslation", () => {
  it("fills translations into translatable segments in order", () => {
    const doc = "para one\n\n```ts\ncode\n```\n\npara two\n";
    const segments = splitMarkdownSegments(doc);
    const result = reassembleTranslation(segments, ["第一段", "第二段"]);
    // Translations replace the whole block, including its trailing newline;
    // `translateDocument` is responsible for restoring line breaks.
    expect(result).toBe("第一段\n```ts\ncode\n```\n\n第二段");
  });

  it("falls back to the original text when a translation is missing", () => {
    const doc = "one\n\ntwo\n";
    const segments = splitMarkdownSegments(doc);
    expect(reassembleTranslation(segments, ["只译一段"])).toBe(
      "只译一段\ntwo\n",
    );
  });
});
