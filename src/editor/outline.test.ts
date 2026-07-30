import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  collectOutlineIds,
  collectOutlineParentIds,
  extractOutline,
} from "./outline";

const stateFor = (doc: string) =>
  EditorState.create({ doc, extensions: [markdown()] });

describe("outline extraction", () => {
  it("builds hierarchy from ATX and Setext headings while allowing skipped levels", () => {
    const source = [
      "# Alpha *one*",
      "## Child",
      "#### Skipped",
      "## Child",
      "#",
      "Setext title",
      "=============",
    ].join("\n");

    const headings = extractOutline(stateFor(source));

    expect(headings.map((heading) => heading.text)).toEqual([
      "Alpha *one*",
      "无标题",
      "Setext title",
    ]);
    expect(headings[0].children.map((heading) => heading.text)).toEqual([
      "Child",
      "Child",
    ]);
    expect(headings[0].children[0].children.map((heading) => heading.text)).toEqual([
      "Skipped",
    ]);
    expect(headings[0].children[0].level).toBe(2);
    expect(headings[0].children[0].children[0].level).toBe(4);
  });

  it("keeps duplicates distinct and positions navigation at heading text", () => {
    const source = "# Alpha\n## Child\n## Child\n#\n";
    const headings = extractOutline(stateFor(source));
    const children = headings[0].children;

    expect(children[0].id).not.toBe(children[1].id);
    expect(source.slice(headings[0].textFrom, headings[0].textFrom + 5)).toBe("Alpha");
    expect(headings[0].from).toBe(0);
    expect(headings[1].text).toBe("无标题");
    expect(headings[1].textFrom).toBe(source.lastIndexOf("#") + 1);
  });

  it("excludes heading-like content inside fenced and indented code", () => {
    const source = [
      "# Real",
      "",
      "```md",
      "# fenced fake",
      "```",
      "",
      "    # indented fake",
      "",
      "## Also real",
    ].join("\n");

    const headings = extractOutline(stateFor(source));

    expect(headings.map((heading) => heading.text)).toEqual(["Real"]);
    expect(headings[0].children.map((heading) => heading.text)).toEqual([
      "Also real",
    ]);
  });

  it("keeps IDs stable when plain text is inserted before headings", () => {
    const source = "# Alpha\n## Child\n### Grandchild\n";
    const before = extractOutline(stateFor(source));
    const after = extractOutline(stateFor(`plain paragraph\n\n${source}`));

    expect([...collectOutlineIds(after)]).toEqual([...collectOutlineIds(before)]);
    expect([...collectOutlineParentIds(before)]).toEqual([
      before[0].id,
      before[0].children[0].id,
    ]);
  });
});
