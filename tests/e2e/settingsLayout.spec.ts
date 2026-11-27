import { expect, test, type Locator, type Page } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

const seed = async (page: Page, theme?: "dark" | "light") => {
  const fixture: E2eFixtureSpec = {
    files: [{ path: "/docs/note.md", text: "# Note\n" }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      recent: [],
      openPaths: ["/docs/note.md"],
      activePath: "/docs/note.md",
      workspacePath: "/docs",
      ...(theme === undefined ? {} : { theme }),
    },
  };
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");
};

/** Horizontal clipping inside the dialog body (the panel that would scroll if
 * a control outgrew the window). */
const bodyHorizontalOverflow = (dialog: Locator) =>
  dialog
    .locator(".settings-body")
    .evaluate((element) => element.scrollWidth - element.clientWidth);

test("keeps a steady dual-pane settings workspace and borderless navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "设置" });
  const boxes: Array<{ top: number; height: number; navTop: number }> = [];
  const recordBox = async () => {
    const dialogBox = await dialog.boundingBox();
    const navBox = await page.locator(".settings-navigation").boundingBox();
    if (!dialogBox || !navBox) {
      throw new Error("settings dialog has no layout box");
    }
    boxes.push({
      top: dialogBox.y,
      height: dialogBox.height,
      navTop: navBox.y,
    });
  };

  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("width", "860px");
  await expect(dialog).toHaveCSS("height", "600px");
  await expect(dialog).toHaveCSS("border-radius", "16px");
  await expect(dialog.getByRole("tablist", { name: "设置分类" })).toHaveCSS(
    "flex-direction",
    "column",
  );
  const nav = page.locator(".settings-navigation");
  await expect(nav).toHaveCSS("width", "204px");
  await expect(nav).toHaveCSS("border-right-width", "0px");
  await expect(
    dialog.getByRole("tab", { name: "外观" }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await dialog
      .getByRole("tab", { name: "外观" })
      .evaluate((el) => getComputedStyle(el, "::after").content),
  ).toBe("none");

  await expect(dialog).toHaveCSS("transform", "none");
  await recordBox();

  for (const name of ["编辑器", "翻译", "关于"]) {
    await dialog.getByRole("tab", { name }).click();
    await expect(dialog.getByRole("tabpanel", { name })).toBeVisible();
    await recordBox();
  }

  // Translation body scrolls vertically while keeping zero horizontal overflow.
  await dialog.getByRole("tab", { name: "翻译" }).click();
  const formBody = dialog.locator(".settings-body");
  await expect(formBody).toHaveCSS("overflow-y", "auto");
  expect(
    await formBody.evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeGreaterThan(0);
  expect(await bodyHorizontalOverflow(dialog)).toBe(0);

  // Switching categories keeps one steady height and top position.
  for (const box of boxes) {
    expect(Math.abs(box.height - 600)).toBeLessThanOrEqual(1);
  }
  expect(
    Math.max(...boxes.map((b) => b.top)) - Math.min(...boxes.map((b) => b.top)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.max(...boxes.map((b) => b.navTop)) -
      Math.min(...boxes.map((b) => b.navTop)),
  ).toBeLessThanOrEqual(1);

  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await expect(dialog).toHaveCount(0);

  // 640px: icon rail, steady workspace, zero horizontal clipping.
  await page.setViewportSize({ width: 640, height: 600 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".settings-navigation")).toHaveCSS("width", "56px");
  await expect(dialog).toHaveCSS("height", "552px");
  expect(await bodyHorizontalOverflow(dialog)).toBe(0);

  await dialog.getByRole("tab", { name: "翻译" }).click();
  expect(await bodyHorizontalOverflow(dialog)).toBe(0);
});

test("uses visual theme cards, soft rounded controls, and adjacent numeric units", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });

  // Visual 3-card theme radiogroup on 外观.
  const themeGroup = dialog.getByRole("radiogroup", { name: "主题" });
  await expect(themeGroup).toBeVisible();
  const lightCard = themeGroup.getByRole("radio", { name: "浅色" });
  const darkCard = themeGroup.getByRole("radio", { name: "深色" });
  const systemCard = themeGroup.getByRole("radio", { name: "跟随系统" });
  await expect(darkCard).toHaveAttribute("aria-checked", "true");
  await expect(lightCard).toHaveCSS("height", "86px");
  await expect(lightCard).toHaveCSS("border-radius", "12px");

  await lightCard.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(lightCard).toHaveAttribute("aria-checked", "true");
  await expect(systemCard).toHaveAttribute("aria-checked", "false");
  // Light mode uses the clean pure-white dialog surface.
  await expect(dialog).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await dialog.getByRole("tab", { name: "编辑器" }).click();
  const group = dialog.locator(".settings-group");
  await expect(group).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(dialog.locator(".settings-row").first()).toHaveCSS(
    "min-height",
    "64px",
  );

  // Numeric fields use centered soft rounded boxes with adjacent units.
  const bodySize = dialog.getByLabel("正文字号");
  await expect(bodySize).toHaveCSS("width", "76px");
  await expect(bodySize).toHaveCSS("height", "36px");
  await expect(bodySize).toHaveCSS("border-radius", "10px");
  await expect(bodySize).toHaveCSS("text-align", "center");
  await expect(bodySize).toHaveAttribute(
    "aria-describedby",
    "settings-body-size-description settings-body-size-unit",
  );
  await expect(dialog.locator(".settings-number-unit").nth(0)).toHaveText("px");
  await expect(dialog.locator(".settings-number-unit").nth(1)).toHaveText("倍");
  await expect(dialog.locator(".settings-number-unit").nth(2)).toHaveText("px");

  const font = dialog.getByLabel("字体", { exact: true });
  await expect(font).toHaveCSS("height", "36px");
  await expect(font).toHaveCSS("border-radius", "10px");
  await font.selectOption("custom");
  const customFont = dialog.getByLabel("自定义字体");
  await expect(customFont).toHaveCSS("height", "36px");
  await expect(customFont).toHaveCSS("border-radius", "10px");

  await dialog.getByRole("tab", { name: "翻译" }).click();
  const endpoint = dialog.getByLabel("API 端点");
  await expect(endpoint).toHaveCSS("height", "36px");
  await expect(endpoint).toHaveCSS("border-radius", "10px");
  expect(
    await endpoint.evaluate((el) => el.closest(".settings-row")?.className),
  ).toContain("settings-row-stacked");
  expect(
    await endpoint.evaluate((el) => getComputedStyle(el).fontFamily),
  ).toContain("monospace");

  await expect(dialog.getByLabel("并发数")).toHaveCSS("border-radius", "10px");
  await expect(
    dialog.locator(".settings-number-unit").first(),
  ).toHaveText("个");

  for (const name of ["清除", "获取模型列表", "测试连接"]) {
    const button = dialog.getByRole("button", { name });
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(button).toHaveCSS("height", "36px");
    await expect(button).toHaveCSS("border-radius", "10px");
  }

  await dialog.getByRole("tab", { name: "关于" }).click();
  const updateButton = dialog.getByRole("button", { name: "检查更新" });
  await expect(updateButton).toHaveCSS("height", "36px");
  await expect(updateButton).toHaveCSS("border-radius", "10px");
});

test("keeps cohesive surface contrast and zero overflow in both themes", async ({
  page,
}) => {
  for (const theme of ["dark", "light"] as const) {
    await page.setViewportSize({ width: 1280, height: 720 });
    await seed(page, theme);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置" });

    const expectedBg =
      theme === "dark" ? "rgb(37, 38, 44)" : "rgb(255, 255, 255)";
    await expect(dialog).toHaveCSS("background-color", expectedBg);

    await dialog.getByRole("tab", { name: "编辑器" }).click();
    const widthInput = dialog.getByRole("spinbutton", { name: "内容宽度" });
    await widthInput.focus();
    const expectedBorder =
      theme === "dark" ? "rgb(131, 134, 150)" : "rgb(107, 110, 120)";
    await expect(widthInput).toHaveCSS("outline-style", "none");
    await expect(widthInput).toHaveCSS("border-top-color", expectedBorder);

    for (const tab of ["外观", "编辑器", "翻译", "关于"]) {
      await dialog.getByRole("tab", { name: tab }).click();
      expect(await bodyHorizontalOverflow(dialog)).toBe(0);
    }
  }
});
