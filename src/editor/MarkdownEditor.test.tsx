import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import MarkdownEditor from "./MarkdownEditor";

const renderEditor = (overrides: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) => {
  const props = {
    value: "",
    onChange: vi.fn(),
    onSave: vi.fn(),
    onReopenClosed: vi.fn(),
    onToggleReading: vi.fn(),
    viewMode: "editing" as const,
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

  it("runs the view-mode toggle callback from the editor keymap", async () => {
    const user = userEvent.setup();
    const { props } = renderEditor();
    content().focus();
    await user.keyboard("{Control>}e{/Control}");
    expect(props.onToggleReading).toHaveBeenCalledOnce();
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

  it("publishes the parsed outline through the editor callback", async () => {
    const onOutlineChange = vi.fn();
    renderEditor({ value: "# Alpha\n## Child", onOutlineChange });

    await waitFor(() => expect(onOutlineChange).toHaveBeenCalled());

    const headings = onOutlineChange.mock.calls.at(-1)?.[0];
    expect(headings[0].text).toBe("Alpha");
    expect(headings[0].children[0].text).toBe("Child");
  });

  it("moves selection and focus for a new editing-mode outline request", () => {
    const onChange = vi.fn();
    const rendered = renderEditor({
      value: "# Alpha\n\ntext",
      onChange,
      outlineNavigation: null,
    });
    const view = editorView();
    const historyBefore = undoDepth(view.state);

    rendered.rerender(
      <MarkdownEditor
        {...rendered.props}
        outlineNavigation={{ sequence: 1, from: 0, textFrom: 2 }}
      />,
    );

    expect(view.state.selection.main.head).toBe(2);
    expect(document.activeElement).toBe(content());
    expect(view.state.doc.toString()).toBe("# Alpha\n\ntext");
    expect(undoDepth(view.state)).toBe(historyBefore);
    expect(onChange).not.toHaveBeenCalled();

    view.dispatch({ selection: { anchor: 9 } });
    rendered.rerender(
      <MarkdownEditor
        {...rendered.props}
        outlineNavigation={{ sequence: 1, from: 0, textFrom: 2 }}
      />,
    );
    expect(view.state.selection.main.head).toBe(9);

    rendered.rerender(
      <MarkdownEditor
        {...rendered.props}
        outlineNavigation={{ sequence: 2, from: 0, textFrom: 2 }}
      />,
    );
    expect(view.state.selection.main.head).toBe(2);
  });

  it("only scrolls for reading-mode outline navigation", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const scrollIntoView = vi.spyOn(EditorView, "scrollIntoView");
    const rendered = renderEditor({
      value: "# Alpha\n\ntext",
      viewMode: "reading",
      outlineNavigation: null,
    });
    const view = editorView();
    view.dispatch({ selection: { anchor: 9 } });
    outside.focus();

    rendered.rerender(
      <MarkdownEditor
        {...rendered.props}
        viewMode="reading"
        outlineNavigation={{ sequence: 1, from: 0, textFrom: 2 }}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith(0, {
      y: "start",
      yMargin: 24,
    });
    expect(view.state.selection.main.head).toBe(9);
    expect(document.activeElement).toBe(outside);
    expect(view.state.doc.toString()).toBe("# Alpha\n\ntext");

    outside.remove();
    scrollIntoView.mockRestore();
  });

  it("toggles between editing and reading in the same view without changing selection or firing onChange", () => {
    const onChange = vi.fn();
    const rendered = renderEditor({ value: "**world** rest", viewMode: "editing", onChange });
    moveToEnd();
    const root = rendered.container.querySelector(".cm-editor");
    const view = editorView();
    const selection = view.state.selection;
    expect(content().textContent).not.toContain("**");
    expect(atomicRanges(view)).not.toHaveLength(0);

    rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="reading" />);
    expect(rendered.container.querySelector(".cm-editor")).toBe(root);
    expect(editorView()).toBe(view);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(content()).toHaveAttribute("contenteditable", "false");
    expect(content().textContent).not.toContain("**");
    expect(onChange).not.toHaveBeenCalled();

    rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="editing" />);
    expect(editorView()).toBe(view);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(content()).toHaveAttribute("contenteditable", "true");
    expect(content().textContent).not.toContain("**");
    expect(atomicRanges(view)).not.toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves undo history across view mode toggles", async () => {
    const user = userEvent.setup();
    const rendered = renderEditor({ value: "text", viewMode: "editing" });
    moveToEnd();
    await user.keyboard("!");
    expect(editorView().state.doc.toString()).toBe("text!");

    rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="reading" />);
    rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="editing" />);
    await user.keyboard("{Control>}z{/Control}");
    expect(editorView().state.doc.toString()).toBe("text");
  });

  describe("reading mode", () => {
    it("renders fully without revealing markers under the cursor", () => {
      const rendered = renderEditor({
        value: "$x$ and **world** rest\n\n![img](/p/pic.png)",
        viewMode: "reading",
      });
      // Cursor inside the strong node: markers stay hidden anyway.
      const view = editorView();
      view.dispatch({ selection: { anchor: 9 } });
      expect(content().textContent).not.toContain("**");
      expect(rendered.container.querySelector(".cm-live-preview-strong")).not.toBeNull();
      // Widgets still render: reading mode is fully rendered, not light mode.
      expect(rendered.container.querySelector(".md-math")).not.toBeNull();
      expect(rendered.container.querySelector(".md-image-widget")).not.toBeNull();
      expect(rendered.container.querySelector(".markdown-editor")).toHaveAttribute(
        "data-view-mode",
        "reading",
      );
    });

    it("is not editable and rejects typing without firing onChange", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderEditor({ value: "**world** rest", viewMode: "reading", onChange });
      expect(content()).toHaveAttribute("contenteditable", "false");
      content().focus();
      await user.keyboard("x");
      expect(editorView().state.doc.toString()).toBe("**world** rest");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("keeps math and image widgets mounted when the selection touches them", () => {
      const rendered = renderEditor({
        value: "$x$ and **world**\n\n![img](/p/pic.png)",
        viewMode: "reading",
      });
      const view = editorView();

      // Cursor inside the formula: the widget must not flip to raw $…$.
      view.dispatch({ selection: { anchor: 1 } });
      expect(rendered.container.querySelector(".md-math")).not.toBeNull();
      expect(content().textContent).not.toContain("$x$");

      // Cursor inside the image syntax: same guarantee for image widgets.
      view.dispatch({ selection: { anchor: 20 } });
      expect(rendered.container.querySelector(".md-image-widget")).not.toBeNull();
      expect(content().textContent).not.toContain("![img]");
    });

    it("switches between both modes in the same view and keeps undo history", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const rendered = renderEditor({ value: "**world** rest", viewMode: "editing", onChange });
      const view = editorView();
      const root = rendered.container.querySelector(".cm-editor");
      moveToEnd();
      await user.keyboard("!");
      expect(view.state.doc.toString()).toBe("**world** rest!");

      rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="reading" />);
      expect(editorView()).toBe(view);
      expect(rendered.container.querySelector(".cm-editor")).toBe(root);
      expect(content()).toHaveAttribute("contenteditable", "false");
      expect(content().textContent).not.toContain("**");

      rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="editing" />);
      expect(editorView()).toBe(view);
      expect(content()).toHaveAttribute("contenteditable", "true");
      expect(content().textContent).not.toContain("**");
      const changeCalls = onChange.mock.calls.length;
      await user.keyboard("{Control>}z{/Control}");
      expect(view.state.doc.toString()).toBe("**world** rest");

      rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="reading" />);
      expect(editorView()).toBe(view);
      // Mode switches reconfigure decorations only; they never emit changes.
      expect(onChange.mock.calls.length).toBe(changeCalls + 1);
    });
  });

  it("toggles math widgets and their atomic ranges in the same view", () => {
    const value = "$x$ and **bold** outside";
    const rendered = renderEditor({ value, viewMode: "editing" });
    moveToEnd();
    const view = editorView();
    const root = rendered.container.querySelector(".cm-editor");

    expect(document.querySelector(".md-math .katex")).not.toBeNull();
    expect(atomicRanges(view)).toContainEqual({ from: 0, to: 3 });
    expect(atomicRanges(view)).toContainEqual({ from: 8, to: 10 });

    rendered.rerender(<MarkdownEditor {...rendered.props} performanceMode="light" />);
    expect(editorView()).toBe(view);
    expect(rendered.container.querySelector(".cm-editor")).toBe(root);
    expect(document.querySelector(".md-math")).toBeNull();
    expect(content()).toHaveTextContent("$x$");
    expect(atomicRanges(view)).not.toContainEqual({ from: 0, to: 3 });

    rendered.rerender(<MarkdownEditor {...rendered.props} performanceMode="full" />);
    expect(editorView()).toBe(view);
    expect(document.querySelector(".md-math .katex")).not.toBeNull();
    expect(atomicRanges(view)).toContainEqual({ from: 0, to: 3 });
    expect(atomicRanges(view)).toContainEqual({ from: 8, to: 10 });
  });

  it("keeps source revealed when preview is toggled during composition", () => {
    const rendered = renderEditor({ value: "**world** rest", viewMode: "editing" });
    moveToEnd();
    content().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(content()).toHaveTextContent("**world**");

    rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="reading" />);
    rendered.rerender(<MarkdownEditor {...rendered.props} viewMode="editing" />);
    expect(content()).toHaveTextContent("**world**");

    content().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(content()).not.toHaveTextContent("**");
  });

  it("inserts a native image drop once, escapes it, and reports the change", () => {
    const onChange = vi.fn();
    const rendered = renderEditor({ value: "hello", onChange });
    const drop = { sequence: 1, paths: ["/p/pic one.png"], x: 0, y: 0 };

    rendered.rerender(<MarkdownEditor {...rendered.props} imageDrop={drop} />);
    expect(editorView().state.doc.toString()).toBe("![image](</p/pic one.png>)hello");
    expect(onChange).toHaveBeenCalledWith("![image](</p/pic one.png>)hello");

    // The same drop (same sequence) must not be inserted twice.
    rendered.rerender(<MarkdownEditor {...rendered.props} imageDrop={{ ...drop }} />);
    expect(editorView().state.doc.toString()).toBe("![image](</p/pic one.png>)hello");

    // A newer drop is inserted (jsdom has no layout; posAtCoords yields 0).
    rendered.rerender(
      <MarkdownEditor {...rendered.props} imageDrop={{ sequence: 2, paths: ["/q/x.png"], x: 0, y: 0 }} />,
    );
    expect(editorView().state.doc.toString()).toBe("![image](/q/x.png)![image](</p/pic one.png>)hello");
  });

  it("ignores an image drop that predates the editor mount", () => {
    renderEditor({
      value: "hello",
      imageDrop: { sequence: 1, paths: ["/p/pic.png"], x: 0, y: 0 },
    });
    expect(editorView().state.doc.toString()).toBe("hello");
  });

  it("ignores a native image drop delivered in reading mode and accepts drops after switching back", () => {
    const onChange = vi.fn();
    const rendered = renderEditor({ value: "hello", viewMode: "reading", onChange });

    rendered.rerender(
      <MarkdownEditor
        {...rendered.props}
        imageDrop={{ sequence: 1, paths: ["/p/pic.png"], x: 0, y: 0 }}
      />,
    );
    expect(editorView().state.doc.toString()).toBe("hello");
    expect(onChange).not.toHaveBeenCalled();

    // Drops land again once the same view is editable.
    rendered.rerender(
      <MarkdownEditor
        {...rendered.props}
        viewMode="editing"
        imageDrop={{ sequence: 2, paths: ["/q/x.png"], x: 0, y: 0 }}
      />,
    );
    expect(editorView().state.doc.toString()).toBe("![image](/q/x.png)hello");
    expect(onChange).toHaveBeenCalledWith("![image](/q/x.png)hello");
  });

  describe("light performance mode", () => {
    // Cursor (moved to the end) must not touch the math/image ranges:
    // widgets reveal their Markdown source while the selection overlaps them.
    const rich = "$x$ and ![img](/p/pic.png)\n\n**bold** tail";

    it("keeps live preview styling but disables math and image widgets without touching text", () => {
      const onChange = vi.fn();
      renderEditor({ value: rich, viewMode: "editing", performanceMode: "light", onChange });
      moveToEnd();
      expect(document.querySelector(".cm-live-preview-strong")).not.toBeNull();
      expect(document.querySelector(".md-math")).toBeNull();
      expect(document.querySelector(".md-image-widget")).toBeNull();
      expect(editorView().state.doc.toString()).toBe(rich);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("switches between light and full in the same view without changing the document", () => {
      const onChange = vi.fn();
      const rendered = renderEditor({ value: rich, viewMode: "editing", performanceMode: "light", onChange });
      moveToEnd();
      const view = editorView();
      const root = rendered.container.querySelector(".cm-editor");
      expect(document.querySelector(".md-math")).toBeNull();

      rendered.rerender(<MarkdownEditor {...rendered.props} performanceMode="full" />);
      expect(editorView()).toBe(view);
      expect(rendered.container.querySelector(".cm-editor")).toBe(root);
      expect(document.querySelector(".md-math")).not.toBeNull();
      expect(document.querySelector(".md-image-widget")).not.toBeNull();
      expect(view.state.doc.toString()).toBe(rich);

      rendered.rerender(<MarkdownEditor {...rendered.props} performanceMode="light" />);
      expect(editorView()).toBe(view);
      expect(document.querySelector(".md-math")).toBeNull();
      expect(document.querySelector(".md-image-widget")).toBeNull();
      expect(view.state.doc.toString()).toBe(rich);
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
