import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { editorExtensions } from "./editorExtensions";

describe("editorExtensions", () => {
  it("parses GFM, math, and highlights in the single production Markdown tree", () => {
    const state = EditorState.create({
      doc: "~~done~~ and $x^2$ and ==重点==",
      extensions: [
        editorExtensions({ onSave: vi.fn(), onReopenClosed: vi.fn(), onToggleReading: vi.fn() }),
      ],
    });

    const tree = syntaxTree(state).toString();
    expect(tree).toContain("Strikethrough");
    expect(tree).toContain("InlineMath");
    expect(tree).toContain("Highlight(HighlightMark");
  });
});
