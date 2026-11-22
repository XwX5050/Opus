import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";
import AppShell from "./AppShell";

const file = (path: string, text: string): OpenedFile => ({
  path,
  text,
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

const workspacePort = () =>
  new MemoryDocumentPort(
    new Map([
      ["/notes/alpha.md", file("/notes/alpha.md", "Hello world")],
      ["/notes/drafts/gamma.md", file("/notes/drafts/gamma.md", "Draft")],
    ]),
    {
      workspace: { path: "/notes", title: "notes" },
      session: {
        recent: [],
        openPaths: ["/notes/alpha.md"],
        activePath: "/notes/alpha.md",
        workspacePath: "/notes",
      },
    },
  );

const railButton = (name: string) =>
  within(screen.getByRole("navigation", { name: "活动栏" })).getByRole("button", { name });

describe("workspace navigation", () => {
  it("switches between the file tree and a dedicated full-text search view", async () => {
    const user = userEvent.setup();
    render(<AppShell port={workspacePort()} />);
    await screen.findByRole("tree", { name: "工作区文件" });

    await user.click(railButton("搜索"));
    const sidebar = screen.getByRole("complementary", { name: "侧栏" });
    expect(within(sidebar).getByRole("heading", { name: "搜索" })).toBeVisible();
    expect(within(sidebar).getByRole("button", { name: "设置" })).toBeVisible();
    expect(within(sidebar).queryByRole("tree")).not.toBeInTheDocument();
    const input = within(sidebar).getByRole("combobox", { name: "工作区全文搜索" });
    expect(input).toHaveFocus();

    await user.type(input, "Hello");
    const option = await within(sidebar).findByRole("option", { name: /Hello world/ });
    await user.click(option);
    expect(await screen.findByRole("tab", { name: "alpha.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(railButton("搜索"));
    expect(await within(sidebar).findByRole("tree", { name: "工作区文件" })).toBeVisible();
  });

  it("opens files and creates Markdown documents from the file dialog", async () => {
    const user = userEvent.setup();
    const port = workspacePort();
    render(<AppShell port={port} />);
    await screen.findByRole("tree", { name: "工作区文件" });

    await user.click(railButton("文件"));
    const dialog = await screen.findByRole("dialog", { name: "文件" });
    const input = within(dialog).getByRole("combobox", { name: "切换或创建文件" });
    expect(input).toHaveFocus();
    expect(await within(dialog).findByRole("option", { name: /drafts\/gamma\.md/ })).toBeVisible();

    await user.type(input, "drafts/gamma");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("tab", { name: "gamma.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(railButton("文件"));
    const createDialog = await screen.findByRole("dialog", { name: "文件" });
    const createInput = within(createDialog).getByRole("combobox", { name: "切换或创建文件" });
    await user.type(createInput, "drafts/new-note");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(await screen.findByRole("tab", { name: "new-note.md" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(port.openPath("/notes/drafts/new-note.md")).resolves.toMatchObject({
      text: "",
    });
    expect(screen.queryByRole("dialog", { name: "文件" })).not.toBeInTheDocument();
  });

  it("returns to the explorer before opening the file dialog from search", async () => {
    const user = userEvent.setup();
    render(<AppShell port={workspacePort()} />);
    await screen.findByRole("tree", { name: "工作区文件" });

    await user.click(railButton("搜索"));
    expect(screen.getByRole("combobox", { name: "工作区全文搜索" })).toBeVisible();
    await user.click(railButton("文件"));

    expect(await screen.findByRole("tree", { name: "工作区文件" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "文件" })).not.toBeInTheDocument();
    await user.click(railButton("文件"));
    expect(await screen.findByRole("dialog", { name: "文件" })).toBeVisible();
  });

  it("shows six file options before More and closes on an outside pointer press", async () => {
    const user = userEvent.setup();
    const files = Array.from({ length: 8 }, (_, index) => {
      const path = `/notes/note-${index + 1}.md`;
      return [path, file(path, "note")] as const;
    });
    const port = new MemoryDocumentPort(new Map(files), {
      workspace: { path: "/notes", title: "notes" },
      session: {
        recent: [],
        openPaths: ["/notes/note-1.md"],
        activePath: "/notes/note-1.md",
        workspacePath: "/notes",
      },
    });
    render(<AppShell port={port} />);

    await user.click(railButton("文件"));
    const dialog = await screen.findByRole("dialog", { name: "文件" });
    await within(dialog).findAllByRole("option");
    expect(dialog.querySelectorAll(".file-switcher-list > [role='option']")).toHaveLength(6);
    expect(dialog.querySelector("details")).not.toHaveAttribute("open");
    expect(within(dialog).queryByRole("button", { name: "关闭文件切换" })).not.toBeInTheDocument();

    await user.click(within(dialog).getByText("更多…"));
    expect(within(dialog).getAllByRole("option")).toHaveLength(8);

    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      right: 400,
      bottom: 300,
      width: 300,
      height: 200,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(dialog, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(dialog, { clientX: 0, clientY: 0 });
    expect(screen.queryByRole("dialog", { name: "文件" })).not.toBeInTheDocument();
  });
});
