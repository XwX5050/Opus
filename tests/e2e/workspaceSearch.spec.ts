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

test("keeps the 44px activity rail and adapts the welcome layout at three widths", async ({
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
    expect(layout.railWidth).toBe(44);
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
  expect(railWidth).toBe(44);
  await expect(page.locator(".welcome-main")).toBeVisible();
  await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
});
