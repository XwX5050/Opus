import { expect, test } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

const seed = async (page: import("@playwright/test").Page) => {
  const fixture: E2eFixtureSpec = {
    files: [{ path: "/docs/note.md", text: "# Note\n" }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      recent: [],
      openPaths: ["/docs/note.md"],
      activePath: "/docs/note.md",
      workspacePath: "/docs",
    },
  };
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");
};

test("lays out settings as a dual-pane dialog and adapts to a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "设置" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("width", "900px");
  await expect(dialog).toHaveCSS("height", "640px");
  await expect(dialog.getByRole("tablist", { name: "设置分类" })).toHaveCSS(
    "flex-direction",
    "column",
  );
  await expect(page.locator(".settings-navigation")).toHaveCSS("width", "200px");
  await expect(dialog.getByRole("tab", { name: "外观" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByRole("tabpanel", { name: "外观" })).toBeVisible();

  await dialog.getByRole("tab", { name: "编辑器" }).click();
  await expect(dialog.getByRole("tabpanel", { name: "编辑器" })).toBeVisible();
  await expect(dialog.getByLabel("正文字号")).toBeVisible();
  await expect(dialog.getByLabel("主题")).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await expect(dialog).toHaveCount(0);

  await page.setViewportSize({ width: 640, height: 600 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".settings-navigation")).toHaveCSS("width", "56px");
  const overflow = await dialog.evaluate((element) =>
    element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBe(0);
  await expect(dialog.getByRole("tabpanel", { name: "外观" })).toBeVisible();

  await dialog.getByRole("tab", { name: "翻译" }).click();
  const concurrencyLabel = dialog.getByText("并发数", { exact: true });
  const labelHeight = await concurrencyLabel.evaluate(
    (label) => label.getBoundingClientRect().height,
  );
  expect(labelHeight).toBeGreaterThan(0);
  expect(labelHeight).toBeLessThan(24);
  expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test("uses transparent controls and descriptive rows instead of white cards", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "编辑器" }).click();

  const group = dialog.locator(".settings-group");
  await expect(group).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(group).toHaveCSS("border-top-width", "0px");
  await expect(dialog.locator(".settings-row").first()).toHaveCSS("min-height", "64px");

  const bodySize = dialog.getByLabel("正文字号");
  await expect(bodySize).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(bodySize).toHaveCSS("border-top-width", "0px");
  await expect(bodySize).toHaveCSS("text-align", "right");

  const font = dialog.getByLabel("字体", { exact: true });
  await expect(font).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(font).toHaveCSS("border-radius", "999px");
  await font.selectOption("custom");
  await expect(dialog.getByLabel("自定义字体")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(dialog.getByText("调整正文排版、字体与阅读宽度")).toBeVisible();
  await expect(dialog.getByText("设置 Markdown 正文的文字大小")).toBeVisible();

  await dialog.getByRole("tab", { name: "翻译" }).click();
  await expect(dialog.getByLabel("API 端点")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(dialog.getByLabel("API 端点")).toHaveCSS("border-radius", "999px");
  await expect(dialog.getByRole("button", { name: "获取模型列表" })).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
});
