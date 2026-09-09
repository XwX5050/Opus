import { chromium } from "../../../../node_modules/playwright/index.mjs";
import { writeFile } from "node:fs/promises";

// Run against the E2E fixture server on 127.0.0.1:1422. Only synthetic text
// is used; the previous system clipboard text is restored before exit.
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const source = "Before untouched\n\n| Name | Note |\n| --- | --- |\n| Ada | old |\n\nAfter untouched\n";
await page.addInitScript(source => {
  window.__E2E_FIXTURE__ = {
    files: [{ path: "/docs/audit.md", text: source }],
    session: { recent: [], openPaths: ["/docs/audit.md"], activePath: "/docs/audit.md", workspacePath: null },
  };
}, source);
const results = {};
let originalClipboard;
try {
  await page.goto("http://127.0.0.1:1422/");
  await page.waitForLoadState("networkidle");
  results.dom = await page.locator("table.md-table").evaluate(node => node.outerHTML);
  originalClipboard = await page.evaluate(() => navigator.clipboard.readText());
  const cell = page.locator('table.md-table [data-cell-index="2"]');
  const selectCell = async () => {
    await cell.click();
    await cell.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
  };
  const snapshot = () => page.evaluate(() => ({
    selection: getSelection()?.toString(), active: document.activeElement?.outerHTML.slice(0, 180),
  }));
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await selectCell();
  results.beforeShortcut = await snapshot();
  await page.evaluate(() => navigator.clipboard.writeText("AUDIT_SENTINEL"));
  await page.keyboard.press(`${mod}+c`);
  results.shortcutClipboard = await page.evaluate(() => navigator.clipboard.readText());
  await selectCell();
  results.beforeMenu = await snapshot();
  await page.evaluate(() => navigator.clipboard.writeText("AUDIT_SENTINEL"));
  await cell.click({ button: "right" });
  await page.getByRole("menu").waitFor();
  results.menuOpen = await snapshot();
  await page.getByRole("menuitem", { name: /复制/ }).click();
  results.afterMenu = await snapshot();
  results.menuClipboard = await page.evaluate(() => navigator.clipboard.readText());

  await selectCell();
  await page.evaluate(() => navigator.clipboard.writeText("AUDIT_PASTE"));
  await cell.click({ button: "right" });
  await page.getByRole("menuitem", { name: /粘贴/ }).click();
  results.afterMenuPaste = await cell.textContent();
  // Standalone CodeMirror selection used as a control for the table copy.
  await page.locator(".cm-line").filter({ hasText: "After untouched" }).click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+c`);
  results.wholeDocumentClipboard = await page.evaluate(() => navigator.clipboard.readText());
  await page.reload();
  await page.waitForLoadState("networkidle");
  await selectCell();
  await page.keyboard.press(`${mod}+x`);
  results.cutClipboard = await page.evaluate(() => navigator.clipboard.readText());
  await page.locator(".cm-line").filter({ hasText: "After untouched" }).click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press(`${mod}+c`);
  results.documentAfterCellCut = await page.evaluate(() => navigator.clipboard.readText());
  await page.screenshot({ path: "/tmp/opus-audit-20260909/table-browser.png", fullPage: true });
  await writeFile("/tmp/opus-audit-20260909/browser-probes.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (originalClipboard !== undefined) {
    await page.evaluate(value => navigator.clipboard.writeText(value), originalClipboard);
  }
  await browser.close();
}
