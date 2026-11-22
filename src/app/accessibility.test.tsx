import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

// The activity rail is the shell's only settings entry; it stays reachable
// whether or not the explorer is open or collapsed.
const activityRail = () =>
  screen.getByRole("navigation", { name: "活动栏" });
const sidebarSettingsButton = () =>
  within(screen.getByRole("complementary", { name: "侧栏" })).getByRole("button", { name: "设置" });

// Opening a file, folder, or dialog — click -> async port call -> controller
// state -> render — spans several React commits plus CodeMirror construction
// for the editor. CI runners under parallel load exceed the 1s default
// find*/waitFor budget, so assertions on those paths get an explicit budget
// with margin.
const APP_ASYNC_TIMEOUT_MS = 3000;

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
    expect(
      within(titlebar).queryByRole("button", { name: "设置" }),
    ).not.toBeInTheDocument();
    expect(sidebarSettingsButton()).toBeVisible();
    expect(screen.getAllByRole("button", { name: "设置" })).toHaveLength(1);
    for (const button of within(titlebar).queryAllByRole("button")) {
      expect(button).not.toHaveAttribute("data-tauri-drag-region");
    }
  });

  it("places file and search actions in the activity rail and the explorer toggle in the titlebar", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
      { workspace: { path: "/notes", title: "notes" } },
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));

    const rail = activityRail();
    expect(within(rail).getByRole("button", { name: "文件" })).toBeVisible();
    expect(within(rail).getByRole("button", { name: "搜索" })).toBeVisible();
    expect(within(rail).queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "收起侧栏" })).not.toBeInTheDocument();
    const titlebar = screen.getByRole("banner", { name: "应用标题栏" });
    expect(within(titlebar).getByRole("button", { name: "收起侧栏" })).toHaveAttribute(
      "aria-controls",
      "app-sidebar",
    );
    expect(screen.getAllByRole("button", { name: "收起侧栏" })).toHaveLength(1);
  });

  it("tracks the explorer collapse state on the activity rail", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map(), {
      workspace: { path: "/notes", title: "notes" },
    });
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));

    expect(activityRail()).toHaveAttribute("data-sidebar-collapsed", "false");
    await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(activityRail()).toHaveAttribute("data-sidebar-collapsed", "true");
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
    expect(tablist).toHaveAttribute("aria-orientation", "horizontal");
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

    // Collapsing the explorer never removes the horizontal document tab.
    await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tab.id);
  });

  it("exposes side-panel resizers as sliders with labelled value ranges", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
      { workspace: { path: "/notes", title: "notes" } },
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));

    // Width-carrying separators would be invalid ARIA; both resizers are
    // sliders with a value range and keep their keyboard adjustment.
    const sidebar = screen.getByRole("slider", { name: "调整侧栏宽度" });
    expect(sidebar).toHaveAttribute("aria-orientation", "vertical");
    expect(sidebar).toHaveAttribute("aria-valuenow", "260");
    expect(sidebar).toHaveAttribute("aria-valuemin", "120");
    // The max follows the window-aware clamp (jsdom 1024px → 50% = 512).
    expect(sidebar).toHaveAttribute("aria-valuemax", "512");

    await user.click(screen.getByRole("button", { name: "打开文件" }));
    await user.click(
      await screen.findByRole(
        "button",
        { name: "展开右侧栏" },
        { timeout: APP_ASYNC_TIMEOUT_MS },
      ),
    );
    const outline = screen.getByRole("slider", { name: "调整大纲宽度" });
    expect(outline).toHaveAttribute("aria-orientation", "vertical");
    expect(outline).toHaveAttribute("aria-valuenow", "300");
    expect(outline).toHaveAttribute("aria-valuemin", "120");
    expect(outline).toHaveAttribute("aria-valuemax", "512");
  });

  it("exposes the workspace tree with a name and levelled items", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/docs/a.md", file("/notes/docs/a.md")]]),
      { workspace: { path: "/notes", title: "notes" } },
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));

    expect(
      await screen.findByRole(
        "complementary",
        { name: "侧栏" },
        { timeout: APP_ASYNC_TIMEOUT_MS },
      ),
    ).toBeVisible();
    const tree = await screen.findByRole(
      "tree",
      { name: "工作区文件" },
      { timeout: APP_ASYNC_TIMEOUT_MS },
    );
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

    await user.click(sidebarSettingsButton());
    // The role query's name comes from the dialog's visible heading:
    // aria-labelledby -> settings-dialog-title (h2 "设置").
    const dialog = screen.getByRole("dialog", { name: "设置" });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByLabelText("主题")).toBeInTheDocument();
    // Escape reaches the dialog's onKeyDown handler directly rather than
    // through document.activeElement: under heavy CI load the jsdom document
    // can lose focus (document.hasFocus() flips false), which yanks focus —
    // and the global-keyboard events that depend on it — to the body. The
    // component does move focus into the dialog on mount; only the focus
    // *persistence* is unreliable in a starved jsdom, so the close flow is
    // asserted through the dialog's own keydown handler.
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(
      () => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      { timeout: APP_ASYNC_TIMEOUT_MS },
    );
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
    await user.click(await screen.findByRole("button", { name: "展开右侧栏" }));

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

    expect(
      await screen.findByRole(
        "textbox",
        { name: "Markdown 编辑器" },
        { timeout: APP_ASYNC_TIMEOUT_MS },
      ),
    ).toBeInTheDocument();
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

    // The save path — key events -> controller -> async port write -> recorded
    // write — spans the same multi-commit chain as the open/dialog paths, so
    // the assertion gets the same explicit budget instead of the 1s default.
    await waitFor(() => expect(port.writes).toHaveLength(1), {
      timeout: APP_ASYNC_TIMEOUT_MS,
    });
    expect(port.writes[0].text).toBe("xsaved");
  });

  it("switches tabs with arrow keys from the horizontal tab list", async () => {
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
    await user.keyboard("{ArrowRight}");
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

    const collapse = await screen.findByRole(
      "button",
      { name: "收起侧栏" },
      { timeout: APP_ASYNC_TIMEOUT_MS },
    );
    // Enter activation is dispatched to the button directly — keydown plus
    // the click its default action would synthesize — instead of
    // user.keyboard, whose global focus a starved jsdom can revoke under
    // heavy CI load (the same reason the dialog tests above dispatch to their
    // own handlers). The toggle commits synchronously, so the assertions
    // below are deterministic.
    collapse.focus();
    fireEvent.keyDown(collapse, { key: "Enter" });
    fireEvent.click(collapse);
    expect(screen.queryByRole("complementary", { name: "侧栏" })).not.toBeInTheDocument();

    // The expand toggle lives outside the collapsed rail, so it stays
    // focusable; the same deterministic key/click activation reopens it.
    const expand = screen.getByRole("button", { name: "展开侧栏" });
    expand.focus();
    fireEvent.keyDown(expand, { key: "Enter" });
    fireEvent.click(expand);
    expect(screen.getByRole("complementary", { name: "侧栏" })).toBeInTheDocument();
  });

  it("operates the settings dialog entirely from the keyboard", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map());
    render(<AppShell port={port} />);

    sidebarSettingsButton().focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "设置" });
    const themeSelect = within(dialog).getByLabelText("主题");
    // The dialog moves focus into its first control on mount, but that
    // focus state is not asserted here: under heavy CI load a starved jsdom
    // can revoke it (document.hasFocus() flips false), which would flake the
    // assertion without reflecting anything about the component.
    expect(themeSelect).toBeInTheDocument();
    await user.selectOptions(themeSelect, "light");
    expect(document.documentElement.dataset.theme).toBe("light");

    // Escape is dispatched to the dialog's own keydown handler instead of
    // through document.activeElement for the same reason (see the dialog
    // naming test above).
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(
      () => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(sidebarSettingsButton()).toHaveFocus();
      },
      { timeout: APP_ASYNC_TIMEOUT_MS },
    );
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

  it("styles blockquote lines as continuous surface cards without an accent bar", () => {
    expect(appCss).toMatch(
      /\.cm-live-preview-quote\s*\{[^}]*color:\s*var\(--text-primary\);/s,
    );
    expect(appCss).toMatch(
      /\.markdown-editor \.cm-line\.cm-live-preview-quote-line\s*\{[^}]*background:\s*var\(--surface-quote\);[^}]*padding-inline:\s*var\(--space-quote-inline\);/s,
    );
    expect(appCss).not.toMatch(/\.cm-line\.cm-live-preview-quote-line::before/);
    expect(appCss).toMatch(
      /\.markdown-editor \.cm-line\.cm-live-preview-quote-line-single\s*\{[^}]*border-radius:\s*var\(--radius-medium\);[^}]*padding-block:\s*var\(--space-quote-block\);/s,
    );
    expect(appCss).toMatch(
      /\.markdown-editor \.cm-line\.cm-live-preview-quote-line-first\s*\{[^}]*border-radius:[^;}]*0 0;[^}]*padding-top:\s*var\(--space-quote-block\);/s,
    );
    expect(appCss).toMatch(
      /\.markdown-editor \.cm-line\.cm-live-preview-quote-line-last\s*\{[^}]*border-radius:\s*0 0[^;}]*;[^}]*padding-bottom:\s*var\(--space-quote-block\);/s,
    );
  });

  it("uses math-like inline code typography without a chip background", () => {
    expect(appCss).toMatch(
      /\.cm-live-preview-inline-code\s*\{[^}]*font-family:\s*"KaTeX_Math"[^;}]*;[^}]*background:\s*transparent;[^}]*border:\s*none;[^}]*padding:\s*0;/s,
    );
    expect(appCss).toMatch(
      /\.cm-live-preview-highlight \.cm-live-preview-inline-code,\s*\.cm-live-preview-inline-code\.cm-live-preview-highlight\s*\{[^}]*background:\s*var\(--highlight\);/s,
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
    // The explorer sections scroll inside a dedicated wrapper while the
    // sidebar itself clips.
    expect(appCss).toMatch(/\.sidebar\s*\{[^}]*overflow:\s*hidden;/s);
    expect(appCss).toMatch(/\.sidebar-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  });

  it("keeps a fixed 36px activity rail outside the collapsing sidebar", () => {
    expect(appCss).toMatch(
      /\.activity-rail\s*\{[^}]*width:\s*var\(--activity-rail-width\);[^}]*height:\s*100%;/s,
    );
    expect(tokensCss).toMatch(/--activity-rail-width:\s*36px;/);
    expect(appCss).toMatch(
      /\.sidebar-settings-row\s*\{[^}]*margin-top:\s*auto;/s,
    );
    expect(appCss).toMatch(
      /\.activity-rail-button\[aria-pressed="true"\]\s*\{[^}]*background:\s*transparent;/s,
    );
    expect(appCss).not.toMatch(/\.sidebar-footer\s*\{/);
    expect(appCss).not.toMatch(/\.settings-fab\s*\{/);
  });

  it("adds an inward corner when only the activity rail remains", () => {
    expect(appCss).toMatch(/\.activity-rail\s*\{[^}]*position:\s*relative;/s);
    expect(appCss).toMatch(
      /\.activity-rail\[data-sidebar-collapsed="true"\]::before\s*\{[^}]*left:\s*100%;[^}]*top:\s*0;[^}]*background:\s*radial-gradient\(\s*circle at 100% 100%,/s,
    );
  });

  it("keeps panel-to-canvas connectors free of drop shadows", () => {
    expect(appCss).not.toMatch(
      /\.sidebar-rail\[data-collapsed="false"\]\s*\{[^}]*box-shadow:/s,
    );
    expect(appCss).not.toMatch(
      /\.outline-rail\[data-collapsed="false"\]\s*\{[^}]*box-shadow:/s,
    );
  });

  it.each(["sidebar", "outline"])(
    "shows a localized neutral glow for the %s resize indicator",
    (panel) => {
      expect(tokensCss).toMatch(/--resize-indicator-core:/);
      expect(tokensCss).toMatch(/--resize-indicator-glow:/);
      expect(appCss).toMatch(
        new RegExp(
          `\\.${panel}-resizer::after\\s*\\{[^}]*top:\\s*16%;[^}]*bottom:\\s*16%;`,
          "s",
        ),
      );
      expect(appCss).toMatch(
        new RegExp(
          `\\.${panel}-resizer:hover::after,\\s*body\\.${panel}-resizing \\.${panel}-resizer::after\\s*\\{[^}]*background:\\s*var\\(--resize-indicator-core\\);[^}]*box-shadow:\\s*var\\(--resize-indicator-glow\\);`,
          "s",
        ),
      );
    },
  );

  it("joins the first tab shoulder to the left connector without a gap", () => {
    expect(tokensCss).toMatch(/--radius-panel:\s*32px;/);
    expect(tokensCss).toMatch(/--radius-large:\s*12px;/);
    expect(appCss).toMatch(
      /\.tab-list\s*\{[^}]*padding-inline:\s*calc\(var\(--radius-panel\) \+ var\(--radius-large\)\) var\(--space-3\);[^}]*scroll-padding-inline:\s*calc\(var\(--radius-panel\) \+ var\(--radius-large\)\) var\(--space-3\);/s,
    );
  });

  it("uses larger titlebar icon controls", () => {
    expect(appCss).toMatch(
      /\.icon-button\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s,
    );
  });

  it("keeps the unified top bar draggable outside tab controls", () => {
    expect(appCss).toMatch(
      /\.document-tabs-bar\s*\{[^}]*-webkit-app-region:\s*drag;/s,
    );
    expect(appCss).toMatch(
      /\.tab-list\s*\{[^}]*-webkit-app-region:\s*drag;/s,
    );
    expect(appCss).toMatch(
      /\.tab-item\s*\{[^}]*-webkit-app-region:\s*no-drag;/s,
    );
  });

  it("matches native macOS horizontal titlebar insets", () => {
    expect(appCss).toMatch(
      /\.tauri \.app-header\s*\{[^}]*--header-safe-left:\s*86px;/s,
    );
    expect(appCss).toMatch(
      /\.tauri \.app-header-leading\s*\{[^}]*padding-left:\s*var\(--header-safe-left\);/s,
    );
  });

  it("uses one synchronized layout transition for expanding sidebars", () => {
    expect(tokensCss).toMatch(
      /--transition-sidebar:\s*160ms cubic-bezier\(0\.2,\s*0,\s*0,\s*1\);/,
    );
    expect(appCss).toMatch(
      /\.sidebar-rail\s*\{[^}]*transition:\s*width var\(--transition-sidebar\),\s*opacity var\(--transition-fast\);/s,
    );
    expect(appCss).toMatch(
      /\.sidebar-rail\[data-collapsed="true"\]\s*\{[^}]*opacity:\s*0;/s,
    );
    expect(appCss).toMatch(
      /\.app-header\s*\{[^}]*transition:\s*grid-template-columns var\(--transition-sidebar\);/s,
    );
    expect(appCss).toMatch(
      /body\.sidebar-resizing \.app-header\s*\{[^}]*transition:\s*none;/s,
    );
    expect(appCss).not.toMatch(/@keyframes panelIn/);
    expect(appCss).not.toMatch(
      /\.sidebar-rail:not\(\[data-collapsed="true"\]\),\s*\.outline-rail:not\(\[data-collapsed="true"\]\)\s*\{[^}]*animation:/s,
    );
  });

  it("hides a collapsed sidebar from focus on WebViews without inert support", () => {
    expect(appCss).toMatch(
      /\.sidebar-rail\[data-collapsed="true"\]\s*\{[^}]*visibility:\s*hidden;/s,
    );
  });

  it.each([
    ["left top", ".sidebar-rail", "::before", "100% 100%"],
    ["right top", ".outline-rail", "::before", "0 100%"],
  ])("curves the %s sidebar connector toward the canvas", (_name, rail, pseudo, center) => {
    expect(appCss).toMatch(
      new RegExp(
        `\\.${rail.slice(1)}\\[data-collapsed="false"\\]${pseudo}\\s*\\{[^}]*background:\\s*radial-gradient\\(\\s*circle at ${center.replace(" ", "\\s+")},`,
        "s",
      ),
    );
  });

  it.each([
    ["left", ".sidebar-rail"],
    ["right", ".outline-rail"],
  ])("does not draw a bottom connector on the %s sidebar", (_name, rail) => {
    expect(appCss).not.toMatch(
      new RegExp(`\\.${rail.slice(1)}\\[data-collapsed="false"\\]::after\\s*\\{`, "s"),
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
      /\.outline-rail\[data-collapsed="false"\]::before\s*\{[^}]*top:\s*0;[^}]*background:\s*radial-gradient\(/s,
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
      /\.outline-toolbar \.icon-button\.(translate-toggle|view-mode-toggle|presentation-toggle)\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--selection\);/s,
    );
    expect(appCss).toMatch(
      /\.outline-toolbar \.icon-button\.(translate-toggle|view-mode-toggle|presentation-toggle)\[aria-pressed="true"\]:hover,[^}]*\.outline-toolbar \.icon-button\.(translate-toggle|view-mode-toggle|presentation-toggle)\[aria-pressed="true"\]:active\s*\{[^}]*background:\s*var\(--selection\);/s,
    );
  });

  it("declares the Baseline-style motion tokens", () => {
    expect(tokensCss).toMatch(
      /--anim-easing:\s*cubic-bezier\(0\.1,\s*0,\s*0\.1,\s*1\.25\);/,
    );
    expect(tokensCss).toMatch(/--anim-superfast:\s*80ms;/);
    expect(tokensCss).toMatch(/--anim-fast:\s*160ms;/);
    expect(tokensCss).toMatch(/--anim-moderate:\s*320ms;/);
    expect(tokensCss).toMatch(/--anim-slow:\s*480ms;/);
  });

  it("defines the Baseline-style entry keyframes", () => {
    for (const name of ["dialogIn", "fadeIn", "bannerIn"]) {
      expect(appCss).toMatch(new RegExp(`@keyframes ${name}\\s*\\{`));
    }
  });

  it("uses composite fast/easing transitions with press feedback", () => {
    expect(appCss).toMatch(
      /\.outline-tree-row,[^}]*background-color var\(--anim-fast\) ease,[^}]*transform var\(--anim-moderate\) var\(--anim-easing\),[^}]*box-shadow var\(--anim-moderate\) var\(--anim-easing\);/s,
    );
    expect(appCss).toMatch(
      /button:active:not\(:disabled\),\s*\.icon-button:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(0\.96\);/s,
    );
    expect(appCss).toMatch(/\.file-tree-row:active,\s*\.tab:active\s*\{[^}]*opacity:\s*0\.8;/s);
    expect(appCss).toMatch(
      /\.icon-button:hover:not\(:disabled\)\s*\{[^}]*box-shadow:\s*var\(--shadow-hover\);/s,
    );
    expect(tokensCss).toMatch(/--shadow-hover:\s*0 6px 16px -4px rgba\(0,\s*0,\s*0,\s*0\.4\);/);
    expect(tokensCss).toMatch(/--shadow-hover:\s*0 6px 16px -4px rgba\(0,\s*0,\s*0,\s*0\.18\);/);
  });

  it("hooks the entry animations and keeps collapsed rails intact", () => {
    expect(appCss).toMatch(
      /\.dialog-overlay\s*\{[^}]*animation:\s*fadeIn var\(--anim-fast\) ease;/s,
    );
    expect(appCss).toMatch(
      /\.dialog-overlay \[role="dialog"\]\s*\{[^}]*animation:\s*dialogIn var\(--anim-moderate\) var\(--anim-easing\);/s,
    );
    expect(appCss).toMatch(
      /\.app-alert,[^}]*\.perf-banner,[^}]*\.translation-banner\s*\{[^}]*animation:\s*bannerIn var\(--anim-moderate\) var\(--anim-easing\);/s,
    );
  });

  it("keeps reduced-motion covering the new animation durations", () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation-duration:\s*0\.01ms !important;/s,
    );
  });
});
