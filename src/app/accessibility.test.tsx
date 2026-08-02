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
    const titlebar = screen.getByRole("banner", { name: "应用标题栏" });
    expect(titlebar).toBeVisible();
    expect(titlebar).toHaveAttribute("data-tauri-drag-region");
    expect(within(titlebar).getByText("Opus")).toHaveAttribute(
      "data-tauri-drag-region",
    );
    expect(screen.getByRole("button", { name: "设置" })).toBeVisible();
    for (const button of within(titlebar).getAllByRole("button")) {
      expect(button).not.toHaveAttribute("data-tauri-drag-region");
    }
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

  it("keeps the tablist outside the tabpanel and drops a dangling aria-labelledby", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).queryByRole("tablist")).not.toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: /a\.md/ });
    expect(panel).toHaveAttribute("aria-labelledby", tab.id);

    // Collapsing the section removes the tab element; the panel must not
    // keep a label reference to a node that no longer exists.
    await user.click(screen.getByRole("button", { name: "打开的标签" }));
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).not.toHaveAttribute("aria-labelledby");
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

  it("exposes editable table grid roles and native reading-mode semantics", async () => {
    const user = userEvent.setup();
    const tableText = [
      "| Name | Note |",
      "| --- | --- |",
      "| Ada | first |",
    ].join("\n");
    const port = new MemoryDocumentPort(
      new Map([["/notes/table.md", file("/notes/table.md", tableText)]]),
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));

    const grid = screen.getByRole("grid", { name: "Markdown 表格" });
    expect(within(grid).getAllByRole("columnheader")).toHaveLength(2);
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(2);
    for (const cell of grid.querySelectorAll<HTMLElement>("th, td")) {
      expect(cell).toHaveAttribute("contenteditable", "true");
      expect(cell.tabIndex).toBe(0);
    }

    await user.click(screen.getByRole("button", { name: "编辑模式" }));

    expect(screen.queryByRole("grid", { name: "Markdown 表格" })).toBeNull();
    const table = screen.getByRole("table", { name: "Markdown 表格" });
    expect(table).toHaveAccessibleName("Markdown 表格");
    for (const cell of table.querySelectorAll<HTMLElement>("th, td")) {
      expect(cell).not.toHaveAttribute("role");
      expect(cell).not.toHaveAttribute("contenteditable");
      expect(cell.tabIndex).toBe(-1);
    }
  });
});

describe("product identity", () => {
  it("uses Opus as the browser document title", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toMatch(/<title>Opus<\/title>/);
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

  it("uses a tokenized layout-stable focus ring for editable table cells", () => {
    expect(appCss).toMatch(
      /\.md-table \[contenteditable="true"\]:focus-visible\s*\{[^}]*box-shadow:\s*inset 0 0 0 2px var\(--focus-ring\);/s,
    );
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

  it("defines Obsidian-style highlight colors for both themes", () => {
    expect(tokensCss).toMatch(
      /:root,\s*:root\[data-theme="dark"\]\s*\{[^}]*--highlight:\s*#796a32;/s,
    );
    expect(tokensCss).toMatch(
      /:root\[data-theme="light"\]\s*\{[^}]*--highlight:\s*#ffec99;/s,
    );
    expect(appCss).toMatch(
      /\.cm-live-preview-highlight\s*\{[^}]*background:\s*var\(--highlight\);[^}]*border-radius:\s*var\(--radius-small\);[^}]*padding-inline:\s*var\(--space-0-5\);/s,
    );
  });

  it("styles blockquote lines as continuous surface cards", () => {
    expect(appCss).toMatch(
      /\.cm-live-preview-quote\s*\{[^}]*color:\s*var\(--text-primary\);/s,
    );
    expect(appCss).toMatch(
      /\.markdown-editor \.cm-line\.cm-live-preview-quote-line\s*\{[^}]*background:\s*var\(--surface\);[^}]*border-left:\s*2px solid var\(--text-muted\);[^}]*padding-inline:\s*var\(--space-5\);/s,
    );
    expect(appCss).toMatch(
      /\.markdown-editor \.cm-line\.cm-live-preview-quote-line-single\s*\{[^}]*border-radius:\s*var\(--radius-medium\);[^}]*padding-block:\s*var\(--space-3\);/s,
    );
    expect(appCss).toMatch(
      /\.markdown-editor \.cm-line\.cm-live-preview-quote-line-first\s*\{[^}]*border-radius:[^;}]*0 0;[^}]*padding-top:\s*var\(--space-3\);/s,
    );
    expect(appCss).toMatch(
      /\.markdown-editor \.cm-line\.cm-live-preview-quote-line-last\s*\{[^}]*border-radius:\s*0 0[^;}]*;[^}]*padding-bottom:\s*var\(--space-3\);/s,
    );
  });

  it("keeps inline code inside a highlight on the highlight background", () => {
    expect(appCss).toMatch(
      /\.cm-live-preview-highlight \.cm-live-preview-inline-code,\s*\.cm-live-preview-inline-code\.cm-live-preview-highlight\s*\{[^}]*background:\s*var\(--highlight\);[^}]*border-color:\s*var\(--divider\);/s,
    );
  });

  it("keeps the titlebar fixed while the body and sidebar fill the viewport", () => {
    expect(appCss).toMatch(
      /\.app-shell\s*\{[^}]*height:\s*100vh;[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);/s,
    );
    expect(appCss).toMatch(
      /\.app-header\s*\{[^}]*min-height:\s*44px;/s,
    );
    expect(appCss).toMatch(/\.app-body\s*\{[^}]*overflow:\s*hidden;/s);
    expect(appCss).toMatch(/\.sidebar\s*\{[^}]*height:\s*100%;/s);
    expect(appCss).toMatch(/\.sidebar\s*\{[^}]*overflow-y:\s*auto;/s);
  });

  it("uses larger titlebar icon controls", () => {
    expect(appCss).toMatch(
      /\.icon-button\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s,
    );
  });

  it("matches native macOS horizontal titlebar insets", () => {
    expect(appCss).toMatch(
      /\.tauri \.app-header\s*\{[^}]*padding:\s*var\(--space-1\)\s+14px\s+var\(--space-1\)\s+86px;/s,
    );
  });

  it("animates the sidebar rail and honors reduced-motion preferences", () => {
    expect(tokensCss).toMatch(
      /--transition-sidebar:\s*160ms cubic-bezier\(0\.2,\s*0,\s*0,\s*1\);/,
    );
    expect(appCss).toMatch(
      /\.sidebar-rail\s*\{[^}]*transition:\s*width var\(--transition-sidebar\),\s*opacity var\(--transition-fast\);/s,
    );
    expect(appCss).toMatch(
      /\.sidebar-rail\[data-collapsed="true"\]\s*\{[^}]*opacity:\s*0;/s,
    );
  });

  it("hides a collapsed sidebar from focus on WebViews without inert support", () => {
    expect(appCss).toMatch(
      /\.sidebar-rail\[data-collapsed="true"\]\s*\{[^}]*visibility:\s*hidden;/s,
    );
  });

  it("mirrors the full-height animated sidebar treatment for the outline", () => {
    expect(appCss).toMatch(
      /\.outline-rail\s*\{[^}]*height:\s*100%;[^}]*transition:\s*width var\(--transition-sidebar\),\s*opacity var\(--transition-fast\);/s,
    );
    expect(appCss).toMatch(
      /\.outline-rail\[data-collapsed="true"\]\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;/s,
    );
    expect(appCss).toMatch(
      /\.outline-sidebar\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*border-left:\s*1px solid var\(--divider\);/s,
    );
    expect(appCss).toMatch(
      /\.outline-content\s*\{[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;/s,
    );
  });

  it("keeps outline controls compact, nested, and visibly animated", () => {
    expect(appCss).toMatch(
      /\.outline-icon-button\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s,
    );
    expect(appCss).toMatch(
      /\.outline-tree-group\s*\{[^}]*padding-left:\s*var\(--space-4\);/s,
    );
    expect(appCss).toMatch(
      /\.outline-disclosure span\s*\{[^}]*transform:\s*rotate\(0deg\);[^}]*transition:\s*transform var\(--transition-fast\);/s,
    );
    expect(appCss).toMatch(
      /\.outline-disclosure span\[data-expanded="true"\]\s*\{[^}]*transform:\s*rotate\(90deg\);/s,
    );
  });

  it("uses a mirrored left-edge resize target for the outline", () => {
    expect(appCss).toMatch(
      /\.outline-resizer\s*\{[^}]*width:\s*6px;[^}]*margin-left:\s*-3px;[^}]*margin-right:\s*-3px;[^}]*cursor:\s*col-resize;/s,
    );
    expect(appCss).toMatch(
      /body\.outline-resizing \.outline-rail\s*\{[^}]*transition:\s*none;/s,
    );
  });

  it("uses the text-selection color to highlight reading mode", () => {
    expect(appCss).toMatch(
      /\.editor-toolbar \.view-mode-toggle\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--selection\);/s,
    );
    expect(appCss).toMatch(
      /\.editor-toolbar \.view-mode-toggle\[aria-pressed="true"\]:hover,\s*\.editor-toolbar \.view-mode-toggle\[aria-pressed="true"\]:active\s*\{[^}]*background:\s*var\(--selection\);/s,
    );
  });
});
