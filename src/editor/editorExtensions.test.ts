import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  codeBlockAutoCloseBackspace,
  codeBlockAutoCloseInput,
} from "./codeBlockAutoClose";
import {
  editorExtensions,
  markdownLanguageExtension,
} from "./editorExtensions";

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

  it("keeps the core grammar free of heavy extensions but parses frontmatter", () => {
    const state = EditorState.create({
      doc: "---\ntitle: note\n---\n\n# Heading\n\n~~done~~ and $x^2$ and ==重点==",
      extensions: [
        editorExtensions(
          { onSave: vi.fn(), onReopenClosed: vi.fn(), onToggleReading: vi.fn() },
          [],
          markdownLanguageExtension("core"),
        ),
      ],
    });

    const tree = syntaxTree(state).toString();
    expect(tree).toContain("FrontMatter");
    expect(tree).toContain("ATXHeading");
    expect(tree).not.toContain("SetextHeading");
    expect(tree).not.toContain("Strikethrough");
    expect(tree).not.toContain("InlineMath");
    expect(tree).not.toContain("Highlight");
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

  it("localizes every search panel phrase, including announcements", () => {
    const state = EditorState.create({
      doc: "",
      extensions: [
        editorExtensions({ onSave: vi.fn(), onReopenClosed: vi.fn(), onToggleReading: vi.fn() }),
      ],
    });

    expect({
      Find: state.phrase("Find"),
      Replace: state.phrase("Replace"),
      next: state.phrase("next"),
      previous: state.phrase("previous"),
      all: state.phrase("all"),
      "match case": state.phrase("match case"),
      regexp: state.phrase("regexp"),
      "by word": state.phrase("by word"),
      replace: state.phrase("replace"),
      "replace all": state.phrase("replace all"),
      close: state.phrase("close"),
      "Go to line": state.phrase("Go to line"),
      go: state.phrase("go"),
    }).toEqual({
      Find: "查找",
      Replace: "替换",
      next: "下一个",
      previous: "上一个",
      all: "全选",
      "match case": "区分大小写",
      regexp: "正则表达式",
      "by word": "全字匹配",
      replace: "替换",
      "replace all": "全部替换",
      close: "关闭",
      "Go to line": "跳转到行",
      go: "转到",
    });
    expect(state.phrase("current match")).toBe("当前匹配");
    expect(state.phrase("on line")).toBe("，行号");
    expect(state.phrase("replaced match on line $", 7)).toBe(
      "已替换第 7 行的匹配",
    );
    expect(state.phrase("replaced $ matches", 3)).toBe("已替换 3 处匹配");
  });
});
