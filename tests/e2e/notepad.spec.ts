import { expect, test, type Page } from "@playwright/test";

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

test("switches between editing, reading, and source modes", async ({
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
  const switcher = page.getByRole("group", { name: "视图模式" });

  // Editing (default): live preview hides markers while the cursor is away.
  await expect(host).toHaveAttribute("data-view-mode", "editing");
  await expect(page.locator(".cm-live-preview-strong")).toBeVisible();
  await expect(content).not.toContainText("**");

  // Reading: fully rendered, markers never revealed, typing is rejected.
  await switcher.getByRole("button", { name: "阅读" }).click();
  await expect(host).toHaveAttribute("data-view-mode", "reading");
  await expect(content).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".cm-live-preview-strong")).toBeVisible();
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(content).not.toContainText("**");
  await content.click();
  await page.keyboard.type("x");
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  await expect(content).not.toContainText("x");

  // Source: raw text, editable again.
  await switcher.getByRole("button", { name: "源码" }).click();
  await expect(host).toHaveAttribute("data-view-mode", "source");
  await expect(content).toContainText("**加粗文本**");
  await content.click();
  await page.keyboard.type("!");
  await expect(content).toContainText("!");

  // Back to editing: undo history survived the mode switches.
  await switcher.getByRole("button", { name: "编辑" }).click();
  await expect(host).toHaveAttribute("data-view-mode", "editing");
  // Park the cursor in the first line, away from the strong node — a cursor
  // inside it would reveal the markers by design.
  await content.locator(".cm-line").first().click();
  await expect(content).not.toContainText("**");
  await page.keyboard.press("Meta+z");
  await expect(content).not.toContainText("!");
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

  await sidebar
    .getByRole("treeitem", { name: "notes" })
    .locator(".file-tree-name")
    .click();
  await sidebar
    .getByRole("treeitem", { name: /a\.md/ })
    .locator(".file-tree-name")
    .click();
  await expect(page.getByRole("tab", { name: "a.md" })).toHaveCount(1);
  await expect(editorContent(page)).toContainText("笔记 A");

  // The drawer stays manually collapsible.
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await expect(page.locator('aside[aria-label="侧栏"]')).toHaveCount(0);
  await page.getByRole("button", { name: "展开侧栏" }).click();
  await expect(page.locator('aside[aria-label="侧栏"]')).toBeVisible();
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
