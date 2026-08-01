import { expect, test, type Page } from "@playwright/test";

/**
 * Reading-column layout regression coverage (the proportional-scaling change
 * in src/theme/app.css): the .cm-content column is centered inside the
 * .cm-scroller, grows with the window up to a cap (1.6x the base preference),
 * keeps a margin on both edges on narrow windows, and the scroller runs
 * edge-to-edge so the vertical scrollbar rides the window edge instead of
 * the text column.
 *
 * Fixture/seeding mirrors tests/e2e/notepad.spec.ts: the JSON fixture is
 * installed on window.__E2E_FIXTURE__ before the app loads, and the app
 * (VITE_E2E=1) builds a MemoryDocumentPort from it. The default "内容宽度"
 * preference (--editor-content-width) is 760px.
 *
 * Geometry is measured with getBoundingClientRect() (border boxes) plus the
 * scroller's clientWidth (excludes the scrollbar gutter), so margins are
 * compared against the scroller's content box — the box the column actually
 * centers within via margin-inline: auto — and stay correct whether or not
 * the vertical scrollbar takes space. Assertions tolerate a few px of slack
 * for scrollbar and rounding differences.
 */

interface E2eFileSpec {
  path: string;
  text: string;
}

interface E2eSessionSpec {
  recent: Array<{ path: string; kind: "file" | "folder" }>;
  openPaths: string[];
  activePath: string | null;
  workspacePath: string | null;
}

interface E2eFixtureSpec {
  files?: E2eFileSpec[];
  session?: E2eSessionSpec | null;
}

declare global {
  interface Window {
    __E2E_FIXTURE__?: E2eFixtureSpec;
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

interface ColumnMetrics {
  width: number;
  leftMargin: number;
  rightMargin: number;
  scrollerRight: number;
  editorRight: number;
}

const measureColumn = (page: Page) =>
  page.evaluate((): ColumnMetrics => {
    const editor = document.querySelector<HTMLElement>(".markdown-editor");
    const scroller = document.querySelector<HTMLElement>(
      ".markdown-editor .cm-scroller",
    );
    const content = document.querySelector<HTMLElement>(
      ".markdown-editor .cm-content",
    );
    if (!editor || !scroller || !content) {
      throw new Error("editor layout not ready");
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const contentBoxRight = scrollerRect.left + scroller.clientWidth;
    return {
      width: contentRect.width,
      leftMargin: contentRect.left - scrollerRect.left,
      rightMargin: contentBoxRight - contentRect.right,
      scrollerRight: scrollerRect.right,
      editorRight: editor.getBoundingClientRect().right,
    };
  });

/** The column is centered: its auto margins are within a few px of equal. */
const expectCentered = (metrics: ColumnMetrics) => {
  expect(Math.abs(metrics.leftMargin - metrics.rightMargin)).toBeLessThanOrEqual(2);
};

/** The scroller runs edge-to-edge, so the scrollbar rides the window edge. */
const expectEdgeToEdgeScroller = (metrics: ColumnMetrics) => {
  expect(Math.abs(metrics.scrollerRight - metrics.editorRight)).toBeLessThanOrEqual(1);
};

const columnDocument = ["# 宽度", "", "内容", ""].join("\n");

test("centers the reading column at the default viewport with at least the base width", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/width.md", text: columnDocument }],
    session: sessionWith("/docs/width.md"),
  });

  await expect(page.locator(".markdown-editor .cm-content")).toBeVisible();
  const metrics = await measureColumn(page);

  // The base preference is 760px; at 1280 the 68% share exceeds it, so the
  // column is at least that wide.
  expect(metrics.width).toBeGreaterThanOrEqual(700);
  expectCentered(metrics);
  expectEdgeToEdgeScroller(metrics);
});

test("scales the column up with the window but caps it on ultra-wide viewports", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/width.md", text: columnDocument }],
    session: sessionWith("/docs/width.md"),
  });

  await expect(page.locator(".markdown-editor .cm-content")).toBeVisible();
  const defaultMetrics = await measureColumn(page);

  await page.setViewportSize({ width: 2100, height: 900 });
  const wideMetrics = await measureColumn(page);

  // The column grows proportionally with the window...
  expect(wideMetrics.width).toBeGreaterThan(defaultMetrics.width);
  // ...but never above 1.6x the 760px base (1216px); a few px of slack for
  // rounding. This is the proportional-scaling regression guard.
  expect(wideMetrics.width).toBeLessThanOrEqual(1224);
  expectCentered(wideMetrics);
  expectEdgeToEdgeScroller(wideMetrics);
});

test("keeps a margin on both edges at a narrow viewport and keeps the scrollbar at the window edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await seed(page, {
    files: [{ path: "/docs/width.md", text: columnDocument }],
    session: sessionWith("/docs/width.md"),
  });

  await expect(page.locator(".markdown-editor .cm-content")).toBeVisible();
  const metrics = await measureColumn(page);

  // On narrow windows the column shrinks (or falls back to the base width)
  // instead of touching the edges; 24px is the CSS target, allow a few px.
  expect(metrics.leftMargin).toBeGreaterThanOrEqual(19);
  expect(metrics.rightMargin).toBeGreaterThanOrEqual(19);
  expectEdgeToEdgeScroller(metrics);
});
