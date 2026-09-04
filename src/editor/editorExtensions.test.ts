import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  codeBlockAutoCloseBackspace,
  codeBlockAutoCloseInput,
} from "./codeBlockAutoClose";
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

  it("wires the code-block typing assists with Backspace ahead of markdown/default keymaps", () => {
    const state = EditorState.create({
      doc: "",
      extensions: [
        editorExtensions({ onSave: vi.fn(), onReopenClosed: vi.fn(), onToggleReading: vi.fn() }),
      ],
    });

    expect(state.facet(EditorView.inputHandler)).toContain(codeBlockAutoCloseInput);
    // The first Backspace binding must be the code-block pair deletion, not
    // markdownKeymap's deleteMarkupBackward or defaultKeymap's
    // deleteCharBackward — both also bind Backspace.
    expect(
      state
        .facet(keymap)
        .flat()
        .find((binding) => binding.key === "Backspace"),
    ).toEqual({ key: "Backspace", run: codeBlockAutoCloseBackspace });
  });
});
