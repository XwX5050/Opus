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

const BASE_URL = process.env.DEMO_URL ?? "http://localhost:1420";
const OUT_DIR = new URL("../docs/screenshots/", import.meta.url).pathname;

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
    await page.screenshot({ path: `${OUT_DIR}${theme}.png` });
    console.log(`captured ${theme}.png`);
    await page.close();
  }
} finally {
  await browser.close();
}
