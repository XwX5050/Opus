import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import MarkdownEditor from "./MarkdownEditor";

const renderEditor = (overrides: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) => {
  const props = {
    value: "",
    onChange: vi.fn(),
    onSave: vi.fn(),
    onReopenClosed: vi.fn(),
    sourceMode: true,
    documentPath: "/notes/a.md",
    saveClipboardImage: vi.fn(async () => null),
    resolveImageUrl: (path: string) => `asset://localhost${path}`,
    ...overrides,
  };
  return { props, ...render(<MarkdownEditor {...props} />) };
};

const content = () => screen.getByRole("textbox", { name: "Markdown 编辑器" });
const moveToEnd = () => {
  const element = content();
  element.focus();
  const view = EditorView.findFromDOM(element);
  if (!view) throw new Error("EditorView not found");
  view.dispatch({ selection: { anchor: view.state.doc.length } });
};

const editorView = () => {
  const view = EditorView.findFromDOM(content());
  if (!view) throw new Error("EditorView not found");
  return view;
};

const atomicRanges = (view: EditorView) => {
  const ranges: { from: number; to: number }[] = [];
  for (const provider of view.state.facet(EditorView.atomicRanges)) {
    provider(view).between(0, view.state.doc.length, (from, to) => {
      ranges.push({ from, to });
    });
  }
  return ranges;
};

describe("MarkdownEditor", () => {
  it.each([
    ["- item", "- item\n- "],
    ["> quote", "> quote\n> "],
    ["- ", ""],
  ])("uses Markdown Enter behavior for %s", async (before, after) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderEditor({ value: before, onChange });
    moveToEnd();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(after);
  });

  it("runs save and reopen callbacks exactly once from editor keymaps", async () => {
    const user = userEvent.setup();
    const { props } = renderEditor();
    content().focus();
    await user.keyboard("{Control>}s{/Control}");
    await user.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    expect(props.onSave).toHaveBeenCalledOnce();
    expect(props.onReopenClosed).toHaveBeenCalledOnce();
  });

  it("updates callback refs and controlled value without rebuilding or adding undo history", async () => {
    const user = userEvent.setup();
    const firstSave = vi.fn();
    const secondSave = vi.fn();
    const onChange = vi.fn();
    const view = renderEditor({ value: "one", onSave: firstSave, onChange });
    const root = view.container.querySelector(".cm-editor");
    view.rerender(<MarkdownEditor {...view.props} value="external" onSave={secondSave} />);
    expect(view.container.querySelector(".cm-editor")).toBe(root);
    expect(content()).toHaveTextContent("external");
    expect(onChange).not.toHaveBeenCalled();
    content().focus();
    await user.keyboard("{Control>}s{/Control}");
    await user.keyboard("{Control>}z{/Control}");
    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).toHaveBeenCalledOnce();
    expect(content()).toHaveTextContent("external");
  });

  it("destroys its EditorView on unmount", () => {
    const destroy = vi.spyOn(EditorView.prototype, "destroy");
    const view = renderEditor();
    view.unmount();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("starts without live preview when sourceMode is true", () => {
    renderEditor({ value: "**world** rest", sourceMode: true });
    moveToEnd();
    expect(content().textContent).toContain("**world**");
    expect(document.querySelector(".cm-live-preview-strong")).toBeNull();
  });

  it("toggles live preview in the same view without changing selection or firing onChange", () => {
    const onChange = vi.fn();
    const rendered = renderEditor({ value: "**world** rest", sourceMode: false, onChange });
    moveToEnd();
    const root = rendered.container.querySelector(".cm-editor");
    const view = editorView();
    const selection = view.state.selection;
    expect(content().textContent).not.toContain("**");
    expect(atomicRanges(view)).not.toHaveLength(0);

    rendered.rerender(<MarkdownEditor {...rendered.props} sourceMode />);
    expect(rendered.container.querySelector(".cm-editor")).toBe(root);
    expect(editorView()).toBe(view);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(content().textContent).toContain("**world**");
    expect(atomicRanges(view)).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();

    rendered.rerender(<MarkdownEditor {...rendered.props} sourceMode={false} />);
    expect(editorView()).toBe(view);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(content().textContent).not.toContain("**");
    expect(atomicRanges(view)).not.toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves undo history across sourceMode toggles", async () => {
    const user = userEvent.setup();
    const rendered = renderEditor({ value: "text", sourceMode: false });
    moveToEnd();
    await user.keyboard("!");
    expect(editorView().state.doc.toString()).toBe("text!");

    rendered.rerender(<MarkdownEditor {...rendered.props} sourceMode />);
    await user.keyboard("{Control>}z{/Control}");
    expect(editorView().state.doc.toString()).toBe("text");
  });

  it("toggles math widgets and both Markdown/math atomic ranges in the same view", () => {
    const value = "$x$ and **bold** outside";
    const rendered = renderEditor({ value, sourceMode: false });
    moveToEnd();
    const view = editorView();
    const root = rendered.container.querySelector(".cm-editor");

    expect(document.querySelector(".md-math .katex")).not.toBeNull();
    expect(atomicRanges(view)).toContainEqual({ from: 0, to: 3 });
    expect(atomicRanges(view)).toContainEqual({ from: 8, to: 10 });

    rendered.rerender(<MarkdownEditor {...rendered.props} sourceMode />);
    expect(editorView()).toBe(view);
    expect(rendered.container.querySelector(".cm-editor")).toBe(root);
    expect(document.querySelector(".md-math")).toBeNull();
    expect(content()).toHaveTextContent("$x$");
    expect(atomicRanges(view)).toEqual([]);

    rendered.rerender(<MarkdownEditor {...rendered.props} sourceMode={false} />);
    expect(editorView()).toBe(view);
    expect(document.querySelector(".md-math .katex")).not.toBeNull();
    expect(atomicRanges(view)).toContainEqual({ from: 0, to: 3 });
    expect(atomicRanges(view)).toContainEqual({ from: 8, to: 10 });
  });

  it("keeps source revealed when preview is toggled during composition", () => {
    const rendered = renderEditor({ value: "**world** rest", sourceMode: false });
    moveToEnd();
    content().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(content()).toHaveTextContent("**world**");

    rendered.rerender(<MarkdownEditor {...rendered.props} sourceMode />);
    rendered.rerender(<MarkdownEditor {...rendered.props} sourceMode={false} />);
    expect(content()).toHaveTextContent("**world**");

    content().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(content()).not.toHaveTextContent("**");
  });
});
