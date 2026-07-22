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
});
