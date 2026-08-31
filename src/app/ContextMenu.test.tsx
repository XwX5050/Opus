import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

type MenuActionItem = Extract<ContextMenuItem, { id: string }>;

const actionItem = (
  id: string,
  label: string,
  overrides: Partial<Omit<MenuActionItem, "id" | "label">> = {},
): MenuActionItem => ({ id, label, onSelect: vi.fn(), ...overrides });

const renderMenu = (items: ReadonlyArray<ContextMenuItem>) => {
  const onClose = vi.fn();
  const { unmount } = render(
    <ContextMenu position={{ x: 100, y: 200 }} items={items} onClose={onClose} />,
  );
  const menu = screen.getByRole("menu");
  return { menu, onClose, unmount };
};

describe("ContextMenu", () => {
  it("renders items and separators in a portal with the menu ARIA roles", () => {
    const { menu } = renderMenu([
      actionItem("open", "打开", { shortcut: "⌘O" }),
      { type: "separator" },
      actionItem("delete", "删除", { danger: true, disabled: true }),
    ]);

    expect(menu).toHaveClass("context-menu");
    expect(menu.parentElement).toBe(document.body);
    const menuItems = within(menu).getAllByRole("menuitem");
    expect(menuItems).toHaveLength(2);
    expect(menuItems[0]).toHaveTextContent("打开");
    expect(within(menuItems[0]).getByText("⌘O")).toHaveClass("context-menu-shortcut");
    expect(menuItems[1]).toHaveClass("context-menu-item", "context-menu-item-danger");
    expect(menuItems[1]).toHaveAttribute("aria-disabled", "true");
    expect(menuItems[1]).toBeDisabled();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("focuses the first enabled item and cycles with arrow keys, Home and End", () => {
    const { menu } = renderMenu([
      actionItem("a", "A", { disabled: true }),
      { type: "separator" },
      actionItem("b", "B"),
      actionItem("c", "C"),
      actionItem("x", "X", { disabled: true }),
      actionItem("d", "D"),
    ]);
    const menuItems = within(menu).getAllByRole("menuitem");
    expect(menuItems[0]).toBeDisabled();
    expect(menuItems[1]).toHaveFocus(); // first enabled item

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menuItems[2]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menuItems[4]).toHaveFocus(); // skips the disabled item
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menuItems[1]).toHaveFocus(); // wraps around
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(menuItems[4]).toHaveFocus(); // wraps backwards
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(menuItems[2]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Home" });
    expect(menuItems[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(menuItems[4]).toHaveFocus();
  });

  it("activates the focused item on Enter", () => {
    const onSelect = vi.fn();
    const { menu, onClose } = renderMenu([
      actionItem("a", "A", { onSelect }),
      actionItem("b", "B"),
    ]);
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("activates the focused item on Space", () => {
    const onSelect = vi.fn();
    const { menu, onClose } = renderMenu([
      actionItem("a", "A", { onSelect }),
      actionItem("b", "B"),
    ]);
    fireEvent.keyDown(menu, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without activating an item", () => {
    const onSelect = vi.fn();
    const { menu, onClose } = renderMenu([actionItem("a", "A", { onSelect })]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("activates an item by click and closes", () => {
    const onSelect = vi.fn();
    const { onClose } = renderMenu([actionItem("a", "A", { onSelect })]);
    fireEvent.click(screen.getByRole("menuitem"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never activates disabled items", () => {
    const onSelect = vi.fn();
    const { menu } = renderMenu([actionItem("a", "A", { disabled: true, onSelect })]);
    fireEvent.click(screen.getByRole("menuitem"));
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on pointerdown outside the menu but not inside it", () => {
    const { menu, onClose } = renderMenu([actionItem("a", "A")]);
    fireEvent.pointerDown(within(menu).getByRole("menuitem"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the window loses focus", () => {
    const { onClose } = renderMenu([actionItem("a", "A")]);
    window.dispatchEvent(new Event("blur"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the previously focused element when it closes", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { menu, unmount } = renderMenu([actionItem("a", "A")]);
    expect(within(menu).getByRole("menuitem")).toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});