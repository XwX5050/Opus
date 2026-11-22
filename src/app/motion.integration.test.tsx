import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";
import * as motionRuntime from "../motion/motionRuntime";
import AppShell from "./AppShell";

vi.mock("../motion/motionRuntime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../motion/motionRuntime")>();
  return { ...actual, animatePanelIntro: vi.fn(actual.animatePanelIntro) };
});

const file: OpenedFile = {
  path: "/notes/a.md",
  text: "# Heading\n\ncontent",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: "version-a",
};

const panel = (selector: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing panel: ${selector}`);
  return element;
};

const panelIntroMock = () => vi.mocked(motionRuntime.animatePanelIntro);
const panelIntroTargets = () => panelIntroMock().mock.calls.map(([target]) => target);

describe("AppShell motion contracts", () => {
  it("exposes scoped motion targets without changing sidebar ARIA state", async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        port={new MemoryDocumentPort(new Map([[file.path, file]]))}
      />,
    );

    expect(screen.getByRole("main")).toHaveAttribute("data-motion-shell");
    await user.click(screen.getByRole("button", { name: "打开文件" }));

    expect(screen.getByRole("tablist")).toHaveAttribute("data-motion-list");
    expect(screen.getByRole("tab", { name: "a.md" })).toHaveAttribute(
      "data-motion-item",
    );
    await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    const sidebar = document.querySelector<HTMLElement>('aside[aria-label="侧栏"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(sidebar).toHaveAttribute("inert", "");
  });

  it("animates only the outline when the right sidebar expands", async () => {
    const user = userEvent.setup();
    render(
      <AppShell port={new MemoryDocumentPort(new Map([[file.path, file]]))} />,
    );
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    const sidebar = panel(".sidebar-rail");
    const outline = panel(".outline-rail");
    panelIntroMock().mockClear();

    await user.click(screen.getByRole("button", { name: "展开右侧栏" }));

    expect(panelIntroTargets()).toContain(outline);
    expect(panelIntroTargets()).not.toContain(sidebar);
  });

  it("animates only the explorer when the left sidebar expands", async () => {
    const user = userEvent.setup();
    render(
      <AppShell port={new MemoryDocumentPort(new Map([[file.path, file]]))} />,
    );
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    await user.click(screen.getByRole("button", { name: "展开右侧栏" }));
    await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    const sidebar = panel(".sidebar-rail");
    const outline = panel(".outline-rail");
    panelIntroMock().mockClear();

    await user.click(screen.getByRole("button", { name: "展开侧栏" }));

    expect(panelIntroTargets()).toContain(sidebar);
    expect(panelIntroTargets()).not.toContain(outline);
  });
});
