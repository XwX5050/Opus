import { expect, test } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

test("keeps compact titlebar icons aligned and tabs flush with the header bottom", async ({
  page,
}) => {
  const fixture: E2eFixtureSpec = {
    files: [{ path: "/docs/aligned.md", text: "# Aligned\n" }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      recent: [],
      openPaths: ["/docs/aligned.md"],
      activePath: "/docs/aligned.md",
      workspacePath: "/docs",
    },
  };
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");
  await expect(page.locator(".app-header")).toHaveCSS("transform", "none");

  const metrics = await page.evaluate(() => {
    const header = document.querySelector(".app-header")!.getBoundingClientRect();
    const leftButton = document.querySelector(".app-header .sidebar-toggle")!;
    const rightButton = document.querySelector(".right-sidebar-toggle")!;
    const leftButtonRect = leftButton.getBoundingClientRect();
    const rightButtonRect = rightButton.getBoundingClientRect();
    const leftIcon = leftButton.querySelector("svg")!.getBoundingClientRect();
    const rightIcon = rightButton.querySelector("svg")!.getBoundingClientRect();
    const title = document.querySelector(".app-title")!.getBoundingClientRect();
    const tab = document.querySelector(".tab-item")!.getBoundingClientRect();
    const center = (rect: DOMRect) => rect.top + rect.height / 2;
    return {
      headerCenter: center(header),
      headerBottom: header.bottom,
      leftIconCenter: center(leftIcon),
      rightIconCenter: center(rightIcon),
      leftIconHeight: leftIcon.height,
      rightIconHeight: rightIcon.height,
      leftButtonHeight: leftButtonRect.height,
      rightButtonHeight: rightButtonRect.height,
      titleCenter: center(title),
      tabBottom: tab.bottom,
      activityIconHeights: Array.from(
        document.querySelectorAll(".activity-rail-button svg, .sidebar-settings svg"),
        (icon) => icon.getBoundingClientRect().height,
      ),
      railShadow: getComputedStyle(document.querySelector(".activity-rail")!).boxShadow,
    };
  });

  expect(metrics.leftIconHeight).toBe(16);
  expect(metrics.rightIconHeight).toBe(16);
  expect(metrics.leftButtonHeight).toBe(32);
  expect(metrics.rightButtonHeight).toBe(32);
  for (const height of metrics.activityIconHeights) expect(height).toBe(16);
  expect(metrics.railShadow).toBe("none");
  for (const center of [
    metrics.leftIconCenter,
    metrics.rightIconCenter,
    metrics.titleCenter,
  ]) {
    expect(Math.abs(center - metrics.headerCenter)).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(metrics.tabBottom - metrics.headerBottom)).toBeLessThanOrEqual(1);
});


test("keeps icon buttons flat on hover in both themes without a rail divider", async ({
  page,
}) => {
  const fixture: E2eFixtureSpec = {
    files: [{ path: "/docs/aligned.md", text: "# Aligned\n" }],
    workspace: { path: "/docs", title: "docs" },
    session: {
      recent: [],
      openPaths: ["/docs/aligned.md"],
      activePath: "/docs/aligned.md",
      workspacePath: "/docs",
    },
  };
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");
  await expect(page.locator(".app-header")).toHaveCSS("transform", "none");
  const fileButton = page.getByRole("navigation", { name: "活动栏" }).getByRole("button", { name: "文件" });
  const rightButton = page.locator(".right-sidebar-toggle");
  const rail = page.locator(".activity-rail");

  const expectFlatIconHovers = async () => {
    await fileButton.hover();
    await expect(fileButton).toHaveCSS("box-shadow", "none");
    await rightButton.hover();
    await expect(rightButton).toHaveCSS("box-shadow", "none");
  };

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect(fileButton).toHaveCSS("width", "32px");
  await expect(fileButton).toHaveCSS("height", "32px");
  await expect(fileButton).toHaveCSS("border-radius", "8px");
  await expectFlatIconHovers();

  const railStyles = await rail.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      borderRightWidth: style.borderRightWidth,
      borderLeftWidth: style.borderLeftWidth,
      borderInlineEndWidth: style.borderInlineEndWidth,
    };
  });
  expect(railStyles.boxShadow).toBe("none");
  expect(railStyles.borderRightWidth).toBe("0px");
  expect(railStyles.borderLeftWidth).toBe("0px");
  expect(railStyles.borderInlineEndWidth).toBe("0px");

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await expectFlatIconHovers();
});
