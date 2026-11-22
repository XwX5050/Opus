import { expect, test } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

const fixture: E2eFixtureSpec = {
  files: [
    {
      path: "/docs/decorations.md",
      text: "# Decorations\n\n> A quiet quote.\n\nThe array is `[4, 2, 7]` here.\n",
    },
  ],
  workspace: { path: "/docs", title: "docs" },
  session: {
    recent: [],
    openPaths: ["/docs/decorations.md"],
    activePath: "/docs/decorations.md",
    workspacePath: "/docs",
  },
};

test("renders borderless quotes, math-like inline code and a localized neutral resize glow", async ({
  page,
}) => {
  await page.addInitScript((spec) => {
    window.__E2E_FIXTURE__ = spec;
  }, fixture);
  await page.goto("/");

  const inlineCode = page.locator(".cm-live-preview-inline-code");
  await expect(inlineCode).toHaveText("[4, 2, 7]");
  const decoration = await page.evaluate(() => {
    const code = document.querySelector(".cm-live-preview-inline-code")!;
    const quote = document.querySelector(".cm-live-preview-quote-line")!;
    const codeStyle = getComputedStyle(code);
    return {
      fontFamily: codeStyle.fontFamily,
      fontStyle: codeStyle.fontStyle,
      backgroundColor: codeStyle.backgroundColor,
      borderWidth: codeStyle.borderTopWidth,
      quoteMarker: getComputedStyle(quote, "::before").content,
    };
  });
  expect(decoration.fontFamily).toContain("KaTeX_Math");
  expect(decoration.fontStyle).toBe("italic");
  expect(decoration.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(decoration.borderWidth).toBe("0px");
  expect(decoration.quoteMarker).toBe("none");

  const resizer = page.getByRole("slider", { name: "调整侧栏宽度" });
  await resizer.hover();
  const indicator = await resizer.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    const height = element.getBoundingClientRect().height;
    return {
      color: style.backgroundColor,
      glow: style.boxShadow,
      top: Number.parseFloat(style.top) / height,
      height: Number.parseFloat(style.height) / height,
    };
  });
  expect(indicator.color).toBe("rgb(208, 208, 212)");
  expect(indicator.glow).not.toBe("none");
  expect(indicator.top).toBeCloseTo(0.16, 2);
  expect(indicator.height).toBeCloseTo(0.68, 2);
});
