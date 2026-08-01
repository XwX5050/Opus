import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";

vi.mock("../editor/tableWidgets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../editor/tableWidgets")>();
  return {
    ...actual,
    focusMarkdownTableCell: vi.fn(
      (...args: Parameters<typeof actual.focusMarkdownTableCell>) =>
        actual.focusMarkdownTableCell(args[0], {
          ...args[1],
          cellIndex: 99,
        }),
    ),
  };
});

import { focusMarkdownTableCell } from "../editor/tableWidgets";
import AppShell from "./AppShell";

const source = [
  "| Name | Note |",
  "| --- | --- |",
  "| Ada | old |",
].join("\n");

const file = (path: string, text: string): OpenedFile => ({
  path,
  text,
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

const tableCell = (index: number) => {
  const cell = document.querySelector<HTMLElement>(
    `.md-table [data-cell-index="${index}"]`,
  );
  if (!cell) throw new Error(`Missing table cell ${index}`);
  return cell;
};

describe("AppShell rejected table-focus requests", () => {
  it("acknowledges a rejected request so remounting its tab cannot replay it", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map([
      ["/notes/a.md", file("/notes/a.md", source)],
      ["/notes/b.md", file("/notes/b.md", "other document")],
    ]));
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    await user.click(screen.getByRole("tab", { name: /a\.md/ }));
    await user.click(screen.getByRole("button", { name: "编辑模式" }));
    await user.click(tableCell(3));

    await waitFor(() => expect(focusMarkdownTableCell).toHaveBeenCalledOnce());
    expect(focusMarkdownTableCell).toHaveReturnedWith(false);
    expect(screen.getByRole("button", { name: "编辑模式" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(port.writes).toHaveLength(0);
    expect(screen.getByRole("tab", { name: /a\.md/ }))
      .not.toHaveAccessibleName(/未保存/);

    vi.mocked(focusMarkdownTableCell).mockClear();
    await user.click(screen.getByRole("tab", { name: /b\.md/ }));
    await user.click(screen.getByRole("tab", { name: /a\.md/ }));

    expect(focusMarkdownTableCell).not.toHaveBeenCalled();
    expect(port.writes).toHaveLength(0);
    expect(screen.getByRole("tab", { name: /a\.md/ }))
      .not.toHaveAccessibleName(/未保存/);
  });
});
