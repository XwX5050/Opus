import { expect, test, type Page } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

const seed = async (page: Page) => {
  const fixture: E2eFixtureSpec = {
    files: [
      {
        path: "/docs/motion.md",
        text: Array.from({ length: 12 }, (_, index) => `## P${index + 1}\n\nContent`).join("\n\n"),
      },
    ],
    workspace: { path: "/docs", title: "docs" },
    session: {
      recent: [],
      openPaths: ["/docs/motion.md"],
      activePath: "/docs/motion.md",
      workspacePath: "/docs",
    },
  };
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");
};

const sampleExpansion = (page: Page, selector: string) =>
  page.evaluate(
    ({ selector }) =>
      new Promise<
        Array<{
          railWidth: number;
          headerWidth: number;
          railTransform: string;
          itemTransforms: string[];
          animationKinds: string[];
        }>
      >((resolve) => {
        const frames: Awaited<ReturnType<typeof sampleExpansion>> = [];
        const rail = document.querySelector<HTMLElement>(selector)!;
        const header = document.querySelector<HTMLElement>(".app-header-leading")!;
        const started = performance.now();
        const sample = (now: number) => {
          frames.push({
            railWidth: rail.getBoundingClientRect().width,
            headerWidth: header.getBoundingClientRect().width,
            railTransform: getComputedStyle(rail).transform,
            itemTransforms: Array.from(
              rail.querySelectorAll<HTMLElement>("[data-motion-item]"),
              (item) => getComputedStyle(item).transform,
            ),
            animationKinds: rail.getAnimations().map((animation) => animation.constructor.name),
          });
          if (now - started < 240) requestAnimationFrame(sample);
          else resolve(frames);
        };
        requestAnimationFrame(sample);
      }),
    { selector },
  );

const expectSingleLayoutTransition = (
  frames: Awaited<ReturnType<typeof sampleExpansion>>,
  targetWidth: number,
) => {
  expect(frames.length).toBeGreaterThan(5);
  expect(frames.at(-1)?.railWidth).toBeCloseTo(targetWidth, 1);
  expect(
    frames.some((frame) => frame.railWidth > 1 && frame.railWidth < targetWidth - 1),
  ).toBe(true);
  for (const frame of frames) {
    expect(frame.railTransform).toBe("none");
    for (const transform of frame.itemTransforms) expect(transform).toBe("none");
    expect(frame.animationKinds).not.toContain("CSSAnimation");
  }
};

test("expands the explorer with one transition and no trailing item motion", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await expect(page.locator(".sidebar-rail")).toHaveCSS("width", "0px");

  await page.getByRole("button", { name: "展开侧栏" }).click();
  const frames = await sampleExpansion(page, ".sidebar-rail");

  expectSingleLayoutTransition(frames, 260);
  for (const frame of frames) {
    expect(Math.abs(frame.headerWidth - 36 - frame.railWidth)).toBeLessThanOrEqual(1);
  }
});

test("expands the outline with one transition and no trailing item motion", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "展开右侧栏" }).click();
  const frames = await sampleExpansion(page, ".outline-rail");

  expectSingleLayoutTransition(frames, 300);
});


test("keeps the explorer toggle visible and usable after collapsing", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => document.documentElement.classList.add("tauri"));
  const toggle = page.locator(".app-header .sidebar-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "收起侧栏");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "展开侧栏");
  await expect(page.locator(".sidebar-rail")).toHaveAttribute("data-collapsed", "true");
  await expect(page.locator(".sidebar-settings")).toBeHidden();
  const collapsedBox = await toggle.boundingBox();
  expect(collapsedBox).not.toBeNull();
  expect(collapsedBox!.width).toBeGreaterThanOrEqual(32);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "收起侧栏");
  await expect(page.locator(".sidebar-rail")).toHaveAttribute("data-collapsed", "false");
  await expect(page.locator(".sidebar-settings")).toBeVisible();
});

test("removes only the bottom inverse corners from both sidebars", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "展开右侧栏" }).click();

  const corners = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector)!;
      const top = getComputedStyle(element, "::before");
      const bottom = getComputedStyle(element, "::after");
      return {
        topContent: top.content,
        topBackground: top.backgroundImage,
        bottomContent: bottom.content,
        bottomBackground: bottom.backgroundImage,
      };
    };
    return {
      left: read(".sidebar-rail"),
      right: read(".outline-rail"),
    };
  });

  for (const side of [corners.left, corners.right]) {
    expect(side.topContent).not.toBe("none");
    expect(side.topBackground).toContain("radial-gradient");
    expect(side.bottomContent).toBe("none");
    expect(side.bottomBackground).toBe("none");
  }
});
