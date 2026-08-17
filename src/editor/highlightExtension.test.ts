import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import {
  Highlight,
  highlightMarkdownExtension,
} from "./highlightExtension";

const parse = (doc: string) => {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ extensions: [GFM, highlightMarkdownExtension] }),
    ],
  });
  // The language field's initial parse runs under a short wall-clock budget
  // (20ms) and is never resumed without a view — under heavy CI load a starved
  // worker can exhaust that budget before one scheduling quantum, leaving a
  // partial tree. Complete the parse and fold it back into the state so
  // syntaxTree(state) is whole.
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({}).state;
};

const nodesNamed = (state: EditorState, name: string) => {
  const nodes: { from: number; to: number; source: string }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === name) {
        nodes.push({
          from: node.from,
          to: node.to,
          source: state.sliceDoc(node.from, node.to),
        });
      }
    },
  });
  return nodes;
};

describe("highlightMarkdownExtension", () => {
  it("adds exact Highlight ranges for Unicode and adjacent highlights", () => {
    const state = parse("中文 ==重点==，==相邻==");

    expect(nodesNamed(state, Highlight)).toEqual([
      { from: 3, to: 9, source: "==重点==" },
      { from: 10, to: 16, source: "==相邻==" },
    ]);
  });

  it.each([
    ["escaped opening delimiter", String.raw`\==escaped==`],
    ["escaped closing delimiter", String.raw`==escaped\==`],
    ["empty delimiters", "===="],
    ["triple delimiters", "===text==="],
    ["space after opener", "== text=="],
    ["space before closer", "==text =="],
    ["unclosed highlight", "before ==text after"],
    ["multiline highlight", "==first\nsecond=="],
  ])("does not parse %s", (_label, doc) => {
    expect(nodesNamed(parse(doc), Highlight)).toEqual([]);
  });

  it("leaves delimiters inside inline and fenced code outside highlight nodes", () => {
    const doc = [
      "`==inline==`",
      "",
      "```txt",
      "==fenced==",
      "```",
      "",
      "==real==",
    ].join("\n");

    expect(nodesNamed(parse(doc), Highlight).map(({ source }) => source)).toEqual([
      "==real==",
    ]);
  });

  it("parses nested inline Markdown inside the highlighted content", () => {
    const tree = syntaxTree(parse("==**bold** and [link](url)==")).toString();

    expect(tree).toContain(
      "Highlight(HighlightMark,StrongEmphasis",
    );
    expect(tree).toContain("Link(");
  });
});
