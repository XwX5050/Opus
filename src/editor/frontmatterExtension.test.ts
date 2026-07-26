import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { frontmatterMarkdownExtension } from "./frontmatterExtension";
import {
  hiddenFrontmatterDecorations,
  livePreviewExtension,
  planLivePreview,
} from "./livePreview";

const createState = (doc: string) =>
  EditorState.create({
    doc,
    extensions: [
      markdown({ extensions: [GFM, frontmatterMarkdownExtension] }),
    ],
  });

const treeString = (state: EditorState) => syntaxTree(state).toString();

describe("frontmatterMarkdownExtension", () => {
  it("parses leading YAML frontmatter as a FrontMatter node, not a setext heading", () => {
    const doc = "---\ndate: 2026-04-10T00:51:00\n---\n\n# Title\n";
    const state = createState(doc);
    const tree = treeString(state);
    expect(tree).toContain("FrontMatter");
    expect(tree).not.toContain("SetextHeading");
  });

  it("covers the full frontmatter block including both delimiters", () => {
    const doc = "---\ndate: 2026-04-10T00:51:00\n---\nbody\n";
    const state = createState(doc);
    const node = syntaxTree(state).topNode.getChild("FrontMatter");
    expect(node).not.toBeNull();
    expect(node!.from).toBe(0);
    expect(state.sliceDoc(node!.from, node!.to)).toBe(
      "---\ndate: 2026-04-10T00:51:00\n---",
    );
  });

  it("accepts `...` as the closing delimiter", () => {
    const state = createState("---\ntitle: hi\n...\nbody\n");
    expect(treeString(state)).toContain("FrontMatter");
  });

  it("parses empty frontmatter without crashing", () => {
    const state = createState("---\n---\nbody\n");
    expect(treeString(state)).toContain("FrontMatter");
  });

  it("does not treat an unclosed opening delimiter as frontmatter", () => {
    const state = createState("---\ntext without closing delimiter\n");
    expect(treeString(state)).not.toContain("FrontMatter");
  });

  it("leaves a mid-document `---` after a paragraph as a setext heading", () => {
    const state = createState("some paragraph\n---\n");
    const tree = treeString(state);
    expect(tree).not.toContain("FrontMatter");
    expect(tree).toContain("SetextHeading");
  });

  it("leaves a mid-document `---` after a blank line as a horizontal rule", () => {
    const state = createState("text\n\n---\n");
    const tree = treeString(state);
    expect(tree).not.toContain("FrontMatter");
    expect(tree).toContain("HorizontalRule");
  });
});

describe("frontmatter live preview", () => {
  const doc = "---\ndate: 2026-04-10T00:51:00\n---\n\n# Title\n";

  it("marks frontmatter as muted metadata in editing mode", () => {
    const state = createState(doc);
    const plan = planLivePreview(state);
    const marks = plan.filter(
      (item) =>
        item.kind === "mark" && item.className === "cm-live-preview-frontmatter",
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].from).toBe(0);
  });

  it("computes a hidden range covering the whole block plus its trailing newline", () => {
    const state = createState(doc);
    const decorations = hiddenFrontmatterDecorations(state);
    const ranges: { from: number; to: number }[] = [];
    decorations.between(0, state.doc.length, (from, to) => {
      ranges.push({ from, to });
    });
    // The node ends after the closing `---` (33); the swallowed trailing
    // newline extends the hidden range to 34, leaving the blank line that
    // follows the frontmatter untouched.
    expect(ranges).toEqual([{ from: 0, to: 34 }]);
  });

  it("plans no hidden range for a mid-document horizontal rule", () => {
    const state = createState("text\n\n---\n");
    expect(hiddenFrontmatterDecorations(state)).toBe(Decoration.none);
  });

  const createView = (options?: { revealSelection: boolean }) => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ extensions: [GFM, frontmatterMarkdownExtension] }),
        livePreviewExtension(options),
      ],
    });
    return new EditorView({ state, parent });
  };

  it("renders frontmatter muted but visible in editing mode", () => {
    const view = createView();
    expect(view.dom.querySelector(".cm-live-preview-frontmatter")).not.toBeNull();
    expect(view.contentDOM.textContent).toContain("date: 2026-04-10T00:51:00");
    view.destroy();
  });

  it("hides frontmatter entirely in reading mode without throwing", () => {
    const view = createView({ revealSelection: false });
    expect(view.contentDOM.textContent).not.toContain("date: 2026-04-10T00:51:00");
    expect(view.contentDOM.textContent).toContain("Title");
    view.destroy();
  });
});
