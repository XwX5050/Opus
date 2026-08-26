import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile } from "../document/types";
import AppShell from "./AppShell";

vi.mock("./updates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./updates")>();
  return {
    ...actual,
    checkUpdate: vi.fn().mockResolvedValue({ status: "unsupported" }),
  };
});

const file = (path: string, text = "saved"): OpenedFile => ({
  path,
  text,
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

// The Linux native header replaces the native menu bar: no header text
// buttons (fileActionsInHeader is false in production), the file menu and
// window-level shortcuts take over.
const renderLinux = (port: MemoryDocumentPort) =>
  render(
    <AppShell port={port} fileActionsInHeader={false} linuxNativeHeader />,
  );

const titlebar = () => screen.getByRole("banner", { name: "应用标题栏" });
const fileMenuToggle = () =>
  within(titlebar()).getByRole("button", { name: "文件" });

const editorText = () => screen.getByRole("textbox", { name: "Markdown 编辑器" });
const replaceEditorText = (text: string) => {
  const view = EditorView.findFromDOM(editorText());
  if (!view) throw new Error("EditorView not found");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
};

describe("AppShell Linux native header", () => {
  it("drops the window title and the header text buttons", () => {
    renderLinux(new MemoryDocumentPort(new Map()));

    expect(screen.queryByText("Opus")).not.toBeInTheDocument();
    const toggle = fileMenuToggle();
    expect(toggle).toHaveAttribute("aria-haspopup", "menu");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(titlebar()).queryByRole("button", { name: "新建" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "另存为…" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "设置" }),
    ).not.toBeInTheDocument();
  });

  it("opens the file menu with focus on the first item", async () => {
    const user = userEvent.setup();
    renderLinux(new MemoryDocumentPort(new Map()));

    await user.click(fileMenuToggle());

    const menu = screen.getByRole("menu", { name: "文件" });
    expect(fileMenuToggle()).toHaveAttribute("aria-expanded", "true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "新建",
      "打开文件",
      "打开文件夹",
      "另存为…",
      "设置",
    ]);
    expect(items[0]).toHaveFocus();
  });

  it("runs 新建 from the menu, closes it, and keeps focus on the toggle", async () => {
    const user = userEvent.setup();
    renderLinux(new MemoryDocumentPort(new Map()));

    await user.click(fileMenuToggle());
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "新建" }),
    );

    expect(await screen.findByRole("tab", { name: /Untitled/ })).toBeVisible();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(fileMenuToggle()).toHaveFocus();
  });

  it("closes on Escape and restores focus to the toggle", async () => {
    const user = userEvent.setup();
    renderLinux(new MemoryDocumentPort(new Map()));

    await user.click(fileMenuToggle());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(fileMenuToggle()).toHaveAttribute("aria-expanded", "false");
    expect(fileMenuToggle()).toHaveFocus();
  });

  it("closes on an outside pointerdown", async () => {
    const user = userEvent.setup();
    renderLinux(new MemoryDocumentPort(new Map()));

    await user.click(fileMenuToggle());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("supports roving focus with arrow keys", async () => {
    const user = userEvent.setup();
    renderLinux(new MemoryDocumentPort(new Map()));

    await user.click(fileMenuToggle());
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0]).toHaveFocus();
  });

  it("opens the settings dialog from the menu and restores focus on close", async () => {
    const user = userEvent.setup();
    renderLinux(new MemoryDocumentPort(new Map()));

    await user.click(fileMenuToggle());
    await user.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "设置" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(dialog).toBeVisible();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "完成" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "设置" })).not.toBeInTheDocument(),
    );
    expect(fileMenuToggle()).toHaveFocus();
  });

  it("binds Ctrl+N to 新建 and Ctrl+O to 打开文件 at the window level", async () => {
    renderLinux(
      new MemoryDocumentPort(new Map([["/notes/a.md", file("/notes/a.md")]])),
    );

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(await screen.findByRole("tab", { name: /Untitled/ })).toBeVisible();

    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(await screen.findByRole("tab", { name: /a\.md/ })).toBeVisible();
  });

  it("binds Ctrl+Shift+O to 打开文件夹", async () => {
    renderLinux(
      new MemoryDocumentPort(new Map(), {
        workspace: { path: "/ws", title: "ws" },
      }),
    );

    fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });

    expect(
      await screen.findByRole("complementary", { name: "侧栏" }),
    ).toBeVisible();
  });

  it("binds Ctrl+W to closing the active tab", async () => {
    renderLinux(
      new MemoryDocumentPort(new Map([["/notes/a.md", file("/notes/a.md")]])),
    );
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(await screen.findByRole("tab", { name: /a\.md/ })).toBeVisible();

    fireEvent.keyDown(window, { key: "w", ctrlKey: true });

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: /a\.md/ })).not.toBeInTheDocument(),
    );
  });

  it("binds Ctrl+, to settings and gates shortcuts while a dialog is open", async () => {
    renderLinux(new MemoryDocumentPort(new Map()));

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "设置" })).toBeVisible();

    // Menu accelerators are gated while a modal dialog is up, like the
    // native menu handler.
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("saves exactly once on Ctrl+S with the editor focused", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md", "saved")]]),
    );
    renderLinux(port);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await screen.findByRole("tab", { name: /a\.md/ });
    act(() => replaceEditorText("changed"));

    // The CodeMirror Mod-s keymap handles the chord and preventDefaults it;
    // the window-level binding must not fire a second save.
    editorText().focus();
    await user.keyboard("{Control>}s{/Control}");

    await waitFor(() => expect(port.writes).toHaveLength(1));
    expect(port.writes[0]).toMatchObject({
      targetPath: "/notes/a.md",
      text: "changed",
    });
  });

  it("ignores chords that were already handled (defaultPrevented)", () => {
    renderLinux(new MemoryDocumentPort(new Map()));
    const sink = document.createElement("div");
    sink.addEventListener("keydown", (event) => event.preventDefault());
    document.body.appendChild(sink);
    try {
      fireEvent.keyDown(sink, { key: "n", ctrlKey: true });
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    } finally {
      sink.remove();
    }
  });

  it("keeps the browser-shell header unchanged without the flag", () => {
    render(<AppShell port={new MemoryDocumentPort(new Map())} />);

    expect(screen.getByText("Opus")).toBeInTheDocument();
    expect(
      within(titlebar()).queryByRole("button", { name: "文件" }),
    ).not.toBeInTheDocument();

    // Window-level menu shortcuts stay off outside Linux native builds.
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});