import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import {
  BlockMath,
  InlineMath,
  mathMarkdownExtension,
} from "./mathExtension";

const parse = (doc: string) =>
  EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM, mathMarkdownExtension] })],
  });

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

describe("mathMarkdownExtension", () => {
  it("adds real InlineMath nodes with exact ranges for multiple adjacent and Unicode formulas", () => {
    const doc = "中文 $x^2$，$α+β$$y$ end";
    const state = parse(doc);

    expect(nodesNamed(state, InlineMath)).toEqual([
      { from: 3, to: 8, source: "$x^2$" },
      { from: 9, to: 14, source: "$α+β$" },
      { from: 14, to: 17, source: "$y$" },
    ]);
  });

  it.each([
    ["escaped delimiter", String.raw`price \$x$`],
    ["empty delimiters", "empty $$ here"],
    ["unclosed formula", "before $x^2 after"],
    ["space after opener", "$ x$"],
    ["space before closer", "$x $"],
    ["adjacent currency", "$5 and $6"],
    ["currency suffix", "US$5"],
    ["inline double dollars", "before $$x$$ after"],
    ["leading double dollars", "$$x$$"],
    ["embedded double dollars", "a$$x$$b"],
    ["CJK price list", "价格 $5/件，$6/件"],
    ["CJK price range", "机器$5到$10元"],
    ["CJK price with unit", "价格$5元，优惠到$6元"],
    ["math before CJK unit", "每件商品$x$元"],
    ["math before digit", "$x$5"],
  ])("does not parse %s as inline math", (_label, doc) => {
    expect(nodesNamed(parse(doc), InlineMath)).toEqual([]);
  });

  it("parses adjacent formulas with touching delimiters", () => {
    const doc = "$x$$y$";
    const state = parse(doc);

    expect(nodesNamed(state, InlineMath)).toEqual([
      { from: 0, to: 3, source: "$x$" },
      { from: 3, to: 6, source: "$y$" },
    ]);
  });

  it("keeps math closed before CJK punctuation", () => {
    const doc = "$x^2$。好";
    const state = parse(doc);

    expect(nodesNamed(state, InlineMath)).toEqual([
      { from: 0, to: 5, source: "$x^2$" },
    ]);
  });

  it("leaves dollar signs inside code spans and fenced code outside math nodes", () => {
    const doc = ["`$inline$`", "", "```txt", "$fenced$", "```", "", "$real$"].join("\n");
    const state = parse(doc);

    expect(nodesNamed(state, InlineMath).map(({ source }) => source)).toEqual(["$real$"]);
  });

  it("adds a real multiline BlockMath node only for independent delimiter lines", () => {
    const doc = ["before", "", "  $$  ", "x^2 +", "y^2", "\t$$", "", "after"].join("\n");
    const state = parse(doc);
    const from = doc.indexOf("$$");
    const to = doc.indexOf("$$", from + 2) + 2;

    expect(nodesNamed(state, BlockMath)).toEqual([
      { from, to, source: doc.slice(from, to) },
    ]);
  });

  it.each([
    ["blank lines", "$$\na\n\nb\n$$"],
    ["list-like lines", "$$\na\n- item\nb\n$$"],
    ["quote-like lines", "$$\na\n> quote\nb\n$$"],
  ])("keeps %s inside one BlockMath node", (_label, doc) => {
    const nodes = nodesNamed(parse(doc), BlockMath);
    expect(nodes).toEqual([{ from: 0, to: doc.length, source: doc }]);
  });

  it.each([
    ["unclosed block", "before\n\n$$\nx^2"],
    ["non-independent opener", "before $$\nx^2\n$$"],
    ["non-independent closer", "$$\nx^2\n$$ after"],
    ["inline double dollars", "$$x$$"],
    ["fenced block", "```\n$$\nx\n$$\n```"],
  ])("does not create BlockMath for %s", (_label, doc) => {
    expect(nodesNamed(parse(doc), BlockMath)).toEqual([]);
  });
});
