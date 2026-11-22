import { expect, test, type Page } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

const seed = async (page: Page, fixture: E2eFixtureSpec) => {
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");
};

test("shows the single-column welcome screen, limits recent items, and opens a recent file", async ({
  page,
}) => {
  const recent = Array.from({ length: 7 }, (_, index) => ({
    path: `/docs/note-${index + 1}.md`,
    kind: "file" as const,
  }));
  await seed(page, {
    files: recent.map((item, index) => ({
      path: item.path,
      text: `# Note ${index + 1}\n`,
    })),
    session: {
      recent,
      openPaths: [],
      activePath: null,
      workspacePath: null,
    },
  });

  await expect(page.getByRole("heading", { level: 1, name: "Opus" })).toBeVisible();
  await expect(page.getByRole("region", { name: "启动" })).toBeVisible();
  await expect(page.getByRole("region", { name: "最近" })).toBeVisible();
  await expect(page.locator(".welcome-aside")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "快捷键" })).toHaveCount(0);

  const primary = page.locator(".welcome-recent-list").first();
  await expect(primary.getByRole("button")).toHaveCount(5);
  await expect(primary.locator(".welcome-recent-name").first()).toHaveClass(
    /welcome-recent-name/,
  );
  await expect(primary.locator(".welcome-recent-path").first()).toHaveText(
    "/docs",
  );
  await expect(primary.locator(".welcome-recent-icon")).toHaveCount(0);
  await expect(primary.locator(".welcome-recent-text").first()).toHaveCSS(
    "column-gap",
    "24px",
  );
  await expect(primary.locator(".welcome-recent-path").first()).toHaveCSS(
    "text-align",
    "right",
  );

  const details = page.locator(".welcome-more");
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open", "");
  await expect(
    details.getByRole("button", { name: /note-6\.md/ }),
  ).toBeVisible();

  await primary.getByRole("button", { name: /note-1\.md/ }).click();
  await expect(page.getByRole("tab", { name: /note-1\.md/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".cm-content")).toContainText("Note 1");
});

test("returns to the same welcome screen after closing 欢迎.md", async ({ page }) => {
  const path = "/docs/欢迎.md";
  await seed(page, {
    files: [{ path, text: "# 欢迎\n\n本地 Markdown。\n" }],
    session: {
      recent: [{ path, kind: "file" }],
      openPaths: [path],
      activePath: path,
      workspacePath: null,
    },
  });

  await expect(page.getByRole("tab", { name: "欢迎.md" })).toBeVisible();
  await page.getByRole("button", { name: "关闭 欢迎.md" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Opus" })).toBeVisible();
  await expect(page.locator(".welcome-aside")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "快捷键" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开文件 欢迎.md：/docs/欢迎.md" }),
  ).toBeVisible();
  await expect(page.locator(".document-tabs-bar")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "工作区全文搜索" })).toHaveCount(0);
});

test("keeps the 36px activity rail and adapts the welcome layout at three widths", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/a.md", text: "saved" }],
    session: {
      recent: [{ path: "/docs/a.md", kind: "file" }],
      openPaths: [],
      activePath: null,
      workspacePath: null,
    },
  });

  await expect(page.getByRole("heading", { level: 1, name: "Opus" })).toBeVisible();

  for (const width of [1280, 1080, 680]) {
    await page.setViewportSize({ width, height: 720 });
    const layout = await page.evaluate(() => {
      const rail = document.querySelector(".activity-rail");
      const main = document.querySelector(".welcome-main");
      if (!rail || !main) throw new Error("welcome layout missing");
      return {
        railWidth: rail.getBoundingClientRect().width,
        mainVisible: main.getBoundingClientRect().width > 0,
        mainWidth: main.getBoundingClientRect().width,
        decorationCount: document.querySelectorAll(".welcome-aside").length,
        horizontalOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    expect(layout.railWidth).toBe(36);
    expect(layout.mainVisible).toBe(true);
    expect(layout.decorationCount).toBe(0);
    expect(layout.horizontalOverflow).toBe(0);
    if (width === 1280) expect(layout.mainWidth).toBeGreaterThan(560);
  }

  await page.getByRole("button", { name: "收起侧栏" }).click();
  await expect(page.locator(".sidebar-rail")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  const railWidth = await page
    .locator(".activity-rail")
    .evaluate((rail) => rail.getBoundingClientRect().width);
  expect(railWidth).toBe(36);
  await expect(page.locator(".welcome-main")).toBeVisible();
  await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
});


test("switches workspace views and opens or creates files from the native file dialog", async ({
  page,
}) => {
  await seed(page, {
    files: [
      { path: "/docs/alpha.md", text: "Hello world\n" },
      { path: "/docs/drafts/gamma.md", text: "Draft\n" },
    ],
    workspace: { path: "/docs", title: "docs" },
    session: {
      recent: [],
      openPaths: ["/docs/alpha.md"],
      activePath: "/docs/alpha.md",
      workspacePath: "/docs",
    },
  });

  const rail = page.getByRole("navigation", { name: "活动栏" });
  await expect(
    page.locator(".app-header").getByRole("button", { name: "收起侧栏" }),
  ).toBeVisible();
  await expect(rail.getByRole("button", { name: "文件" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "搜索" })).toBeVisible();
  await expect(page.locator(".file-tree-file-icon")).toHaveCount(0);

  await rail.getByRole("button", { name: "搜索" }).click();
  const sidebar = page.getByRole("complementary", { name: "侧栏" });
  await expect(sidebar.getByRole("heading", { name: "搜索" })).toBeVisible();
  const search = sidebar.getByRole("combobox", { name: "工作区全文搜索" });
  await expect(search).toBeFocused();
  await expect(sidebar.getByRole("tree")).toHaveCount(0);
  await search.fill("Hello");
  await sidebar.getByRole("option", { name: /Hello world/ }).click();
  await expect(page.getByRole("tab", { name: "alpha.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await rail.getByRole("button", { name: "搜索" }).click();
  await expect(sidebar.getByRole("tree", { name: "工作区文件" })).toBeVisible();

  await rail.getByRole("button", { name: "文件" }).click();
  const dialog = page.getByRole("dialog", { name: "文件" });
  await expect(dialog).toBeVisible();
  const switcher = dialog.getByRole("combobox", { name: "切换或创建文件" });
  await expect(switcher).toBeFocused();
  await expect(dialog.getByRole("option", { name: /drafts\/gamma\.md/ })).toBeVisible();
  await switcher.fill("drafts/gamma");
  await switcher.press("Enter");
  await expect(page.getByRole("tab", { name: "gamma.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await rail.getByRole("button", { name: "文件" }).click();
  const creator = page
    .getByRole("dialog", { name: "文件" })
    .getByRole("combobox", { name: "切换或创建文件" });
  await creator.fill("drafts/new-e2e");
  await creator.press("Shift+Enter");
  await expect(page.getByRole("tab", { name: "new-e2e.md" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("dialog", { name: "文件" })).toHaveCount(0);
  const createdText = await page.evaluate(async () => {
    const file = await window.__E2E_PORT__!.openPath("/docs/drafts/new-e2e.md");
    return file.text;
  });
  expect(createdText).toBe("");

  await rail.getByRole("button", { name: "文件" }).click();
  await expect(page.getByRole("dialog", { name: "文件" })).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(page.getByRole("dialog", { name: "文件" })).toHaveCount(0);
});

test("uses one pill-shaped search field without a nested form outline", async ({
  page,
}) => {
  await seed(page, {
    files: [{ path: "/docs/alpha.md", text: "Hello world\n" }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      recent: [],
      openPaths: ["/docs/alpha.md"],
      activePath: "/docs/alpha.md",
      workspacePath: "/docs",
    },
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page
    .getByRole("navigation", { name: "活动栏" })
    .getByRole("button", { name: "搜索" })
    .click();

  const form = page.locator(".workspace-search-dedicated .workspace-search-form");
  const search = page.getByRole("combobox", { name: "工作区全文搜索" });
  await expect(search).toBeFocused();
  await expect(form).toHaveCSS("border-bottom-width", "0px");
  await expect(form).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(form).toHaveCSS("outline-style", "none");
  await expect(search).toHaveCSS("min-height", "32px");
  await expect(search).toHaveCSS("padding-left", "12px");
  await expect(search).toHaveCSS("padding-right", "12px");
  await expect(search).toHaveCSS("border-radius", "999px");
  await expect(search).toHaveCSS("background-color", "rgb(236, 236, 240)");
  await expect(search).toHaveCSS("outline-style", "solid");
  await expect(search).toHaveCSS("outline-width", "2px");
});
