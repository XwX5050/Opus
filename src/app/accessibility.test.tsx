import { readFileSync } from "node:fs";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";
import AppShell from "./AppShell";

const file = (path: string, text = "saved"): OpenedFile => ({
  path,
  text,
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

const editor = () => screen.getByRole("textbox", { name: "Markdown 编辑器" });
const replaceEditorText = (text: string) => {
  const view = EditorView.findFromDOM(editor());
  if (!view) throw new Error("EditorView not found");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
};

describe("accessibility: roles and names", () => {
  it("exposes the empty state as a labelled region with named actions", () => {
    render(<AppShell port={new MemoryDocumentPort(new Map())} />);

    const empty = screen.getByRole("region", { name: "空白状态" });
    expect(within(empty).getByRole("button", { name: "新建" })).toBeVisible();
    expect(within(empty).getByRole("button", { name: "打开文件" })).toBeVisible();
    expect(within(empty).getByRole("button", { name: "打开文件夹" })).toBeVisible();
    expect(screen.getByRole("banner", { name: "应用标题栏" })).toBeVisible();
    expect(screen.getByRole("button", { name: "设置" })).toBeVisible();
  });

  it("exposes tabs with names, selection state and a labelled panel", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/a.md", file("/notes/a.md")],
        ["/notes/b.md", file("/notes/b.md")],
      ]),
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));

    const tablist = screen.getByRole("tablist", { name: "打开的文档" });
    expect(tablist).toHaveAttribute("aria-orientation", "vertical");
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expect(tab).toHaveAccessibleName();
    const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toBeDefined();
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", selected!.id);
  });

  it("exposes the workspace tree with a name and levelled items", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/docs/a.md", file("/notes/docs/a.md")]]),
      { workspace: { path: "/notes", title: "notes" } },
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));

    expect(screen.getByRole("complementary", { name: "侧栏" })).toBeVisible();
    const tree = await screen.findByRole("tree", { name: "工作区文件" });
    const items = within(tree).getAllByRole("treeitem");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).toHaveAccessibleName();
      expect(item).toHaveAttribute("aria-level");
    }
  });

  it("names every dialog through its visible heading", async () => {
    const user = userEvent.setup();
    render(<AppShell port={new MemoryDocumentPort(new Map())} />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("dialog", { name: "设置" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("names the close-confirmation dialog and keeps it modal", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    replaceEditorText("unsaved changes");
    await user.click(screen.getByRole("button", { name: "关闭 a.md" }));

    const dialog = screen.getByRole("dialog", { name: "保存更改" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("button", { name: "保存" })).toHaveFocus();
  });

  it("labels the search panel controls", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    editor().focus();
    await user.keyboard("{Control>}f{/Control}");

    const panel = document.querySelector(".cm-panel.cm-search");
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('input[name="search"]')).toHaveAccessibleName();
    expect(panel?.querySelector('input[name="replace"]')).toHaveAccessibleName();
    expect(document.activeElement).toBe(panel?.querySelector('input[name="search"]'));
  });
});

describe("accessibility: keyboard-only flows", () => {
  it("opens a file with the keyboard and moves focus into the editor", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
    );
    render(<AppShell port={port} />);

    screen.getByRole("button", { name: "打开文件" }).focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("textbox", { name: "Markdown 编辑器" })).toBeInTheDocument();
  });

  it("saves with Mod-s from the editor", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    editor().focus();
    await user.keyboard("x");
    await user.keyboard("{Control>}s{/Control}");

    await waitFor(() => expect(port.writes).toHaveLength(1));
    expect(port.writes[0].text).toBe("xsaved");
  });

  it("switches tabs with arrow keys from the vertical tab list", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/a.md", file("/notes/a.md")],
        ["/notes/b.md", file("/notes/b.md")],
      ]),
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));

    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("tab")[1]).toHaveFocus();
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("collapses and expands the sidebar with the keyboard", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
      { workspace: { path: "/notes", title: "notes" } },
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));

    const collapse = await screen.findByRole("button", { name: "收起侧栏" });
    collapse.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("complementary", { name: "侧栏" })).not.toBeInTheDocument();

    const expand = screen.getByRole("button", { name: "展开侧栏" });
    expand.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary", { name: "侧栏" })).toBeInTheDocument();
  });

  it("operates the settings dialog entirely from the keyboard", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    screen.getByRole("button", { name: "设置" }).focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const themeSelect = within(dialog).getByLabelText("主题");
    expect(themeSelect).toHaveFocus();
    await user.selectOptions(themeSelect, "light");
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toHaveFocus();
  });
});

describe("accessibility: stylesheet guarantees", () => {
  // Paths are relative to the project root (vitest's cwd).
  const appCss = readFileSync("src/theme/app.css", "utf8");
  const tokensCss = readFileSync("src/theme/tokens.css", "utf8");

  it("declares a visible keyboard focus style", () => {
    expect(appCss).toMatch(/:focus-visible\s*\{/);
    expect(appCss).toMatch(/--focus-ring/);
  });

  it("honors prefers-reduced-motion", () => {
    expect(appCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps component styles free of hardcoded colors", () => {
    // Colors must resolve through tokens; raw color literals in app.css
    // would bypass theming.
    expect(appCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(appCss).not.toMatch(/\brgba?\(/);
  });

  it("defines both themes through data-theme tokens", () => {
    expect(tokensCss).toContain('[data-theme="dark"]');
    expect(tokensCss).toContain('[data-theme="light"]');
    // The dialog backdrop is themed too (used by .dialog-overlay).
    expect(tokensCss).toMatch(/--backdrop:/);
  });
});
