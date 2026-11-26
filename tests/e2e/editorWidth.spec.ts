import { expect, test, type Page } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

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
 * (VITE_E2E=1) builds a MemoryDocumentPort from it. The fixture shape is the
 * shell's E2eFixtureSpec (type-only import from src/app/e2e.ts). The default
 * "内容宽度" preference (--editor-content-width) is 760px.
 *
 * Geometry is measured with getBoundingClientRect() (border boxes) plus the
 * scroller's clientWidth (excludes the scrollbar gutter), so margins are
 * compared against the scroller's content box — the box the column actually
 * centers within via margin-inline: auto — and stay correct whether or not
 * the vertical scrollbar takes space. Assertions tolerate a few px of slack
 * for scrollbar and rounding differences.
 */

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

test("moves the tab bar in the same frame as a live sidebar resize", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/width.md", text: columnDocument }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      ...sessionWith("/docs/width.md"),
      workspacePath: "/docs",
    },
  });

  const sidebar = page.getByRole("complementary", { name: "侧栏" });
  const resizer = page.getByRole("slider", { name: "调整侧栏宽度" });
  const tabsBar = page.locator(".document-tabs-bar");
  await expect(resizer).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "260px");
  await expect(page.locator(".app-header")).toHaveCSS("transform", "none");

  const initialTabs = await tabsBar.boundingBox();
  const handle = await resizer.boundingBox();
  if (!initialTabs || !handle) throw new Error("resize layout not ready");

  await page.mouse.move(handle.x + handle.width / 2, handle.y + 180);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 72, handle.y + 180, {
    steps: 6,
  });

  const duringDrag = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar")!.getBoundingClientRect();
    const tabs = document.querySelector(".document-tabs-bar")!.getBoundingClientRect();
    const firstTab = document.querySelector(".tab-item")!.getBoundingClientRect();
    return { sidebarRight: sidebar.right, tabsLeft: tabs.left, tabLeft: firstTab.left };
  });
  expect(Math.abs(duringDrag.sidebarRight - duringDrag.tabsLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(duringDrag.tabsLeft - initialTabs.x - 72)).toBeLessThanOrEqual(1);

  await page.mouse.up();
  await expect(tabsBar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "332px");
});

/* ---------- Shell panel layout: editor floor and panel caps ---------- */

const longDocument = [
  "# 宽度",
  "",
  ...Array.from({ length: 80 }, (_, index) => `段落 ${index + 1}：这是一行用于滚动测试的内容。`),
  "",
].join("\n");

const sidebarPreferences = (width: number, collapsed = false) => ({
  collapsed,
  tabsSectionCollapsed: false,
  filesSectionCollapsed: false,
  width,
});

interface ShellMetrics {
  editorWidth: number;
  sidebarWidth: number;
  outlineWidth: number;
  overflow: number;
  titleTextLeft: number;
  lineTextLeft: number;
}

/**
 * Measures the shell's horizontal geometry in the browser: the editor column
 * (the floor under test), both panel rails (the aside keeps its width while
 * the rail is collapsed, so the rail is the visible width), page overflow,
 * and the x of the first body-text glyph vs. the document title's first glyph.
 */
const measureShell = (page: Page): Promise<ShellMetrics> =>
  page.evaluate((): ShellMetrics => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      return element.getBoundingClientRect();
    };
    const inlineInset = (element: HTMLElement | null) => {
      if (!element) return 0;
      const style = getComputedStyle(element);
      return parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
    };
    const button = document.querySelector<HTMLElement>(".document-title-button");
    const line = document.querySelector<HTMLElement>(".markdown-editor .cm-line");
    const editor = rect(".editor-column");
    const sidebar = rect(".sidebar-rail");
    const outline = rect(".outline-rail");
    return {
      editorWidth: editor ? Math.round(editor.width) : -1,
      sidebarWidth: sidebar ? Math.round(sidebar.width) : -1,
      outlineWidth: outline ? Math.round(outline.width) : -1,
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      titleTextLeft:
        (button?.getBoundingClientRect().left ?? -1) + inlineInset(button),
      lineTextLeft:
        (line?.getBoundingClientRect().left ?? -1) + inlineInset(line),
    };
  });

test("keeps the editor floor with a restored 600px explorer at 680px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 680, height: 800 });
  await seed(page, {
    files: [{ path: "/docs/width.md", text: longDocument }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      ...sessionWith("/docs/width.md"),
      workspacePath: "/docs",
      sidebar: sidebarPreferences(600),
    },
  });

  await expect(page.locator(".markdown-editor .cm-content")).toBeVisible();
  // 680 - 36 (activity rail) - 320 (editor floor) = 324px of panel room.
  await expect(page.locator(".sidebar-rail")).toHaveCSS("width", "324px");
  const metrics = await measureShell(page);
  expect(metrics.editorWidth).toBeGreaterThanOrEqual(320);
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  // The title text starts on the same vertical line as the body text (both
  // use the .cm-line 2px inline inset).
  expect(Math.abs(metrics.titleTextLeft - metrics.lineTextLeft)).toBeLessThanOrEqual(1);
});

test("reclaims the outline at 680px and restores it when widened", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await seed(page, {
    files: [{ path: "/docs/width.md", text: longDocument }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      ...sessionWith("/docs/width.md"),
      workspacePath: "/docs",
    },
  });

  await expect(page.locator(".markdown-editor .cm-content")).toBeVisible();
  await page.getByRole("button", { name: "展开右侧栏" }).click();
  await expect(page.locator(".right-sidebar-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect((await measureShell(page)).editorWidth).toBeGreaterThanOrEqual(320);

  await page.setViewportSize({ width: 680, height: 800 });
  await expect(page.locator(".right-sidebar-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const narrowed = await measureShell(page);
  expect(narrowed.sidebarWidth).toBe(260);
  expect(narrowed.editorWidth).toBeGreaterThanOrEqual(320);
  expect(narrowed.overflow).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator(".right-sidebar-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect((await measureShell(page)).editorWidth).toBeGreaterThanOrEqual(320);
});

test("caps a panel drag by the other panel and the editor floor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await seed(page, {
    files: [{ path: "/docs/width.md", text: longDocument }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      ...sessionWith("/docs/width.md"),
      workspacePath: "/docs",
    },
  });

  await expect(page.locator(".markdown-editor .cm-content")).toBeVisible();
  await page.getByRole("button", { name: "展开右侧栏" }).click();
  await expect(page.locator(".outline-rail")).toHaveCSS("width", "300px");
  const resizer = page.getByRole("slider", { name: "调整侧栏宽度" });
  // 1000 - 36 - 320 (editor) - 300 (outline) = 344px.
  await expect(resizer).toHaveAttribute("aria-valuemax", "344");
  const handle = await resizer.boundingBox();
  if (!handle) throw new Error("sidebar resizer not ready");

  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 600, handle.y + 200, {
    steps: 8,
  });
  await page.mouse.up();

  await expect(page.locator(".sidebar-rail")).toHaveCSS("width", "344px");
  await expect(resizer).toHaveAttribute("aria-valuemax", "344");
  const metrics = await measureShell(page);
  expect(metrics.editorWidth).toBeGreaterThanOrEqual(320);
  expect(metrics.editorWidth).toBeLessThanOrEqual(321);
  expect(metrics.overflow).toBeLessThanOrEqual(1);
});

test("keeps a manually opened 600px outline inside the editor floor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 680, height: 800 });
  await seed(page, {
    files: [{ path: "/docs/width.md", text: longDocument }],
    session: {
      ...sessionWith("/docs/width.md"),
      outline: { width: 600 },
    },
  });

  await expect(page.locator(".markdown-editor .cm-content")).toBeVisible();
  await page.getByRole("button", { name: "展开右侧栏" }).click();
  await expect(page.locator(".outline-rail")).toHaveCSS("width", "324px");
  // Opening the outline made the explorer give way.
  await expect(page.locator(".sidebar-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const metrics = await measureShell(page);
  expect(metrics.editorWidth).toBeGreaterThanOrEqual(320);
  expect(metrics.overflow).toBeLessThanOrEqual(1);
});

test("folds the title, keeps it folded across outline republications, and restores it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await seed(page, {
    files: [{ path: "/docs/width.md", text: longDocument }],
    session: sessionWith("/docs/width.md"),
  });

  await expect(page.locator(".markdown-editor .cm-content")).toBeVisible();
  // The outline panel is opened up front so its re-publish is observable.
  await page.getByRole("button", { name: "展开右侧栏" }).click();
  await expect(page.getByRole("treeitem", { name: "宽度" })).toBeVisible();
  await expect(page.locator(".document-title")).not.toHaveAttribute(
    "data-compact",
    "true",
  );
  await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    if (!scroller) throw new Error("scroller missing");
    scroller.scrollTop = 600;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".document-title")).toHaveAttribute(
    "data-compact",
    "true",
  );
  await expect
    .poll(() =>
      page
        .locator(".document-title")
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeLessThan(2);

  // Move inside the 16–72px hysteresis band (not back to the top), then type
  // a new heading at the visible caret. The outline republish that follows
  // must only refresh the active heading; it must not pop the title back.
  await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    if (!scroller) throw new Error("scroller missing");
    scroller.scrollTop = 40;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".document-title")).toHaveAttribute(
    "data-compact",
    "true",
  );
  const scrollerBox = await page.locator(".cm-scroller").boundingBox();
  if (!scrollerBox) throw new Error("scroller box missing");
  await page.mouse.click(
    scrollerBox.x + scrollerBox.width / 2,
    scrollerBox.y + 220,
  );
  await page.keyboard.press("Enter");
  await page.keyboard.type("## 滞后测试");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("treeitem", { name: "滞后测试" })).toBeVisible();
  await expect(page.locator(".document-title")).toHaveAttribute(
    "data-compact",
    "true",
  );

  await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    if (!scroller) throw new Error("scroller missing");
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect(page.locator(".document-title")).not.toHaveAttribute(
    "data-compact",
    "true",
  );
});
