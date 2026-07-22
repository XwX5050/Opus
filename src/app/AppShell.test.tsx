import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { DocumentPort, SavedFile } from "../document/DocumentPort";
import { DocumentPortError } from "../document/DocumentPort";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile, PendingWriteRequest, SaveTarget } from "../document/types";
import AppShell from "./AppShell";

const file = (path: string, text = "saved"): OpenedFile => ({
  path,
  text,
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

class InspectablePort implements DocumentPort {
  readonly writes: PendingWriteRequest[] = [];
  readonly chosenTitles: string[] = [];
  writeResult: Promise<SavedFile> | undefined;

  constructor(
    readonly files: OpenedFile[] = [],
    readonly saveTarget: SaveTarget | null = null,
  ) {}

  async chooseAndOpenFiles() { return this.files; }
  async openPath(path: string) {
    const opened = this.files.find((candidate) => candidate.path === path);
    if (!opened) throw new DocumentPortError("not_found", path);
    return opened;
  }
  async chooseSavePath(title: string) {
    this.chosenTitles.push(title);
    return this.saveTarget;
  }
  write(request: PendingWriteRequest) {
    this.writes.push(request);
    return this.writeResult ?? Promise.resolve({
      path: request.targetPath,
      modifiedUnixMs: 2,
      version: "saved-v2",
    });
  }
}

const editor = () => screen.getByRole("textbox", { name: "Markdown 编辑器" });
const replaceEditorText = (text: string) => {
  const view = EditorView.findFromDOM(editor());
  if (!view) throw new Error("EditorView not found");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
};

describe("AppShell", () => {
  it("offers accessible new and open actions in the empty state", () => {
    render(<AppShell port={new MemoryDocumentPort(new Map())} />);

    expect(screen.getByRole("button", { name: "新建" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开文件" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "另存为…" })).not.toBeInTheDocument();
  });

  it("opens two files as tabs and focuses an equivalent path instead of duplicating it", async () => {
    const user = userEvent.setup();
    const port = new InspectablePort([
      file("/notes/A.md", "alpha"),
      file("/notes/B.md", "bravo"),
    ]);
    const { rerender } = render(<AppShell port={port} />);

    await user.click(screen.getByRole("button", { name: "打开文件" }));
    expect(editor()).not.toHaveFocus();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("tabindex", "-1");
    expect(tabs[1]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("aria-controls", "document-panel-document-2");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "document-panel-document-2");
    expect(screen.getByRole("tab", { name: /B\.md/ })).toHaveAttribute("aria-selected", "true");
    tabs[1].focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: /A\.md/ })).toHaveAttribute("aria-selected", "true");

    const duplicatePort = new InspectablePort([file("/NOTES/./a.md", "stale duplicate")]);
    rerender(<AppShell port={duplicatePort} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /A\.md/ })).toHaveAttribute("aria-selected", "true");
    expect(editor()).toHaveTextContent("alpha");
  });

  it("marks edits dirty and passes the reducer-owned frozen request directly to one write", async () => {
    const user = userEvent.setup();
    const pending = deferred<SavedFile>();
    const port = new InspectablePort([file("/notes/a.md")]);
    port.writeResult = pending.promise;
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));

    act(() => replaceEditorText("changed"));
    expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveTextContent("●");

    editor().focus();
    await user.keyboard("{Control>}s{/Control}");
    await user.keyboard("{Control>}s{/Control}");
    expect(port.writes).toHaveLength(1);
    expect(screen.getByRole("button", { name: "关闭 a.md" })).toBeDisabled();
    expect(port.writes[0]).toEqual({
      requestId: "save-1",
      documentId: expect.any(String),
      targetPath: "/notes/a.md",
      text: "changed",
      hasUtf8Bom: false,
      newline: "lf",
      expectedVersion: "version:/notes/a.md",
      pathPlatform: "macos",
    });
    expect(Object.isFrozen(port.writes[0])).toBe(true);

    act(() => replaceEditorText("changed after-save-start"));
    pending.resolve({ path: "/notes/a.md", modifiedUnixMs: 2, version: "v2" });
    await waitFor(() => expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveTextContent("●"));
    expect(editor()).toHaveTextContent("changed after-save-start");
  });

  it("chooses a target for untitled saves, cancels without writing, and blocks collisions", async () => {
    const user = userEvent.setup();
    const cancelled = new InspectablePort([], null);
    const { rerender } = render(<AppShell port={cancelled} />);
    await user.click(screen.getByRole("button", { name: "新建" }));
    act(() => replaceEditorText("draft"));
    editor().focus();
    await user.keyboard("{Control>}s{/Control}");
    expect(cancelled.chosenTitles).toEqual(["Untitled"]);
    expect(cancelled.writes).toHaveLength(0);

    const collision = new InspectablePort(
      [file("/notes/taken.md")],
      { path: "/NOTES/taken.md", expectedVersion: "version:/notes/taken.md" },
    );
    rerender(<AppShell port={collision} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    await user.click(screen.getByRole("tab", { name: /Untitled/ }));
    await user.click(editor());
    await user.keyboard("{Control>}s{/Control}");
    expect(collision.writes).toHaveLength(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(/已打开|冲突/);
  });

  it("saves an existing file through the reachable Save As action", async () => {
    const user = userEvent.setup();
    const port = new InspectablePort(
      [file("/notes/original.md")],
      { path: "/notes/copy.md", expectedVersion: null },
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("copy contents"));

    await user.click(screen.getByRole("button", { name: "另存为…" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /copy\.md/ })).toBeVisible());
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]).toMatchObject({
      targetPath: "/notes/copy.md",
      text: "copy contents",
      expectedVersion: null,
    });
  });

  it("leaves an existing document unchanged when Save As is cancelled", async () => {
    const user = userEvent.setup();
    const port = new InspectablePort([file("/notes/original.md")], null);
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("local edit"));

    await user.click(screen.getByRole("button", { name: "另存为…" }));

    expect(port.chosenTitles).toEqual(["original.md"]);
    expect(port.writes).toHaveLength(0);
    expect(screen.getByRole("tab", { name: /original\.md/ })).toHaveTextContent("●");
    expect(editor()).toHaveTextContent("local edit");
  });

  it("blocks Save As to another open tab and retains both documents", async () => {
    const user = userEvent.setup();
    const port = new InspectablePort(
      [file("/notes/a.md", "alpha"), file("/notes/b.md", "bravo")],
      { path: "/NOTES/b.md", expectedVersion: "version:/notes/b.md" },
    );
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    await user.click(screen.getByRole("tab", { name: /a\.md/ }));

    await user.click(screen.getByRole("button", { name: "另存为…" }));

    expect(port.writes).toHaveLength(0);
    expect(await screen.findByRole("alert")).toHaveTextContent(/冲突/);
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /a\.md/ })).toBeVisible();
    expect(screen.getByRole("tab", { name: /b\.md/ })).toBeVisible();
  });

  it("waits for a close-save, closes on success, and retains dirty text after failure", async () => {
    const user = userEvent.setup();
    const pending = deferred<SavedFile>();
    const port = new InspectablePort([file("/notes/a.md")]);
    port.writeResult = pending.promise;
    const successfulView = render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("unsaved"));
    await user.click(screen.getByRole("button", { name: "关闭 a.md" }));

    const dialog = screen.getByRole("dialog", { name: "保存更改" });
    expect(within(dialog).getByRole("button", { name: "保存" })).toHaveFocus();
    expect(screen.getByTestId("app-background")).toHaveAttribute("inert");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(screen.getByRole("dialog", { name: "保存更改" })).toBeVisible();
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "保存中…" })).toBeDisabled();
    await user.tab();
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toHaveFocus();
    pending.resolve({ path: "/notes/a.md", modifiedUnixMs: 2, version: "v2" });
    await waitFor(() => expect(screen.queryByRole("tab", { name: /a\.md/ })).not.toBeInTheDocument());
    successfulView.unmount();

    const failedWrite = deferred<SavedFile>();
    const failed = new InspectablePort([file("/notes/fail.md")]);
    failed.writeResult = failedWrite.promise;
    const { unmount } = render(<AppShell port={failed} />);
    await user.click(screen.getAllByRole("button", { name: "打开文件" }).at(-1)!);
    const failEditor = screen.getAllByRole("textbox", { name: "Markdown 编辑器" }).at(-1)!;
    act(() => replaceEditorText("do not lose me"));
    await user.click(screen.getByRole("button", { name: "关闭 fail.md" }));
    await user.click(within(screen.getByRole("dialog", { name: "保存更改" })).getByRole("button", { name: "保存" }));
    failedWrite.reject(new DocumentPortError("io", "disk full"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk full"));
    expect(screen.getByRole("dialog", { name: "保存更改" })).toBeVisible();
    expect(screen.getByRole("tab", { hidden: true, name: /fail\.md/ })).toBeInTheDocument();
    expect(failEditor).toHaveTextContent("do not lose me");
    unmount();
  });

  it("traps close-dialog focus, cancels on Escape, and restores the close-button focus", async () => {
    const user = userEvent.setup();
    render(<AppShell port={new InspectablePort([file("/notes/a.md")])} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("dirty"));
    const closeButton = screen.getByRole("button", { name: "关闭 a.md" });
    await user.click(closeButton);
    const dialog = screen.getByRole("dialog", { name: "保存更改" });
    expect(within(dialog).getByRole("button", { name: "保存" })).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(closeButton).toHaveFocus();
  });

  it("keeps an untitled close prompt open when choosing a save path is cancelled", async () => {
    const user = userEvent.setup();
    const port = new InspectablePort([], null);
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "新建" }));
    act(() => replaceEditorText("draft"));
    await user.click(screen.getByRole("button", { name: "关闭 Untitled" }));
    await user.click(within(screen.getByRole("dialog", { name: "保存更改" })).getByRole("button", { name: "保存" }));

    expect(port.chosenTitles).toEqual(["Untitled"]);
    expect(port.writes).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "保存更改" })).toBeVisible();
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });

  it("closes clean tabs to the adjacent tab and reopens once from shell focus", async () => {
    const user = userEvent.setup();
    const port = new InspectablePort([file("/a.md", "a"), file("/b.md", "b")]);
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    await user.click(screen.getByRole("button", { name: "关闭 b.md" }));
    const adjacent = screen.getByRole("tab", { name: /a\.md/ });
    expect(adjacent).toHaveAttribute("aria-selected", "true");
    expect(adjacent).toHaveFocus();

    screen.getByRole("main").focus();
    await user.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    const reopened = screen.getByRole("tab", { name: /b\.md/ });
    expect(reopened).toHaveAttribute("aria-selected", "true");
    expect(reopened).toHaveFocus();
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(2);

    await user.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(2);
  });

  it("focuses an already-open restored path and consumes the reopen focus request", async () => {
    const user = userEvent.setup();
    const port = new InspectablePort([file("/a.md", "a"), file("/b.md", "b")]);
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    await user.click(screen.getByRole("button", { name: "关闭 b.md" }));
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    const activeB = screen.getByRole("tab", { name: /b\.md/ });
    expect(activeB).toHaveAttribute("aria-selected", "true");

    screen.getByRole("main").focus();
    await user.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");

    expect(activeB).toHaveFocus();
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(2);
  });

  it("moves focus to the empty-state action after closing the final clean tab", async () => {
    const user = userEvent.setup();
    render(<AppShell port={new InspectablePort([file("/only.md")])} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    await user.click(screen.getByRole("button", { name: "关闭 only.md" }));

    expect(screen.getByRole("button", { name: "新建" })).toHaveFocus();
  });

  it("disposes an injected event bridge safely after unmount", async () => {
    const ready = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const bridge = vi.fn(async () => ({ ready, dispose }));
    const view = render(<AppShell port={new InspectablePort()} subscribeToEvents={bridge} />);
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    view.unmount();
    await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  });
});
