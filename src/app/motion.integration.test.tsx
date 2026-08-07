import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";
import AppShell from "./AppShell";

const file: OpenedFile = {
  path: "/notes/a.md",
  text: "# Heading\n\ncontent",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: "version-a",
};

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
});
