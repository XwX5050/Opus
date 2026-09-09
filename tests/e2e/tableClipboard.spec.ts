import { expect, test, type Locator, type Page } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

/**
 * F01 regression spec: rendered table cells own the clipboard. Partial
 * selections, select-all, keyboard shortcuts and context-menu commands must
 * all read/write the cell's DOM selection (never CodeMirror's state
 * selection), a cut may only change that cell and must commit back to the
 * Markdown source, and whole-document / reading-mode copy must keep working.
 *
 * Fixture, clipboard-permission and table helpers mirror notepad.spec.ts.
 */
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

const isMac = process.platform === "darwin";
const modKey = isMac ? "Meta" : "Control";
const modShortcut = (key: string) => `${modKey}+${key}`;

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

const selectCellRange = async (cell: Locator, start: number, end: number) => {
  await cell.evaluate(
    (element, [rangeStart, rangeEnd]) => {
      const text = element.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) {
        throw new Error("Expected a plain-text Markdown table cell");
      }
      const range = document.createRange();
      range.setStart(text, rangeStart);
      range.setEnd(text, rangeEnd);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    [start, end] as const,
  );
};

const domSelectionText = (page: Page) =>
  page.evaluate(() => window.getSelection()?.toString() ?? "");

const clipboardText = (page: Page) =>
  page.evaluate(() => navigator.clipboard.readText());

const writeClipboard = (page: Page, text: string) =>
  page.evaluate((value) => navigator.clipboard.writeText(value), text);

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(
    ["clipboard-read", "clipboard-write"],
    { origin: "http://localhost:1421" },
  );
});

test("copies a partial cell DOM selection with the copy shortcut", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  const cell = markdownTableCell(page, 2);
  await expect(cell).toBeVisible();
  await clickEditableTableCell(cell);
  await selectCellRange(cell, 0, 2);
  await writeClipboard(page, "AUDIT_SENTINEL");

  await page.keyboard.press(modShortcut("c"));

  expect(await clipboardText(page)).toBe("Ad");
  // The document was not touched by the copy.
  expect(await domSelectionText(page)).toBe("Ad");
  expect(await cell.textContent()).toBe("Ada");
});

test("cuts a partial cell selection with the cut shortcut and commits only that cell", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  const cell = markdownTableCell(page, 2);
  await expect(cell).toBeVisible();
  await clickEditableTableCell(cell);
  await selectCellRange(cell, 0, 2);
  await writeClipboard(page, "AUDIT_SENTINEL");

  await page.keyboard.press(modShortcut("x"));

  expect(await clipboardText(page)).toBe("Ad");
  await expect(cell).toHaveText("a");
  await expect(markdownTableCell(page, 3)).toHaveText("old");

  await page.keyboard.press(modShortcut("s"));
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  const expected = tableDocumentSource.replace("| Ada | old |", "| a | old |");
  const writes = await page.evaluate(() =>
    (window.__E2E_PORT__?.writes ?? []).map((write) => write.text),
  );
  expect(writes).toEqual([expected]);
});

test("select-all inside a cell selects the cell and copies its content", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  const cell = markdownTableCell(page, 2);
  await expect(cell).toBeVisible();
  await clickEditableTableCell(cell);
  await placeTableCaret(cell, 2);
  await writeClipboard(page, "AUDIT_SENTINEL");

  await page.keyboard.press(modShortcut("a"));
  expect(await domSelectionText(page)).toBe("Ada");

  await page.keyboard.press(modShortcut("c"));
  expect(await clipboardText(page)).toBe("Ada");
});

test("copies the selected cell text from the context menu and keeps the selection", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  const cell = markdownTableCell(page, 2);
  await expect(cell).toBeVisible();
  await clickEditableTableCell(cell);
  await selectCellRange(cell, 1, 3);
  await writeClipboard(page, "AUDIT_SENTINEL");

  await cell.click({ button: "right" });
  await page.getByRole("menu").waitFor();
  await page.getByRole("menuitem", { name: "复制" }).click();

  expect(await clipboardText(page)).toBe("da");
  // Opening and closing the menu kept the cell's DOM selection alive.
  await expect(cell).toBeFocused();
  expect(await domSelectionText(page)).toBe("da");
  expect(await cell.textContent()).toBe("Ada");
});

test("cuts the selected cell text from the context menu and commits only that cell", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  const cell = markdownTableCell(page, 2);
  await expect(cell).toBeVisible();
  await clickEditableTableCell(cell);
  // The selection covers the cell centre the right-click lands on; a
  // right-click outside a contenteditable selection would move the caret.
  await selectCellRange(cell, 1, 3);
  await writeClipboard(page, "AUDIT_SENTINEL");

  await cell.click({ button: "right" });
  await page.getByRole("menu").waitFor();
  await page.getByRole("menuitem", { name: "剪切" }).click();

  expect(await clipboardText(page)).toBe("da");
  await expect(cell).toHaveText("A");
  await expect(markdownTableCell(page, 3)).toHaveText("old");

  await page.keyboard.press(modShortcut("s"));
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  const expected = tableDocumentSource.replace("| Ada | old |", "| A | old |");
  const writes = await page.evaluate(() =>
    (window.__E2E_PORT__?.writes ?? []).map((write) => write.text),
  );
  expect(writes).toEqual([expected]);
});

test("pastes clipboard text into the cell at the caret via the context menu", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  const cell = markdownTableCell(page, 2);
  await expect(cell).toBeVisible();
  await clickEditableTableCell(cell);
  await placeTableCaret(cell, 1);
  await writeClipboard(page, "XY\nZ");

  // A right-click in an editing host moves the caret to the click point, so
  // open the menu exactly at the caret's own coordinates; the menu restores
  // that caret before the paste item runs.
  const caret = await cell.evaluate((element) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) {
      throw new Error("Expected a plain-text Markdown table cell");
    }
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 2);
    const rect = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { x: rect.left, y: box.top + box.height / 2 };
  });
  await page.mouse.click(caret.x + 1, caret.y, { button: "right" });
  await page.getByRole("menu").waitFor();
  const caretOffset = await cell.evaluate((element) => {
    const range = window.getSelection()?.getRangeAt(0);
    if (!range || range.startContainer !== element.firstChild) return -1;
    return range.startOffset;
  });
  expect(caretOffset).toBe(1);

  await page.getByRole("menuitem", { name: "粘贴" }).click();

  // Plain text (including IME-committed text) is pasted at that caret.
  await expect(cell).toHaveText("AXY Zda");
  await expect(page.locator(".tab-dirty")).toHaveCount(1);

  await page.keyboard.press(modShortcut("s"));
  await expect(page.locator(".tab-dirty")).toHaveCount(0);
  const expected = tableDocumentSource.replace(
    "| Ada | old |",
    "| AXY Zda | old |",
  );
  const writes = await page.evaluate(() =>
    (window.__E2E_PORT__?.writes ?? []).map((write) => write.text),
  );
  expect(writes).toEqual([expected]);
});

test("select-all from the context menu selects the whole cell", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  const cell = markdownTableCell(page, 2);
  await expect(cell).toBeVisible();
  await clickEditableTableCell(cell);
  await placeTableCaret(cell, 1);
  await writeClipboard(page, "AUDIT_SENTINEL");

  await cell.click({ button: "right" });
  await page.getByRole("menu").waitFor();
  await page.getByRole("menuitem", { name: "全选" }).click();

  expect(await domSelectionText(page)).toBe("Ada");
  await page.keyboard.press(modShortcut("c"));
  expect(await clipboardText(page)).toBe("Ada");
});

test("whole-document select and copy still copies the raw Markdown source", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  await expect(markdownTable(page)).toBeVisible();
  await page
    .locator(".cm-line")
    .filter({ hasText: "After untouched" })
    .click();
  await writeClipboard(page, "AUDIT_SENTINEL");

  await page.keyboard.press(modShortcut("a"));
  await page.keyboard.press(modShortcut("c"));

  expect(await clipboardText(page)).toBe(tableDocumentSource);
});

test("reading-mode selection copy keeps copying the rendered text", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/table.md", text: tableDocumentSource }],
    session: sessionWith("/docs/table.md"),
  });
  const host = page.locator(".markdown-editor");
  await expect(markdownTable(page)).toBeVisible();
  await page.getByRole("button", { name: "展开右侧栏" }).click();
  await page.getByRole("button", { name: "编辑模式" }).click();
  await expect(host).toHaveAttribute("data-view-mode", "reading");
  await expect(markdownTableCell(page, 2)).not.toHaveAttribute(
    "contenteditable",
  );
  await writeClipboard(page, "AUDIT_SENTINEL");

  // Mouse-selecting rendered reading-mode text and copying it must keep
  // working (CodeMirror's own flow, untouched by the editable-cell path).
  const line = page.locator(".cm-line").filter({ hasText: "After untouched" });
  const box = await line.boundingBox();
  if (!box) throw new Error("Missing reading line");
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  expect(await domSelectionText(page)).toBe("After untouched");

  await page.keyboard.press(modShortcut("c"));

  expect(await clipboardText(page)).toBe("After untouched");
  expect(await page.locator(".tab-dirty")).toHaveCount(0);
});
