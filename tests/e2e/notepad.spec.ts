import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Browser-shell E2E flows (plan Task 13, Step 1).
 *
 * Each test seeds the in-memory DocumentPort by installing a JSON fixture on
 * window.__E2E_FIXTURE__ before the app loads; the app (VITE_E2E=1) builds a
 * MemoryDocumentPort from it and publishes it as window.__E2E_PORT__, so tests
 * can drive test hooks (updateFile/emitDiskEvent) and inspect writes. All
 * interactions go through the real CodeMirror DOM — no reducer calls.
 *
 * The fixture shape mirrors src/app/e2e.ts E2eFixtureSpec.
 */

interface E2eFileSpec {
  path: string;
  text: string;
  hasUtf8Bom?: boolean;
  newline?: "lf" | "cr_lf";
  version?: string;
}

interface E2eDraftSpec {
  draftId: string;
  originalPath: string | null;
  title: string;
  text: string;
  hasUtf8Bom: boolean;
  newline: "lf" | "cr_lf";
  savedTextHash: string;
  savedVersion: string | null;
}

interface E2eFixtureSpec {
  files?: E2eFileSpec[];
  session?: {
    recent: Array<{ path: string; kind: "file" | "folder" }>;
    openPaths: string[];
    activePath: string | null;
    workspacePath: string | null;
    outline?: { width: number };
  } | null;
  drafts?: E2eDraftSpec[];
  workspace?: { path: string; title: string } | null;
  chosenPaths?: string[];
  savePath?: string | null;
}

declare global {
  interface Window {
    __E2E_FIXTURE__?: E2eFixtureSpec;
    __E2E_PORT__?: {
      writes: ReadonlyArray<{ text: string }>;
      updateFile(path: string, text: string, version: string, modifiedUnixMs?: number): void;
      emitDiskEvent(event: { kind: string; path: string; modifiedUnixMs?: number; version?: string }): void;
    };
  }
}

/** Installs the fixture before page scripts run, then loads the shell. */
const seed = async (page: Page, fixture: E2eFixtureSpec) => {
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");
};

const sessionWith = (...paths: string[]): E2eFixtureSpec["session"] => ({
  recent: [],
  openPaths: paths,
  activePath: paths.at(-1) ?? null,
  workspacePath: null,
});

const editorContent = (page: Page) => page.locator(".cm-content");

const tableDocumentSource = [
  "Before untouched",
  "",
  "| Name | Note |",
  "| --- | --- |",
  "| Ada | old |",
  "",
  "After untouched",
  "",
].join("\n");

const markdownTable = (page: Page) => page.locator("table.md-table");
const markdownTableCell = (page: Page, index: number) =>
  markdownTable(page).locator(`[data-cell-index="${index}"]`);

const clickEditableTableCell = async (cell: Locator) => {
  await cell.click();
  await expect(cell).toBeFocused();
};

const placeTableCaret = async (cell: Locator, offset: number) => {
  await cell.evaluate((element, caretOffset) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) {
      throw new Error("Expected a plain-text Markdown table cell");
    }
    const range = document.createRange();
    range.setStart(text, caretOffset);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, offset);
};

test("opens two files, switches tabs, edits, and saves with Cmd+S", async ({
  page,
}) => {
  await seed(page, {
    files: [
      { path: "/docs/a.md", text: "# Alpha\n" },
      { path: "/docs/b.md", text: "# Beta\n" },
    ],
    chosenPaths: ["/docs/a.md", "/docs/b.md"],
  });

  await page.getByRole("button", { name: "打开文件", exact: true }).click();
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(page.locator(".tab-list")).toHaveAttribute("data-motion-list", "tabs");
  await expect(tabs.nth(0)).toHaveAttribute("data-motion-item", "tab");
  // The last opened file is active; switching tabs swaps the editor document.
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(editorContent(page)).toContainText("Beta");
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(editorContent(page)).toContainText("Alpha");

  await editorContent(page).click();
  await page.keyboard.type(" edited");
  await expect(page.locator(".tab-dirty")).toHaveCount(1);
  await page.keyboard.press("Meta+s");
  await expect(page.locator(".tab-dirty")).toHaveCount(0);

  const writes = await page.evaluate(() =>
    (window.__E2E_PORT__?.writes ?? []).map((write) => write.text),
  );
  expect(writes.at(-1)).toContain("# Alpha");
  expect(writes.at(-1)).toContain("edited");
});

test("cancelling a dirty close keeps the tab and the edits", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/notes.md", text: "原始内容\n" }],
    session: sessionWith("/docs/notes.md"),
  });

  const content = editorContent(page);
  await content.waitFor();
  await content.click();
  await page.keyboard.type("未保存的修改");
  await expect(page.locator(".tab-dirty")).toHaveCount(1);

  await page.getByRole("button", { name: "关闭 notes.md" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("保存更改");
  await dialog.getByRole("button", { name: "取消" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".tab-dirty")).toHaveCount(1);
  await expect(content).toContainText("未保存的修改");
});

test("types and pastes plain text into a Markdown table and saves exact source", async ({
  page,
  context,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });

  const content = editorContent(page);
  const table = markdownTable(page);
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("role", "grid");
  await expect(table).toHaveAttribute("aria-label", "Markdown 表格");
  await expect(content).not.toContainText("| --- | --- |");

  await clickEditableTableCell(markdownTableCell(page, 2));
  await page.keyboard.type("|中文");
  await expect(markdownTableCell(page, 2)).toHaveText("Ada|中文");
  await expect(page.locator(".tab-dirty")).toHaveCount(1);

  await context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: "http://localhost:1421" },
  );
  await page.evaluate(() =>
    navigator.clipboard.writeText("<b>x|y</b>\n下一行"),
  );
  await clickEditableTableCell(markdownTableCell(page, 3));
  await page.keyboard.press("Meta+v");
  await expect(markdownTableCell(page, 3))
    .toHaveText("old<b>x|y</b> 下一行");
  await expect(markdownTableCell(page, 3).locator("*")).toHaveCount(0);

  await markdownTableCell(page, 3).press("Meta+s");
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  const expected = [
    "Before untouched",
    "",
    "| Name | Note |",
    "| --- | --- |",
    String.raw`| Ada\|中文 | old<b>x\|y</b> 下一行 |`,
    "",
    "After untouched",
    "",
  ].join("\n");
  const writes = await page.evaluate(() =>
    (window.__E2E_PORT__?.writes ?? []).map((write) => write.text),
  );
  expect(writes).toEqual([expected]);
});

test("deletes table-cell text with browser-supported native shortcuts and saves exact source", async ({
  page,
}) => {
  const deletionDocumentSource = [
    "Before untouched",
    "",
    "| Backspace | Delete | Option backward | Option forward | Command backward | Command forward |",
    "| --- | --- | --- | --- | --- | --- |",
    "| abc | def | alpha | bravo | charlie | delta |",
    "",
    "After untouched",
    "",
  ].join("\n");
  await seed(page, {
    files: [{ path: "/docs/table.md", text: deletionDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });

  await expect(markdownTable(page)).toBeVisible();

  await clickEditableTableCell(markdownTableCell(page, 6));
  await placeTableCaret(markdownTableCell(page, 6), 3);
  await page.keyboard.press("Backspace");
  await expect(markdownTableCell(page, 6)).toHaveText("ab");

  await clickEditableTableCell(markdownTableCell(page, 7));
  await placeTableCaret(markdownTableCell(page, 7), 0);
  await page.keyboard.press("Delete");
  await expect(markdownTableCell(page, 7)).toHaveText("ef");

  await clickEditableTableCell(markdownTableCell(page, 8));
  await placeTableCaret(markdownTableCell(page, 8), 5);
  await page.keyboard.press("Alt+Backspace");
  await expect(markdownTableCell(page, 8)).toHaveText("");

  await clickEditableTableCell(markdownTableCell(page, 9));
  await placeTableCaret(markdownTableCell(page, 9), 0);
  await page.keyboard.press("Alt+Delete");
  await expect(markdownTableCell(page, 9)).toHaveText("");

  await clickEditableTableCell(markdownTableCell(page, 10));
  await placeTableCaret(markdownTableCell(page, 10), 7);
  await page.keyboard.press("Meta+Backspace");
  await expect(markdownTableCell(page, 10)).toHaveText("");

  // Chromium does not natively implement Meta+Delete in contenteditable; the
  // table widget unit contract covers event ownership, and packaged WKWebView
  // acceptance must verify its mutation manually.

  await page.keyboard.press("Meta+s");
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  const expected = [
    "Before untouched",
    "",
    "| Backspace | Delete | Option backward | Option forward | Command backward | Command forward |",
    "| --- | --- | --- | --- | --- | --- |",
    "| ab | ef |  |  |  | delta |",
    "",
    "After untouched",
    "",
  ].join("\n");
  const writes = await page.evaluate(() =>
    (window.__E2E_PORT__?.writes ?? []).map((write) => write.text),
  );
  expect(writes).toEqual([expected]);
});

test("clicking a reading-mode Markdown table body cell enters editing and saves exact source", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });

  const host = page.locator(".markdown-editor");
  const table = markdownTable(page);
  const bodyCell = markdownTableCell(page, 2);
  await expect(table).toBeVisible();

  await page.getByRole("button", { name: "编辑模式" }).click();
  await expect(host).toHaveAttribute("data-view-mode", "reading");
  await expect(bodyCell).not.toHaveAttribute("contenteditable");

  await bodyCell.click();
  await expect(host).toHaveAttribute("data-view-mode", "editing");
  await expect(bodyCell).toBeFocused();

  await page.keyboard.type(" updated");
  await expect(bodyCell).toHaveText("Ada updated");
  await page.keyboard.press("Tab");
  await expect(markdownTableCell(page, 3)).toBeFocused();

  await page.keyboard.press("Meta+s");
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  const expected = [
    "Before untouched",
    "",
    "| Name | Note |",
    "| --- | --- |",
    "| Ada updated | old |",
    "",
    "After untouched",
    "",
  ].join("\n");
  const writes = await page.evaluate(() =>
    (window.__E2E_PORT__?.writes ?? []).map((write) => write.text),
  );
  expect(writes).toEqual([expected]);
});

test("navigates, appends, undoes, redoes, saves, and reads a Markdown table", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });

  const content = editorContent(page);
  const table = markdownTable(page);
  await expect(table).toBeVisible();
  await clickEditableTableCell(markdownTableCell(page, 2));
  await page.keyboard.type("|中文");

  await page.keyboard.press("Tab");
  await expect(markdownTableCell(page, 3)).toBeFocused();
  expect(
    await markdownTableCell(page, 3).evaluate((element) =>
      element.matches(":focus-visible")
    ),
  ).toBe(true);
  expect(
    await markdownTableCell(page, 3).evaluate((element) =>
      getComputedStyle(element).boxShadow
    ),
  ).not.toBe("none");

  await page.keyboard.press("Tab");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("th, td")).toHaveCount(6);
  await expect(markdownTableCell(page, 4)).toBeFocused();

  await page.keyboard.press("Meta+z");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("th, td")).toHaveCount(4);
  await expect(markdownTableCell(page, 2)).toHaveText("Ada|中文");
  await expect(markdownTableCell(page, 3)).toHaveText("old");

  await content.focus();
  await page.keyboard.press("Meta+Shift+z");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("th, td")).toHaveCount(6);
  await expect(content).toBeFocused();
  await expect(markdownTableCell(page, 2)).toHaveText("Ada|中文");

  await page.keyboard.press("Meta+s");
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  const expected = [
    "Before untouched",
    "",
    "| Name | Note |",
    "| --- | --- |",
    String.raw`| Ada\|中文 | old |`,
    "|  |  |",
    "",
    "After untouched",
    "",
  ].join("\n");
  const writes = await page.evaluate(() =>
    (window.__E2E_PORT__?.writes ?? []).map((write) => write.text),
  );
  expect(writes).toEqual([expected]);

  await page.getByRole("button", { name: "编辑模式" }).click();
  await expect(table).toBeVisible();
  await expect(page.getByRole("table", { name: "Markdown 表格" })).toBeVisible();
  await expect(table).not.toHaveAttribute("role");
  await expect(table).toHaveAttribute("aria-label", "Markdown 表格");
  await expect(markdownTableCell(page, 2)).not.toHaveAttribute("role");
  await expect(markdownTableCell(page, 2))
    .not.toHaveAttribute("contenteditable");
  expect(
    await markdownTableCell(page, 2).evaluate((element) =>
      (element as HTMLElement).tabIndex
    ),
  ).toBe(-1);
  const textBeforeReadingInput = await table.textContent();
  // Reading mode intentionally hands primary table-cell clicks back to
  // editing; keep this check outside a cell. The focused view-mode button
  // must not turn ordinary keyboard input into a document change.
  await page.keyboard.type("must-not-land");
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  await expect(table).toHaveText(textBeforeReadingInput!);
  expect(await page.evaluate(() => window.__E2E_PORT__?.writes.length ?? 0))
    .toBe(1);

  await page.getByRole("button", { name: "阅读模式" }).click();
  await expect(table).toHaveAttribute("role", "grid");
  await expect(markdownTableCell(page, 2)).toHaveAttribute("role", "gridcell");
  await expect(markdownTableCell(page, 2))
    .toHaveAttribute("contenteditable", "true");
  expect(
    await markdownTableCell(page, 2).evaluate((element) =>
      (element as HTMLElement).tabIndex
    ),
  ).toBe(0);
});

test("switches between editing and reading modes", async ({
  page,
}) => {
  await seed(page, {
    files: [
      {
        path: "/docs/fmt.md",
        text: "前导语句\n\n**加粗文本** 普通\n\n$E = mc^2$\n",
      },
    ],
    session: sessionWith("/docs/fmt.md"),
  });

  const content = editorContent(page);
  await content.waitFor();
  const host = page.locator(".markdown-editor");
  const toggle = page.getByRole("button", { name: "编辑模式" });

  // Editing (default): live preview hides markers while the cursor is away.
  await expect(host).toHaveAttribute("data-view-mode", "editing");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".cm-live-preview-strong")).toBeVisible();
  await expect(content).not.toContainText("**");

  // Reading: fully rendered, markers never revealed, typing is rejected.
  await toggle.click();
  await expect(host).toHaveAttribute("data-view-mode", "reading");
  await expect(
    page.getByRole("button", { name: "阅读模式" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(content).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".cm-live-preview-strong")).toBeVisible();
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(content).not.toContainText("**");
  await content.click();
  await page.keyboard.type("x");
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  await expect(content).not.toContainText("x");

  // Back to editing: editable again.
  await page.getByRole("button", { name: "阅读模式" }).click();
  await expect(host).toHaveAttribute("data-view-mode", "editing");
  await expect(content).toHaveAttribute("contenteditable", "true");
  // Park the cursor in the first line, away from the strong node — a cursor
  // inside it would reveal the markers by design.
  await content.locator(".cm-line").first().click();
  await expect(content).not.toContainText("**");
});

test("opens, navigates, collapses, and resizes the document outline", async ({
  page,
}) => {
  await seed(page, {
    files: [
      {
        path: "/docs/outline.md",
        text: [
          "# 第一章",
          "开场",
          "## 第一节",
          "内容",
          "### 细节",
          "更多内容",
          "# 第二章",
          "## 第二节",
          "结尾",
        ].join("\n"),
      },
    ],
    session: {
      ...sessionWith("/docs/outline.md")!,
      outline: { width: 336 },
    },
  });

  const modeToggle = page.getByRole("button", { name: "编辑模式" });
  const outlineToggle = page.getByRole("button", { name: "展开右侧栏" });
  await expect(modeToggle).toBeVisible();
  await expect(outlineToggle).toHaveAttribute("aria-expanded", "false");
  // The view-mode control lives in the editor-pane toolbar while the
  // right-sidebar toggle stays in the header.
  await expect(page.locator(".editor-toolbar .view-mode-toggle")).toBeVisible();
  await expect(page.locator(".app-header .right-sidebar-toggle")).toBeVisible();

  await outlineToggle.click();
  const outline = page.getByRole("complementary", { name: "大纲侧栏" });
  await expect(outline).toBeVisible();
  await expect(outline).toHaveCSS("width", "336px");
  await expect(outline.locator(".outline-content")).toHaveAttribute(
    "data-motion-list",
    "outline",
  );
  await expect(outline.getByRole("treeitem")).toHaveCount(5);
  await expect(outline.locator("[data-motion-item]")).toHaveCount(5);

  await outline.getByRole("treeitem", { name: "第一节" }).click();
  await expect(editorContent(page)).toBeFocused();

  await outline.getByRole("button", { name: "全部折叠" }).click();
  await expect(outline.getByRole("treeitem", { name: "第一节" })).toHaveCount(0);
  await expect(outline.getByRole("treeitem", { name: "第二节" })).toHaveCount(0);
  const expandAllButton = outline.getByRole("button", { name: "全部展开" });
  await expect(expandAllButton).toBeEnabled();

  await expandAllButton.click();
  await expect(outline.getByRole("treeitem", { name: "第一节" })).toBeVisible();
  await outline.getByRole("button", { name: "全部折叠" }).click();
  await expect(outline.getByRole("treeitem", { name: "第一节" })).toHaveCount(0);

  await outline.getByRole("button", { name: "展开 第二章" }).click();
  await expect(outline.getByRole("treeitem", { name: "第二节" })).toBeVisible();

  const resizer = page.getByRole("separator", { name: "调整大纲宽度" });
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 3, box!.y + 60);
  await page.mouse.down();
  await page.mouse.move(box!.x - 41, box!.y + 60);
  await page.mouse.up();
  await expect(outline).toHaveCSS("width", "380px");

  await page.getByRole("button", { name: "收起右侧栏" }).click();
  await expect(outlineToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#app-outline")).toHaveAttribute("inert", "");

  await page.reload();
  await expect(page.getByRole("button", { name: "展开右侧栏" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("renders valid LaTeX and flags invalid LaTeX without blocking edits", async ({
  page,
}) => {
  await seed(page, {
    files: [
      {
        path: "/docs/math.md",
        text: "公式\n\n$E = mc^2$\n\n$\\notarealcommand$\n",
      },
    ],
    session: sessionWith("/docs/math.md"),
  });

  await editorContent(page).waitFor();
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(page.locator(".md-math-error").first()).toBeVisible();

  // A broken formula must not block editing or saving the rest of the document.
  await editorContent(page).click();
  await page.keyboard.type("x");
  await expect(page.locator(".tab-dirty")).toHaveCount(1);
});

test("finds and replaces text in the current document", async ({ page }) => {
  await seed(page, {
    files: [{ path: "/docs/search.md", text: "foo 一\n\nbar foo\n" }],
    session: sessionWith("/docs/search.md"),
  });

  const content = editorContent(page);
  await content.waitFor();
  await content.click();
  await page.keyboard.press("Meta+f");
  const panel = page.locator(".cm-panel.cm-search");
  await panel.waitFor();
  await panel.locator('input[name="search"]').fill("foo");
  await page.keyboard.press("Enter");
  await panel.locator('input[name="replace"]').fill("baz");
  await panel.locator('button[name="replaceAll"]').click();

  await expect(content).toContainText("baz 一");
  await expect(content).toContainText("bar baz");
  await expect(content).not.toContainText("foo");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-panel.cm-search")).toHaveCount(0);
});

test("opens the folder drawer and opens a file from the tree", async ({
  page,
}) => {
  await seed(page, {
    files: [
      { path: "/docs/readme.md", text: "# 说明\n" },
      { path: "/docs/notes/a.md", text: "# 笔记 A\n" },
    ],
    workspace: { path: "/docs", title: "docs" },
  });

  await page.getByRole("button", { name: "打开文件夹" }).click();
  const sidebar = page.locator('aside[aria-label="侧栏"]');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator(".file-tree")).toHaveAttribute(
    "data-motion-list",
    "files",
  );

  await sidebar
    .getByRole("treeitem", { name: "notes" })
    .locator(".file-tree-name")
    .click();
  await sidebar
    .getByRole("treeitem", { name: /a\.md/ })
    .locator(".file-tree-name")
    .click();
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveAttribute(
    "data-motion-item",
    "tab",
  );
  await expect(editorContent(page)).toContainText("笔记 A");

  // The drawer stays manually collapsible.
  const sidebarRail = sidebar.locator("..");
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(sidebarRail).toHaveAttribute("data-collapsed", "true");
  await expect(sidebarRail).toHaveCSS("width", "0px");
  await page.getByRole("button", { name: "展开侧栏" }).click();
  await expect(page.locator('aside[aria-label="侧栏"]')).toBeVisible();
  await expect(sidebarRail).toHaveAttribute("data-collapsed", "false");
  await expect(sidebarRail).toHaveCSS("width", "260px");
});

test("surfaces an external conflict and keeps local edits", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/conflict.md", text: "本地版本\n" }],
    session: sessionWith("/docs/conflict.md"),
  });

  const content = editorContent(page);
  await content.waitFor();
  await content.click();
  await page.keyboard.type(" 本地修改");
  await expect(page.locator(".tab-dirty")).toHaveCount(1);

  // Another process rewrites the file underneath the dirty tab.
  await page.evaluate(() => {
    window.__E2E_PORT__?.updateFile("/docs/conflict.md", "磁盘版本\n", "disk-v2", 2);
    window.__E2E_PORT__?.emitDiskEvent({
      kind: "changed",
      path: "/docs/conflict.md",
      modifiedUnixMs: 2,
      version: "disk-v2",
    });
  });

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("文件已在磁盘上更改");
  await dialog.getByRole("button", { name: "保留当前版本" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(content).toContainText("本地修改");
  await expect(content).not.toContainText("磁盘版本");
});

test("offers recovery drafts on launch and restores one explicitly", async ({
  page,
}) => {
  await seed(page, {
    drafts: [
      {
        draftId: "draft-1",
        originalPath: "/docs/lost.md",
        title: "lost.md",
        text: "崩溃前未保存的内容\n",
        hasUtf8Bom: false,
        newline: "lf",
        savedTextHash: "hash-1",
        savedVersion: "v1",
      },
    ],
  });

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("恢复未保存的更改");
  await dialog.getByRole("button", { name: "查看源码" }).click();
  await expect(dialog).toContainText("崩溃前未保存的内容");
  await dialog.getByRole("button", { name: "恢复" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(editorContent(page)).toContainText("崩溃前未保存的内容");
  await expect(page.locator(".tab-dirty")).toHaveCount(1);
});
