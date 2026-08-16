// One-off screenshot script: demo mode toolbar + translation flow.
import { chromium } from "playwright";

const base = "http://localhost:1420/?demo=1";
const out = "docs/screenshots";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(base, { waitUntil: "networkidle" });
await page.locator(".cm-content").first().waitFor();

// 1. Idle toolbar (top-right of the editor area).
const toolbar = page.locator(".editor-toolbar");
await toolbar.waitFor();
await page.screenshot({ path: `${out}/translation-1-toolbar-idle.png` });

// 2. Open settings, fill a dummy API key so the controller allows translation.
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.locator("#settings-translation-api-key").waitFor();
await page.screenshot({ path: `${out}/translation-2-settings.png` });
await page.locator("#settings-translation-api-key").fill("sk-demo");
await page.locator("#settings-translation-api-key").press("Enter");
await page.getByRole("button", { name: "完成", exact: true }).click();

// 3. Translate: banner while working, then the translated read-only view.
await page.getByRole("button", { name: "翻译文档", exact: true }).click();
const translated = page.locator(".cm-content", { hasText: "Ｏｐｕｓ" }).first();
await translated.waitFor();
await page.screenshot({ path: `${out}/translation-3-translated.png` });

// 4. Back to the original.
await page.getByRole("button", { name: "显示原文", exact: true }).click();
await page.screenshot({ path: `${out}/translation-4-restored.png` });

await browser.close();
console.log("screenshots written to", out);
