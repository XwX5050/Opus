#!/usr/bin/env node
/**
 * Captures light/dark screenshots (1080×760) into docs/screenshots/.
 *
 * The app is driven in dev-only demo mode (`?demo=1`), which renders the
 * full shell against the in-memory document port — no Tauri runtime needed.
 * Usage:
 *
 *   npm run dev &                      # serve on http://localhost:1420
 *   node scripts/capture-screenshots.mjs
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE_URL = process.env.DEMO_URL ?? "http://localhost:1420";
// fileURLToPath (not URL.pathname) so paths with spaces or escaped
// characters resolve to the real directory.
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../docs/screenshots",
);

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
try {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({
      viewport: { width: 1080, height: 760 },
      colorScheme: theme,
    });
    await page.goto(`${BASE_URL}/?demo=1&theme=${theme}`, {
      waitUntil: "networkidle",
    });
    // Wait for the editor, KaTeX and fonts to settle before capturing.
    await page.waitForSelector(".cm-content");
    await page.waitForSelector(".katex");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, `${theme}.png`) });
    console.log(`captured ${theme}.png`);
    await page.close();
  }
} finally {
  await browser.close();
}
