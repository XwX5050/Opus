import { expect, test, type Page } from "@playwright/test";
import type { E2eFixtureSpec } from "../../src/app/e2e";

const documentText = [
  "---",
  "title: Decorations",
  "---",
  "",
  "# Decorations",
  "",
  "> A quiet quote.",
  "",
  "The array is `[4, 2, 7]` here.",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Col |",
  "| --- |",
  "| cell |",
  "",
  "---",
  "",
  "Tail paragraph.",
  "",
].join("\n");

const fixture: E2eFixtureSpec = {
  files: [{ path: "/docs/decorations.md", text: documentText }],
  workspace: { path: "/docs", title: "docs" },
  session: {
    recent: [],
    openPaths: ["/docs/decorations.md"],
    activePath: "/docs/decorations.md",
    workspacePath: "/docs",
  },
};

const seed = async (page: Page, spec: E2eFixtureSpec = fixture) => {
  await page.addInitScript((seeded) => {
    window.__E2E_FIXTURE__ = seeded;
  }, spec);
  await page.goto("/");
  await page.locator(".cm-content").waitFor();
};

/** Headings on the document's first lines: no margin above to hang into. */
const firstLineHeadingFixture: E2eFixtureSpec = {
  files: [
    {
      path: "/docs/narrow.md",
      text: "# Narrow heading\n\n## Second heading\n\nTail paragraph.\n",
    },
  ],
  workspace: { path: "/docs", title: "docs" },
  session: {
    recent: [],
    openPaths: ["/docs/narrow.md"],
    activePath: "/docs/narrow.md",
    workspacePath: "/docs",
  },
};

/** A short deck with both fenced and inline code on one slide. */
const presentationFixture: E2eFixtureSpec = {
  files: [
    {
      path: "/docs/deck.md",
      text: [
        "# Code",
        "",
        "Inline `n = 1` and `m = 2`.",
        "",
        "```ts",
        "const answer = 42;",
        "```",
        "",
        "Tail.",
        "",
      ].join("\n"),
    },
  ],
  workspace: { path: "/docs", title: "docs" },
  session: {
    recent: [],
    openPaths: ["/docs/deck.md"],
    activePath: "/docs/deck.md",
    workspacePath: "/docs",
  },
};

/** A fence nested in a blockquote: quote and code line classes overlap. */
const nestedQuoteCodeFixture: E2eFixtureSpec = {
  files: [
    {
      path: "/docs/nested.md",
      text: "> A quote.\n>\n> ```ts\n> const nested = 1;\n> ```\n",
    },
  ],
  workspace: { path: "/docs", title: "docs" },
  session: {
    recent: [],
    openPaths: ["/docs/nested.md"],
    activePath: "/docs/nested.md",
    workspacePath: "/docs",
  },
};

/** Parses `rgb(r, g, b)` / `rgba(r, g, b, a)` into channels. */
const channels = (color: string) => {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`Unsupported color: ${color}`);
  return match[1]
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));
};

test("renders quiet code surfaces, a legible corner language label, and monospace inline code", async ({
  page,
}) => {
  await seed(page);

  const inlineCode = page.locator(".cm-live-preview-inline-code");
  await expect(inlineCode).toHaveText("[4, 2, 7]");
  const inlineStyle = await inlineCode.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontFamily: style.fontFamily,
      fontStyle: style.fontStyle,
      backgroundColor: style.backgroundColor,
      paddingInline: Number.parseFloat(style.paddingInlineStart),
    };
  });
  expect(inlineStyle.fontFamily).toContain("monospace");
  expect(inlineStyle.fontFamily).not.toContain("KaTeX");
  expect(inlineStyle.fontStyle).toBe("normal");
  expect(inlineStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(inlineStyle.paddingInline).toBeGreaterThan(0);

  const frontmatter = await page
    .locator(".cm-live-preview-frontmatter")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        opacity: Number.parseFloat(style.opacity),
        backgroundColor: style.backgroundColor,
      };
    });
  const bodySize = await page
    .locator(".cm-content")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(frontmatter.fontSize).toBeLessThan(bodySize);
  expect(frontmatter.opacity).toBeLessThan(1);
  expect(frontmatter.backgroundColor).toBe("rgba(0, 0, 0, 0)");

  const codeBlock = page.locator(".cm-live-preview-code-block", {
    hasText: "const answer = 42;",
  });
  await expect(codeBlock).toBeVisible();

  const geometry = await page.evaluate(() => {
    const line = document.querySelector<HTMLElement>(
      ".cm-line.cm-live-preview-code-line-first",
    )!;
    const badge = document.querySelector<HTMLElement>(
      ".cm-live-preview-code-lang-badge",
    )!;
    const lineRect = line.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    const body = getComputedStyle(document.body);
    return {
      canvas: body.backgroundColor,
      surface: getComputedStyle(line).backgroundColor,
      lineRect: {
        left: lineRect.left,
        right: lineRect.right,
        top: lineRect.top,
      },
      badgeRect: {
        left: badgeRect.left,
        right: badgeRect.right,
        top: badgeRect.top,
        width: badgeRect.width,
      },
      badgeFontSize: Number.parseFloat(getComputedStyle(badge).fontSize),
      badgeText: badge.textContent,
      lineBorderWidth: getComputedStyle(line).borderTopWidth,
    };
  });

  // The block surface stays within a few RGB steps of the canvas: a whisper
  // of contrast, never a card.
  const canvas = channels(geometry.canvas);
  const surface = channels(geometry.surface);
  const channelDelta = Math.max(
    ...surface.map((value, index) => Math.abs(value - canvas[index]!)),
  );
  expect(channelDelta).toBeLessThanOrEqual(10);
  expect(surface).not.toEqual(canvas);

  // The label sits at the block's top-left, not at the column's far edge.
  expect(geometry.badgeText).toBe("ts");
  expect(geometry.badgeFontSize).toBeGreaterThanOrEqual(11);
  expect(geometry.badgeRect.width).toBeGreaterThan(0);
  expect(geometry.badgeRect.left).toBeGreaterThanOrEqual(
    geometry.lineRect.left,
  );
  expect(geometry.badgeRect.left - geometry.lineRect.left).toBeLessThan(24);
  expect(geometry.badgeRect.top - geometry.lineRect.top).toBeLessThan(14);
  expect(geometry.badgeRect.right).toBeLessThan(geometry.lineRect.right);
  expect(geometry.lineBorderWidth).toBe("0px");

  const rhythm = await page.evaluate(() => {
    const quote = document.querySelector<HTMLElement>(
      ".cm-live-preview-quote-line-single",
    )!;
    const ruleLine = document.querySelector<HTMLElement>(
      ".cm-live-preview-rule-line",
    )!;
    const table = document.querySelector<HTMLElement>(".md-table-frame")!;
    const firstCodeLine = document.querySelector<HTMLElement>(
      ".cm-line.cm-live-preview-code-line-first",
    )!;
    const lastCodeLine = document.querySelector<HTMLElement>(
      ".cm-line.cm-live-preview-code-line-last",
    )!;
    const style = (element: HTMLElement) => getComputedStyle(element);
    return {
      quotePadding: Number.parseFloat(style(quote).paddingTop),
      rulePadding: Number.parseFloat(style(ruleLine).paddingTop),
      tableMargin: Number.parseFloat(style(table).marginBlockStart),
      codeTop: Number.parseFloat(style(firstCodeLine).paddingTop),
      codeBottom: Number.parseFloat(style(lastCodeLine).paddingBottom),
    };
  });
  // One shared inset/rhythm scale across quote, code, rule, and table.
  expect(rhythm.quotePadding).toBeCloseTo(rhythm.codeTop, 0);
  expect(rhythm.codeBottom).toBeCloseTo(rhythm.codeTop, 0);
  expect(rhythm.rulePadding).toBeGreaterThanOrEqual(rhythm.codeTop);
  expect(rhythm.tableMargin).toBeGreaterThanOrEqual(rhythm.codeTop);

  await expect(page.locator(".cm-live-preview-quote-line")).toHaveCount(1);
  expect(
    await page
      .locator(".cm-live-preview-quote-line")
      .evaluate((element) => getComputedStyle(element, "::before").content),
  ).toBe("none");
});

test("keeps the code surface on a fence nested inside a blockquote", async ({
  page,
}) => {
  await seed(page, nestedQuoteCodeFixture);
  const codeLine = page.locator(
    ".cm-line.cm-live-preview-code-line-middle",
    { hasText: "const nested = 1;" },
  );
  await expect(codeLine).toHaveClass(/cm-live-preview-quote-line/);

  const backgrounds = await page.evaluate(() => {
    const line = document.querySelector<HTMLElement>(
      ".cm-line.cm-live-preview-code-line-middle",
    )!;
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--surface-code)";
    document.body.append(probe);
    const surface = getComputedStyle(probe).backgroundColor;
    probe.style.backgroundColor = "var(--surface-quote)";
    const quote = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      code: getComputedStyle(line).backgroundColor,
      surface,
      quote,
    };
  });

  // Code lines win over the quote-line wash even when both classes sit on
  // the same line.
  expect(backgrounds.code).toBe(backgrounds.surface);
  expect(backgrounds.code).not.toBe(backgrounds.quote);
});

test("hangs the heading marker while editing without shifting the heading text", async ({
  page,
}) => {
  await seed(page);

  // Start with the caret away from the heading so its marker is hidden.
  await page.getByText("Tail paragraph.").click();
  const heading = page.locator(".cm-live-preview-heading-1");
  await expect(heading).toHaveText("Decorations");
  const before = await heading.evaluate((element) => {
    const headingRect = element.getBoundingClientRect();
    const contentRect = element
      .closest(".cm-content")!
      .getBoundingClientRect();
    return headingRect.left - contentRect.left;
  });

  await heading.click();
  const marker = page.locator(".cm-live-preview-heading-mark");
  await expect(marker).toBeAttached();
  const after = await heading.evaluate((element) => {
    const headingRect = element.getBoundingClientRect();
    const contentRect = element
      .closest(".cm-content")!
      .getBoundingClientRect();
    return {
      headingOffset: headingRect.left - contentRect.left,
      headingLeft: headingRect.left,
      textContent: element.textContent,
    };
  });
  expect(after.textContent).toBe("# Decorations");
  expect(after.headingOffset).toBeCloseTo(before, 1);

  const markerGeometry = await marker.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      text: element.textContent,
      left: rect.left,
      right: rect.right,
      width: rect.width,
    };
  });
  expect(markerGeometry.text).toBe("# ");
  expect(markerGeometry.width).toBeGreaterThan(0);
  // The whole marker run hangs left of the heading text.
  expect(markerGeometry.right).toBeLessThanOrEqual(after.headingLeft + 1);

  // The resizer glow contract is unrelated to typography but shares this
  // shell; keep it pinned against accidental style regressions.
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

test("keeps the heading source visible and unshifted in a narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 680, height: 800 });
  await seed(page, firstLineHeadingFixture);
  await page.getByText("Tail paragraph.").click();

  const heading = page.locator(".cm-live-preview-heading-1");
  await expect(heading).toHaveText("Narrow heading");
  const before = await heading.evaluate((element) => {
    const headingRect = element.getBoundingClientRect();
    const contentRect = element
      .closest(".cm-content")!
      .getBoundingClientRect();
    return headingRect.left - contentRect.left;
  });

  const linePadding = () =>
    page.evaluate(() => {
      const first = document
        .querySelector<HTMLElement>(".cm-live-preview-heading-1")!
        .closest<HTMLElement>(".cm-line")!;
      const second = document
        .querySelector<HTMLElement>(".cm-live-preview-heading-2")!
        .closest<HTMLElement>(".cm-line")!;
      return {
        first: Number.parseFloat(getComputedStyle(first).paddingTop),
        second: Number.parseFloat(getComputedStyle(second).paddingTop),
        firstRevealed: first.classList.contains(
          "cm-live-preview-heading-line-revealed",
        ),
        secondRevealed: second.classList.contains(
          "cm-live-preview-heading-line-revealed",
        ),
      };
    });

  // No heading reserves marker space until it is actually edited.
  expect(await linePadding()).toEqual({
    first: 0,
    second: 0,
    firstRevealed: false,
    secondRevealed: false,
  });

  await heading.click();
  await expect(
    page.locator(".cm-line.cm-live-preview-heading-line-revealed"),
  ).toHaveCount(1);
  const marker = page.locator(".cm-live-preview-heading-mark");
  await expect(marker).toBeVisible();
  const geometry = await page.evaluate(() => {
    const headingElement =
      document.querySelector<HTMLElement>(".cm-live-preview-heading-1")!;
    const markerElement =
      document.querySelector<HTMLElement>(".cm-live-preview-heading-mark")!;
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    const secondLine = document
      .querySelector<HTMLElement>(".cm-live-preview-heading-2")!
      .closest<HTMLElement>(".cm-line")!;
    return {
      heading: headingElement.getBoundingClientRect().toJSON(),
      marker: markerElement.getBoundingClientRect().toJSON(),
      content: content.getBoundingClientRect().toJSON(),
      secondPadding: Number.parseFloat(
        getComputedStyle(secondLine).paddingTop,
      ),
      secondRevealed: secondLine.classList.contains(
        "cm-live-preview-heading-line-revealed",
      ),
    };
  });

  // The marker sits inside the reading column, above the heading text (the
  // top-left corner has no margin to hang into at this width), and the
  // heading's left edge does not move.
  expect(geometry.marker.left).toBeGreaterThanOrEqual(
    geometry.content.left - 0.5,
  );
  expect(geometry.marker.right).toBeLessThanOrEqual(
    geometry.content.right + 0.5,
  );
  expect(geometry.marker.bottom).toBeLessThanOrEqual(
    geometry.heading.top + 1,
  );
  expect(geometry.heading.left - geometry.content.left).toBeCloseTo(
    before,
    1,
  );
  // Only the edited heading reserves the marker row.
  expect(geometry.secondPadding).toBe(0);
  expect(geometry.secondRevealed).toBe(false);

  // Leaving the heading restores its normal spacing.
  await page.getByText("Tail paragraph.").click();
  await expect(
    page.locator(".cm-line.cm-live-preview-heading-line-revealed"),
  ).toHaveCount(0);
  expect((await linePadding()).first).toBe(0);
});

test("renders the same quiet code treatment in presentation mode", async ({
  page,
}) => {
  await seed(page, presentationFixture);

  const expandOutline = page.getByRole("button", { name: "展开右侧栏" });
  if (await expandOutline.isVisible().catch(() => false)) {
    await expandOutline.click();
  }
  await page.getByRole("button", { name: "演示模式" }).click();

  const host = page
    .locator(".presentation-slide-host:not(.presentation-measure)")
    .first();
  await expect(host.locator(".cm-content")).toContainText(
    "const answer = 42;",
  );

  const styles = await page.evaluate(() => {
    const slideHost = document.querySelector<HTMLElement>(
      ".presentation-slide-host:not(.presentation-measure)",
    )!;
    const codeLine = slideHost.querySelector<HTMLElement>(
      ".cm-line.cm-live-preview-code-line-middle",
    )!;
    const badge = slideHost.querySelector<HTMLElement>(
      ".cm-live-preview-code-lang-badge",
    )!;
    const inline = slideHost.querySelector<HTMLElement>(
      ".cm-live-preview-inline-code",
    )!;
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--surface-code)";
    document.body.append(probe);
    const surface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const lineRect = codeLine.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    const badgeStyle = getComputedStyle(badge);
    const inlineStyle = getComputedStyle(inline);
    return {
      hostHasEditorLayout: slideHost.classList.contains("markdown-editor"),
      canvas: getComputedStyle(document.body).backgroundColor,
      code: getComputedStyle(codeLine).backgroundColor,
      surface,
      badge: {
        text: badge.textContent,
        position: badgeStyle.position,
        fontSize: Number.parseFloat(badgeStyle.fontSize),
        left: badgeRect.left,
        right: badgeRect.right,
        top: badgeRect.top,
        lineLeft: lineRect.left,
        lineRight: lineRect.right,
        lineTop: lineRect.top,
      },
      inline: {
        text: inline.textContent,
        fontFamily: inlineStyle.fontFamily,
        fontStyle: inlineStyle.fontStyle,
        backgroundColor: inlineStyle.backgroundColor,
      },
    };
  });

  expect(styles.hostHasEditorLayout).toBe(false);
  expect(styles.code).toBe(styles.surface);
  expect(styles.code).not.toBe(styles.canvas);
  expect(styles.badge.text).toBe("ts");
  expect(styles.badge.position).toBe("absolute");
  expect(styles.badge.fontSize).toBeGreaterThanOrEqual(11);
  expect(styles.badge.left).toBeGreaterThanOrEqual(styles.badge.lineLeft);
  expect(styles.badge.left - styles.badge.lineLeft).toBeLessThan(40);
  expect(styles.badge.top - styles.badge.lineTop).toBeLessThan(24);
  expect(styles.badge.right).toBeLessThan(styles.badge.lineRight);
  expect(styles.inline.text).toBe("n = 1");
  expect(styles.inline.fontFamily).toContain("monospace");
  expect(styles.inline.fontFamily).not.toContain("KaTeX");
  expect(styles.inline.fontStyle).toBe("normal");
  expect(styles.inline.backgroundColor).toBe(styles.surface);
});
