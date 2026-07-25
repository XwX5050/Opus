import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DocumentSnapshot, PendingWriteRequest } from "../document/types";
import TabList from "./TabList";

const tab = (
  id: string,
  title: string,
  overrides: Partial<DocumentSnapshot> = {},
): DocumentSnapshot => ({
  id,
  path: `/notes/${title}`,
  title,
  text: "saved",
  savedText: "saved",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${id}`,
  status: "clean",
  ...overrides,
});

const pendingSave = (documentId: string): PendingWriteRequest => ({
  requestId: `save-${documentId}`,
  documentId,
  targetPath: "/notes/a.md",
  text: "in flight",
  hasUtf8Bom: false,
  newline: "lf",
  expectedVersion: null,
  pathPlatform: "macos",
});

const renderTabList = (
  tabs: ReadonlyArray<DocumentSnapshot>,
  activeId: string | null = tabs.at(-1)?.id ?? null,
) => {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  render(
    <TabList tabs={tabs} activeId={activeId} onActivate={onActivate} onClose={onClose} />,
  );
  return { onActivate, onClose };
};

describe("TabList", () => {
  it("renders a vertical tablist with each tab's title and status dot", () => {
    renderTabList([
      tab("document-1", "a.md"),
      tab("document-2", "b.md", { status: "dirty", text: "changed" }),
      tab("document-3", "c.md", { status: "conflict" }),
    ]);

    const tablist = screen.getByRole("tablist", { name: "打开的文档" });
    expect(tablist).toHaveAttribute("aria-orientation", "vertical");
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveTextContent("a.md");
    expect(tabs[0]).not.toHaveTextContent("●");
    expect(tabs[1]).toHaveTextContent("●");
    expect(tabs[2]).toHaveTextContent("●");
    expect(tabs[1]).toHaveAccessibleName(/b\.md.*未保存/);
  });

  it("links tabs to their panel with stable ids and roving tabindex", () => {
    renderTabList([tab("document-1", "a.md"), tab("document-2", "b.md")], "document-1");

    const first = screen.getByRole("tab", { name: /a\.md/ });
    const second = screen.getByRole("tab", { name: /b\.md/ });
    expect(first).toHaveAttribute("id", "document-tab-document-1");
    expect(first).toHaveAttribute("aria-controls", "document-panel-document-1");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("aria-selected", "false");
    expect(second).toHaveAttribute("tabindex", "-1");
  });

  it("activates a tab on click and closes it through the close button", async () => {
    const user = userEvent.setup();
    const { onActivate, onClose } = renderTabList([
      tab("document-1", "a.md"),
      tab("document-2", "b.md"),
    ]);

    await user.click(screen.getByRole("tab", { name: /a\.md/ }));
    expect(onActivate).toHaveBeenCalledWith("document-1");

    await user.click(screen.getByRole("button", { name: "关闭 b.md" }));
    expect(onClose).toHaveBeenCalledWith("document-2");
  });

  it("disables the close button while a save is pending", () => {
    renderTabList([
      tab("document-1", "a.md", { pendingSave: pendingSave("document-1") }),
    ]);

    expect(screen.getByRole("button", { name: "关闭 a.md" })).toBeDisabled();
  });

  it("moves focus and selection with ArrowUp/ArrowDown, wrapping at both ends", async () => {
    const user = userEvent.setup();
    const { onActivate } = renderTabList([
      tab("document-1", "a.md"),
      tab("document-2", "b.md"),
      tab("document-3", "c.md"),
    ]);
    onActivate.mockClear();

    const tabs = screen.getAllByRole("tab");
    tabs[2].focus();
    await user.keyboard("{ArrowDown}");
    expect(tabs[0]).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith("document-1");

    await user.keyboard("{ArrowUp}");
    expect(tabs[2]).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith("document-3");

    await user.keyboard("{ArrowUp}");
    expect(tabs[1]).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith("document-2");
  });

  it("jumps to the first and last tab with Home and End", async () => {
    const user = userEvent.setup();
    const { onActivate } = renderTabList([
      tab("document-1", "a.md"),
      tab("document-2", "b.md"),
      tab("document-3", "c.md"),
    ]);
    onActivate.mockClear();

    const tabs = screen.getAllByRole("tab");
    tabs[1].focus();
    await user.keyboard("{Home}");
    expect(tabs[0]).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith("document-1");

    await user.keyboard("{End}");
    expect(tabs[2]).toHaveFocus();
    expect(onActivate).toHaveBeenLastCalledWith("document-3");
  });
});
