import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ConflictDialog from "./ConflictDialog";

const renderDialog = (overrides: Partial<Parameters<typeof ConflictDialog>[0]> = {}) => {
  const props = {
    title: "a.md",
    path: "/notes/a.md",
    onLoadDisk: vi.fn(),
    onKeepLocal: vi.fn(),
    onSaveAs: vi.fn(),
    ...overrides,
  };
  render(<ConflictDialog {...props} />);
  return props;
};

describe("ConflictDialog", () => {
  it("exposes all three resolution actions and focuses the non-destructive one", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "文件已在磁盘上更改" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("button", { name: "载入磁盘版本" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "保留当前版本" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "另存为…" })).toBeVisible();
    expect(within(dialog).getByText(/\/notes\/a\.md/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "保留当前版本" })).toHaveFocus();
  });

  it("requires an explicit click for the destructive disk-version load", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    expect(props.onLoadDisk).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "载入磁盘版本" }));
    expect(props.onLoadDisk).toHaveBeenCalledOnce();
    expect(props.onKeepLocal).not.toHaveBeenCalled();
  });

  it("keeps the local version from its button and from Escape", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole("button", { name: "保留当前版本" }));
    expect(props.onKeepLocal).toHaveBeenCalledOnce();
    expect(props.onLoadDisk).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(props.onKeepLocal).toHaveBeenCalledTimes(2);
  });

  it("offers save-as as an explicit choice", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole("button", { name: "另存为…" }));
    expect(props.onSaveAs).toHaveBeenCalledOnce();
    expect(props.onLoadDisk).not.toHaveBeenCalled();
    expect(props.onKeepLocal).not.toHaveBeenCalled();
  });

  it("traps tab focus within the dialog", async () => {
    const user = userEvent.setup();
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "文件已在磁盘上更改" });
    const first = within(dialog).getByRole("button", { name: "载入磁盘版本" });
    const last = within(dialog).getByRole("button", { name: "另存为…" });
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});
