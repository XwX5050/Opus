import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
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
const editorView = () => {
  const view = EditorView.findFromDOM(content());
  if (!view) throw new Error("EditorView not found");
  return view;
};
const panel = () => document.querySelector(".cm-panel.cm-search");
const searchField = () =>
  panel()?.querySelector<HTMLInputElement>('input[name="search"]') ?? null;
const replaceField = () =>
  panel()?.querySelector<HTMLInputElement>('input[name="replace"]') ?? null;
const panelButton = (name: string) => {
  const button = panel()?.querySelector<HTMLButtonElement>(`button[name="${name}"]`);
  if (!button) throw new Error(`panel button ${name} not found`);
  return button;
};
const panelCheckbox = (name: string) => {
  const checkbox = panel()?.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!checkbox) throw new Error(`panel checkbox ${name} not found`);
  return checkbox;
};

// user-event dispatches keydown with keyCode 0, but the search panel's Enter
// handling reads the legacy keyCode. Dispatch a browser-like event instead.
const pressEnter = (field: HTMLElement) => {
  fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });
};

describe("document search", () => {
  it("opens the search panel at the top with the search field focused on Mod-f", async () => {
    const user = userEvent.setup();
    renderEditor({ value: "**bold** plain" });
    content().focus();
    await user.keyboard("{Control>}f{/Control}");

    expect(
      document.querySelector(".cm-panels-top .cm-panel.cm-search"),
    ).not.toBeNull();
    expect(searchPanelOpen(editorView().state)).toBe(true);
    expect(document.activeElement).toBe(searchField());
  });

  it("opens the panel and focuses the replace field on Mod-Alt-f", async () => {
    const user = userEvent.setup();
    renderEditor({ value: "foo bar" });
    content().focus();
    await user.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");

    expect(panel()).not.toBeNull();
    expect(searchPanelOpen(editorView().state)).toBe(true);
    expect(document.activeElement).toBe(replaceField());
  });

  it("searches raw Markdown source, including markers hidden by live preview", async () => {
    const user = userEvent.setup();
    renderEditor({ value: "see **bold** here", sourceMode: false });
    const view = editorView();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(content().textContent).not.toContain("**");

    content().focus();
    await user.keyboard("{Control>}f{/Control}");
    await user.keyboard("**");
    pressEnter(searchField()!);

    const { from, to } = editorView().state.selection.main;
    expect([from, to]).toEqual([4, 6]);
    expect(editorView().state.sliceDoc(from, to)).toBe("**");
  });

  it("honors the match-case toggle", async () => {
    const user = userEvent.setup();
    renderEditor({ value: "bold Bold bold" });
    content().focus();
    await user.keyboard("{Control>}f{/Control}");
    await user.keyboard("bold");

    await user.click(panelButton("select"));
    expect(editorView().state.selection.ranges).toHaveLength(3);

    await user.click(panelCheckbox("case"));
    expect(getSearchQuery(editorView().state).caseSensitive).toBe(true);
    await user.click(panelButton("select"));
    expect(editorView().state.selection.ranges).toHaveLength(2);
  });

  it("honors the whole-word toggle", async () => {
    const user = userEvent.setup();
    renderEditor({ value: "bold embolden bold" });
    content().focus();
    await user.keyboard("{Control>}f{/Control}");
    await user.keyboard("bold");

    await user.click(panelButton("select"));
    expect(editorView().state.selection.ranges).toHaveLength(3);

    await user.click(panelCheckbox("word"));
    expect(getSearchQuery(editorView().state).wholeWord).toBe(true);
    await user.click(panelButton("select"));
    expect(editorView().state.selection.ranges).toHaveLength(2);
  });

  it("honors the regexp toggle", async () => {
    const user = userEvent.setup();
    renderEditor({ value: "cat cut cbt" });
    content().focus();
    await user.keyboard("{Control>}f{/Control}");
    await user.keyboard("c.t");
    pressEnter(searchField()!);
    // Literal "c.t" matches nothing, so the cursor does not move.
    expect(editorView().state.selection.main.empty).toBe(true);

    await user.click(panelCheckbox("re"));
    expect(getSearchQuery(editorView().state).regexp).toBe(true);
    await user.click(panelButton("select"));
    expect(editorView().state.selection.ranges).toHaveLength(3);
  });

  it("replaces only the current match", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderEditor({ value: "foo bar foo", onChange });
    content().focus();
    await user.keyboard("{Control>}f{/Control}");
    await user.keyboard("foo");
    pressEnter(searchField()!);
    await user.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
    await user.keyboard("baz");
    pressEnter(replaceField()!);

    expect(editorView().state.doc.toString()).toBe("baz bar foo");
    expect(onChange).toHaveBeenLastCalledWith("baz bar foo");
    // The next match is selected, not replaced.
    expect(editorView().state.selection.main.from).toBe(8);
  });

  it("replaces every match in the document", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderEditor({ value: "foo bar foo baz foo", onChange });
    content().focus();
    await user.keyboard("{Control>}f{/Control}");
    await user.keyboard("foo");
    await user.keyboard("{Control>}{Alt>}f{/Alt}{/Control}");
    await user.keyboard("qux");

    await user.click(panelButton("replaceAll"));

    expect(editorView().state.doc.toString()).toBe("qux bar qux baz qux");
    expect(onChange).toHaveBeenLastCalledWith("qux bar qux baz qux");
  });

  it("keeps search state per editor view so a new tab starts without a panel or query", async () => {
    const user = userEvent.setup();
    const first = renderEditor({ value: "alpha foo" });
    content().focus();
    await user.keyboard("{Control>}f{/Control}");
    await user.keyboard("foo");
    expect(searchPanelOpen(editorView().state)).toBe(true);
    expect(getSearchQuery(editorView().state).search).toBe("foo");
    first.unmount();

    renderEditor({ value: "beta bar", documentPath: "/notes/b.md" });
    expect(panel()).toBeNull();
    expect(searchPanelOpen(editorView().state)).toBe(false);
    expect(getSearchQuery(editorView().state).search).toBe("");
  });
});
