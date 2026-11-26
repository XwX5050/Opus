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

/** Rendered dialog height; the compact sections size to their content, so
 * their height is not a fixed CSS value. */
const dialogHeight = (dialog: Locator) =>
  dialog.evaluate((element) => element.getBoundingClientRect().height);

/** Horizontal clipping inside the dialog body (the panel that would scroll if
 * a control outgrew the window). The dialog itself hides overflow, so checking
 * the body catches clipped controls instead of only the outer box. */
const bodyHorizontalOverflow = (dialog: Locator) =>
  dialog
    .locator(".settings-body")
    .evaluate((element) => element.scrollWidth - element.clientWidth);

/** Resolves the theme's inset surface to a concrete rgb() so the control
 * assertions do not hardcode the dark palette. */
const readInsetColor = (page: Page) =>
  page.evaluate(() => {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue("--surface-inset")
      .trim();
    const probe = document.createElement("span");
    probe.style.backgroundColor = value;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });

const parseRgb = (color: string): [number, number, number] => {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!match) throw new Error(`Unsupported color: ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const relativeLuminance = (color: string): number => {
  const [r, g, b] = parseRgb(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (first: string, second: string): number => {
  const [lighter, darker] = [
    relativeLuminance(first),
    relativeLuminance(second),
  ].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

/** Actual rendered border/background colors of a control, plus the dialog
 * surface it sits on. */
const controlColors = (control: Locator) =>
  control.evaluate((element) => {
    const style = getComputedStyle(element);
    const dialogElement = element.closest(".settings-dialog");
    if (!(dialogElement instanceof HTMLElement)) {
      throw new Error("control is not inside the settings dialog");
    }
    return {
      border: style.borderTopColor,
      borderWidth: style.borderTopWidth,
      borderStyle: style.borderTopStyle,
      inset: style.backgroundColor,
      surface: getComputedStyle(dialogElement).backgroundColor,
    };
  });

test("keeps short settings sections compact and the form workspace fixed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "设置" });
  const tops: Array<{ dialog: number; nav: number }> = [];
  const recordTops = async () => {
    const dialogBox = await dialog.boundingBox();
    const navBox = await page.locator(".settings-navigation").boundingBox();
    if (!dialogBox || !navBox) {
      throw new Error("settings dialog has no layout box");
    }
    tops.push({ dialog: dialogBox.y, nav: navBox.y });
  };
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("width", "900px");
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

  // 外观 holds a single row: the dialog follows its content well below the
  // 640px form workspace instead of leaving an empty pane.
  await expect(dialog).toHaveClass(/settings-dialog-compact/);
  const appearanceHeight = await dialogHeight(dialog);
  expect(appearanceHeight).toBeGreaterThan(200);
  expect(appearanceHeight).toBeLessThan(400);
  // The entrance timeline moves the dialog into place; tab switching is what
  // must keep the top stable, so measure only after the intro has settled.
  await expect(dialog).toHaveCSS("transform", "none");
  await recordTops();

  await dialog.getByRole("tab", { name: "编辑器" }).click();
  await expect(dialog.getByRole("tabpanel", { name: "编辑器" })).toBeVisible();
  await expect(dialog).not.toHaveClass(/settings-dialog-compact/);
  await expect(dialog).toHaveCSS("height", "640px");
  await expect(dialog.getByLabel("正文字号")).toBeVisible();
  await expect(dialog.getByLabel("主题")).toHaveCount(0);
  await recordTops();

  // The translation form keeps the fixed workspace and scrolls its own body.
  await dialog.getByRole("tab", { name: "翻译" }).click();
  await expect(dialog).not.toHaveClass(/settings-dialog-compact/);
  await expect(dialog).toHaveCSS("height", "640px");
  const formBody = dialog.locator(".settings-body");
  await expect(formBody).toHaveCSS("overflow-y", "auto");
  expect(
    await formBody.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeGreaterThan(0);
  await recordTops();

  await dialog.getByRole("tab", { name: "关于" }).click();
  await expect(dialog).toHaveClass(/settings-dialog-compact/);
  const aboutHeight = await dialogHeight(dialog);
  expect(aboutHeight).toBeGreaterThan(200);
  expect(aboutHeight).toBeLessThan(400);
  await expect(dialog.getByText(/v\d+\.\d+\.\d+/)).toBeVisible();
  await recordTops();

  // Compact and fixed sections share one top edge: switching categories must
  // not shift the dialog or its navigation vertically.
  const dialogTops = tops.map((entry) => entry.dialog);
  const navTops = tops.map((entry) => entry.nav);
  expect(Math.max(...dialogTops) - Math.min(...dialogTops)).toBeLessThanOrEqual(1);
  expect(Math.max(...navTops) - Math.min(...navTops)).toBeLessThanOrEqual(1);

  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await expect(dialog).toHaveCount(0);

  // 640px: icon rail, compact short section, no clipped controls.
  await page.setViewportSize({ width: 640, height: 600 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.locator(".settings-navigation")).toHaveCSS("width", "56px");
  await expect(dialog.getByRole("tabpanel", { name: "外观" })).toBeVisible();
  await expect(dialog).toHaveClass(/settings-dialog-compact/);
  expect(await dialogHeight(dialog)).toBeLessThan(400);
  expect(await bodyHorizontalOverflow(dialog)).toBe(0);

  await dialog.getByRole("tab", { name: "翻译" }).click();
  await expect(dialog).not.toHaveClass(/settings-dialog-compact/);
  // min(640px, 600px - 48px): the form workspace still fills the window.
  await expect(dialog).toHaveCSS("height", "552px");
  const concurrencyLabel = dialog.getByText("并发数", { exact: true });
  const labelHeight = await concurrencyLabel.evaluate(
    (label) => label.getBoundingClientRect().height,
  );
  expect(labelHeight).toBeGreaterThan(0);
  expect(labelHeight).toBeLessThan(24);
  expect(await bodyHorizontalOverflow(dialog)).toBe(0);
  const narrowBody = dialog.locator(".settings-body");
  expect(
    await narrowBody.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    ),
  ).toBeGreaterThan(0);
});

test("uses inset bordered controls, descriptive rows, and visible units", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "编辑器" }).click();

  const inset = await readInsetColor(page);
  expect(inset).not.toBe("rgba(0, 0, 0, 0)");

  // Rows stay descriptive with dividers; the inset and border belong to the
  // controls, not to white card containers.
  const group = dialog.locator(".settings-group");
  await expect(group).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(group).toHaveCSS("border-top-width", "0px");
  await expect(dialog.locator(".settings-row").first()).toHaveCSS(
    "min-height",
    "64px",
  );

  const bodySize = dialog.getByLabel("正文字号");
  const bodySizeField = dialog.locator(".settings-number").first();
  await expect(bodySizeField).toHaveCSS("background-color", inset);
  await expect(bodySizeField).toHaveCSS("border-top-width", "1px");
  await expect(bodySizeField).toHaveCSS("border-top-style", "solid");
  await expect(bodySizeField).toHaveCSS("border-radius", "999px");
  await expect(bodySizeField).toHaveCSS("height", "34px");
  await expect(bodySize).toHaveCSS("text-align", "right");
  expect(
    await bodySizeField.evaluate(
      (element) => getComputedStyle(element).borderTopColor,
    ),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await expect(bodySize).toHaveAttribute(
    "aria-describedby",
    "settings-body-size-description settings-body-size-unit",
  );
  // Units are visible next to the numbers: px, 倍, px in the editor pane.
  await expect(dialog.locator(".settings-number-unit").nth(0)).toHaveText("px");
  await expect(dialog.locator(".settings-number-unit").nth(1)).toHaveText("倍");
  await expect(dialog.locator(".settings-number-unit").nth(2)).toHaveText("px");

  const font = dialog.getByLabel("字体", { exact: true });
  await expect(font).toHaveCSS("background-color", inset);
  await expect(font).toHaveCSS("border-top-width", "1px");
  await expect(font).toHaveCSS("border-radius", "999px");
  await expect(font).toHaveCSS("height", "34px");
  await font.selectOption("custom");
  const customFont = dialog.getByLabel("自定义字体");
  await expect(customFont).toHaveCSS("background-color", inset);
  await expect(customFont).toHaveCSS("border-top-width", "1px");
  await expect(customFont).toHaveCSS("border-radius", "999px");
  await expect(customFont).toHaveCSS("height", "34px");
  await expect(dialog.getByText("调整正文排版、字体与阅读宽度")).toBeVisible();
  await expect(dialog.getByText("设置 Markdown 正文的文字大小")).toBeVisible();

  await dialog.getByRole("tab", { name: "翻译" }).click();
  const endpoint = dialog.getByLabel("API 端点");
  await expect(endpoint).toHaveAttribute(
    "aria-describedby",
    "settings-translation-endpoint-description",
  );
  await expect(endpoint).toHaveCSS("background-color", inset);
  await expect(endpoint).toHaveCSS("border-top-width", "1px");
  await expect(endpoint).toHaveCSS("border-top-style", "solid");
  await expect(endpoint).toHaveCSS("border-radius", "999px");
  await expect(endpoint).toHaveCSS("height", "34px");
  // The endpoint row spans the full pane instead of sitting in the control
  // column next to its label.
  expect(
    await endpoint.evaluate(
      (element) => element.closest(".settings-row")?.className,
    ),
  ).toContain("settings-row-stacked");
  // The whole URL stays available even when the field scrolls horizontally.
  const endpointValue = await endpoint.inputValue();
  await expect(endpoint).toHaveAttribute("title", endpointValue);
  expect(
    await endpoint.evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain("monospace");

  await expect(dialog.getByLabel("API Key")).toHaveAttribute(
    "aria-describedby",
    "settings-translation-api-key-description settings-translation-api-key-clear-reason",
  );
  const concurrency = dialog.getByLabel("并发数");
  const concurrencyField = dialog.locator(".settings-number").first();
  await expect(concurrencyField).toHaveCSS("background-color", inset);
  await expect(concurrencyField).toHaveCSS("border-top-width", "1px");
  await expect(concurrencyField).toHaveCSS("border-radius", "999px");
  await expect(concurrencyField.locator(".settings-number-unit")).toHaveText(
    "个",
  );
  await expect(concurrency).toHaveAttribute(
    "aria-describedby",
    "settings-translation-concurrency-description settings-translation-concurrency-unit",
  );

  const clear = dialog.getByRole("button", { name: "清除" });
  await expect(clear).toBeDisabled();
  await expect(clear).toHaveAttribute(
    "title",
    "当前服务商尚未保存 API Key，清除按钮不可用",
  );
  await expect(clear).toHaveAttribute(
    "aria-describedby",
    "settings-translation-api-key-clear-reason",
  );
  await expect(
    dialog.locator("#settings-translation-api-key-clear-reason"),
  ).toHaveText("当前服务商尚未保存 API Key，清除按钮不可用");

  // Quiet action buttons keep their transparent treatment while joining the
  // same 34px capsule family as the fields.
  for (const name of ["清除", "获取模型列表", "测试连接"]) {
    const button = dialog.getByRole("button", { name });
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(button).toHaveCSS("height", "34px");
    await expect(button).toHaveCSS("border-top-width", "1px");
    await expect(button).toHaveCSS("border-top-style", "solid");
    await expect(button).toHaveCSS("border-radius", "999px");
  }
  await expect(
    dialog.getByText("翻译结果会缓存在本机，原文不变时不重复调用 API。"),
  ).toBeVisible();

  await dialog.getByRole("tab", { name: "关于" }).click();
  const updateButton = dialog.getByRole("button", { name: "检查更新" });
  await expect(updateButton).toHaveCSS("height", "34px");
  await expect(updateButton).toHaveCSS("border-top-width", "1px");
  await expect(updateButton).toHaveCSS("border-top-style", "solid");
  await expect(updateButton).toHaveCSS("border-radius", "999px");
});

test("keeps control borders at 3:1 against surface and inset in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seed(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "编辑器" }).click();

  const assertControlBorder = async (control: Locator) => {
    const colors = await controlColors(control);
    expect(colors.borderWidth).toBe("1px");
    expect(colors.borderStyle).toBe("solid");
    expect(contrastRatio(colors.border, colors.surface)).toBeGreaterThanOrEqual(
      3,
    );
    expect(contrastRatio(colors.border, colors.inset)).toBeGreaterThanOrEqual(3);
  };

  const font = dialog.getByLabel("字体", { exact: true });
  const bodySizeField = dialog.locator(".settings-number").first();
  await assertControlBorder(font);
  await assertControlBorder(bodySizeField);

  await dialog.getByRole("tab", { name: "外观" }).click();
  await dialog.getByLabel("主题").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await dialog.getByRole("tab", { name: "编辑器" }).click();
  await assertControlBorder(font);
  await assertControlBorder(bodySizeField);
});
