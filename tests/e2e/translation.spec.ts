import { expect, test, type Page } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

/**
 * Browser-shell E2E flows for the document translation feature.
 *
 * Seeding mirrors tests/e2e/notepad.spec.ts: a JSON fixture is installed on
 * window.__E2E_FIXTURE__ before the app loads; the app (VITE_E2E=1) builds a
 * MemoryDocumentPort from it and publishes it as window.__E2E_PORT__. The
 * memory port's pseudo-translation renders ASCII letters as full-width (no
 * marker characters, Markdown structure untouched) and counts new (uncached)
 * translateSegments calls on translationCallCount, so the spec can verify
 * both the render contract and the "no API calls on re-show" guarantee
 * without a provider.
 *
 * The toolbar button's aria-label contract is fixed: 翻译文档 → 取消翻译
 * (while translating) → 显示原文 (translation shown) → 显示译文 (original
 * shown again).
 *
 * The fixture shape and the window.__E2E_FIXTURE__ / __E2E_PORT__ types come
 * from the shell itself (src/app/e2e.ts) via a type-only import: erased at
 * runtime, the fixture still travels as JSON through addInitScript.
 */

/** Installs the fixture before page scripts run, then loads the shell. */
const seed = async (page: Page, fixture: E2eFixtureSpec) => {
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");
};

/** Session with the translation provider preconfigured (no key in it). */
const sessionWithTranslation = (
  ...paths: string[]
): E2eFixtureSpec["session"] => ({
  recent: [],
  openPaths: paths,
  activePath: paths.at(-1) ?? null,
  workspacePath: null,
  translationSettings: {
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    targetLanguage: "中文",
    concurrency: 10,
  },
});

/**
 * Stores the provider key the way the settings dialog does: through the port,
 * under the slot the configured endpoint+model address ("custom" here — the
 * fixture's provider matches no preset). The key lives in the credential
 * store only; a session can no longer carry one.
 */
const seedTranslationKey = async (page: Page, slot = "custom") => {
  await page.waitForFunction(() => window.__E2E_PORT__ !== undefined);
  await page.evaluate(
    ([keySlot]) => window.__E2E_PORT__?.storeTranslationKey(keySlot, "test-key"),
    [slot],
  );
};

const editorHost = (page: Page) => page.locator(".markdown-editor");
const editorContent = (page: Page) => page.locator(".cm-content");

const translationCallCount = (page: Page) =>
  page.evaluate(() => window.__E2E_PORT__?.translationCallCount ?? -1);

/** Frontmatter, ordinary paragraphs, and a fenced code block. */
const documentSource = [
  "---",
  "title: 示例文档",
  "---",
  "",
  "Hello Opus, 第一段文字。",
  "",
  "Second paragraph, 第二段文字。",
  "",
  "```rust",
  "let x = 1;",
  "```",
  "",
].join("\n");

test("translates a document, forces reading mode, and toggles back without new API calls", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/translate.md", text: documentSource }],
    session: sessionWithTranslation("/docs/translate.md"),
  });
  await seedTranslationKey(page);

  const content = editorContent(page);
  await content.waitFor();
  await expect(content).toContainText("Hello Opus, 第一段文字。");
  await expect(content).not.toContainText("Ｈｅｌｌｏ");

  // The translate/view-mode toggles render only while the outline is open.
  await page.getByRole("button", { name: "展开右侧栏" }).click();

  // Translate: the pseudo-translation full-widths the ASCII letters.
  await page.getByRole("button", { name: "翻译文档", exact: true }).click();
  await expect(content).toContainText("Ｈｅｌｌｏ Ｏｐｕｓ, 第一段文字。");
  await expect(content).toContainText("Ｓｅｃｏｎｄ ｐａｒａｇｒａｐｈ, 第二段文字。");

  // The fenced code block and frontmatter are protected segments: verbatim.
  // (Reading mode hides frontmatter entirely — see hiddenFrontmatterField —
  // so its preservation is asserted on the restored original below.)
  const codeBlock = content.locator(".cm-live-preview-code-block", {
    hasText: "let x = 1;",
  });
  await expect(codeBlock).toContainText("let x = 1;");
  await expect(codeBlock).not.toContainText("ｌｅｔ");

  // The translated view is read-only: forced reading mode, editor locked.
  await expect(editorHost(page)).toHaveAttribute("data-view-mode", "reading");
  await expect(content).toHaveAttribute("contenteditable", "false");
  // The success banner clears once the translation completes.
  await expect(page.locator(".translation-banner")).toHaveCount(0);

  // The batched protocol packs every pending chunk into as few calls as
  // possible: both paragraphs fit one batch here (frontmatter and the fenced
  // code block are protected), so exactly one new call is issued.
  expect(await translationCallCount(page)).toBe(1);

  // Back to the original: restored verbatim, no full-width letters anywhere.
  const toggle = page.getByRole("button", { name: "显示原文", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(content).not.toContainText("Ｈｅｌｌｏ");
  await expect(content).toContainText("Hello Opus, 第一段文字。");
  // Frontmatter survived the round trip untranslated.
  await expect(content).toContainText("title: 示例文档");
  await expect(
    page.getByRole("button", { name: "显示译文", exact: true }),
  ).toBeVisible();

  // Showing the translation again reuses the in-memory session result: the
  // same segments hit the cache, so no new calls are issued.
  await page.getByRole("button", { name: "显示译文", exact: true }).click();
  await expect(content).toContainText("Ｈｅｌｌｏ Ｏｐｕｓ, 第一段文字。");
  expect(await translationCallCount(page)).toBe(1);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // The key never entered the session: the frontend addresses it by slot and
  // the secret stays in the credential store.
  const persisted = await page.evaluate(() =>
    JSON.stringify(window.__E2E_PORT__?.session ?? null),
  );
  expect(persisted).not.toContain("test-key");
  expect(persisted).not.toContain("apiKey");
});
