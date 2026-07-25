import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import type { DirectoryEntry, DocumentPort, SavedFile } from "../document/DocumentPort";
import { DocumentPortError } from "../document/DocumentPort";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { OpenedFile, PendingWriteRequest, RecoveryDraft, RecoveryDraftInfo, SaveTarget } from "../document/types";
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
  async saveClipboardImage() { return null; }
  async acquireDocumentScope() {}
  async acquireWorkspaceScope() {}
  async releaseAssetScope() {}
  async chooseWorkspace() { return null; }
  async openWorkspacePath(path: string) { return { path, title: path.split("/").at(-1) ?? path }; }
  async listDirectory() { return []; }
  async createMarkdownFile(): Promise<DirectoryEntry> { throw new DocumentPortError("io", "not supported"); }
  async renameEntry(): Promise<DirectoryEntry> { throw new DocumentPortError("io", "not supported"); }
  async trashEntry() {}
  async watchDocument() {}
  async watchWorkspace() {}
  async unwatch() {}
  async subscribeToDiskEvents() { return () => {}; }
  async listDrafts() { return []; }
  async readDraft(): Promise<RecoveryDraft> { throw new DocumentPortError("not_found", "no drafts"); }
  async writeDraft(): Promise<RecoveryDraftInfo> { throw new DocumentPortError("io", "not supported"); }
  async discardDraft() {}
  async loadSession() { return null; }
  async saveSession() {}
  async onCloseRequested() { return () => {}; }
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

  it("inserts image files dropped on the window into the active editor", async () => {
    const user = userEvent.setup();
    let dropHandler!: (drop: { paths: string[]; x: number; y: number }) => void;
    const subscribeToImageDrops = vi.fn(
      async (handler: (drop: { paths: string[]; x: number; y: number }) => void) => {
        dropHandler = handler;
        return () => {};
      },
    );
    render(
      <AppShell
        port={new InspectablePort([file("/notes/a.md", "hello")])}
        subscribeToImageDrops={subscribeToImageDrops}
      />,
    );
    await user.click(screen.getByRole("button", { name: "打开文件" }));

    act(() => dropHandler({ paths: ["/notes/pic.png"], x: 0, y: 0 }));

    const view = EditorView.findFromDOM(editor());
    expect(view?.state.doc.toString()).toContain("![image](/notes/pic.png)");
    expect(subscribeToImageDrops).toHaveBeenCalledOnce();
  });

  it("defaults to live preview and toggles source mode without rebuilding the editor", async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        port={new InspectablePort([
          file("/notes/preview.md", "**world** rest\n\n---\n\noutside"),
        ])}
      />,
    );
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    const view = EditorView.findFromDOM(editor());
    if (!view) throw new Error("EditorView not found");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const root = view.dom;
    const selection = view.state.selection;
    const toggle = screen.getByRole("button", { name: "实时预览" });

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(root.querySelector(".cm-live-preview-strong")).not.toBeNull();
    expect(root.querySelector(".cm-live-preview-horizontal-rule")).not.toBeNull();
    expect(editor()).not.toHaveTextContent("**");

    await user.click(toggle);
    const sourceToggle = screen.getByRole("button", { name: "实时预览" });
    expect(sourceToggle).toHaveAttribute("aria-pressed", "false");
    expect(sourceToggle).toHaveTextContent("源码模式");
    expect(EditorView.findFromDOM(editor())).toBe(view);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(root.querySelector(".cm-live-preview-strong")).toBeNull();
    expect(root.querySelector(".cm-live-preview-horizontal-rule")).toBeNull();
    expect(editor()).toHaveTextContent("**world**");
    expect(editor()).toHaveTextContent("---");

    await user.click(sourceToggle);
    expect(screen.getByRole("button", { name: "实时预览" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(EditorView.findFromDOM(editor())).toBe(view);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(root.querySelector(".cm-live-preview-strong")).not.toBeNull();
    expect(root.querySelector(".cm-live-preview-horizontal-rule")).not.toBeNull();
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
    await user.keyboard("{ArrowUp}");
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
    const dirtyTab = screen.getByRole("tab", { name: /a\.md.*未保存/ });
    expect(dirtyTab).toHaveTextContent("●");
    expect(within(dirtyTab).getByText(/●/)).toHaveAttribute("aria-hidden", "true");

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

  it("shows a Chinese conflict error when Save As completes at a different path", async () => {
    const user = userEvent.setup();
    const port = new InspectablePort(
      [file("/notes/original.md")],
      { path: "/notes/copy.md", expectedVersion: null },
    );
    port.writeResult = Promise.resolve({
      path: "/notes/collision.md",
      modifiedUnixMs: 2,
      version: "collision-v1",
    });
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("copy contents"));

    await user.click(screen.getByRole("button", { name: "另存为…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/保存.*路径.*冲突/);
    // The conflicted tab blocks behind its resolution dialog; keeping the
    // local version re-dirties the tab and returns to the shell.
    const conflictDialog = screen.getByRole("dialog", { name: "文件已在磁盘上更改" });
    await user.click(within(conflictDialog).getByRole("button", { name: "保留当前版本" }));
    expect(screen.getByRole("tab", { name: /original\.md.*未保存/ })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "关闭 original.md" }));
    const dialog = screen.getByRole("dialog", { name: "保存更改" });
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/保存.*路径.*冲突/);
    expect(dialog).toBeVisible();
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
    // Resolve the conflict dialog so both retained tabs are reachable again.
    const conflictDialog = screen.getByRole("dialog", { name: "文件已在磁盘上更改" });
    await user.click(within(conflictDialog).getByRole("button", { name: "保留当前版本" }));
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

  it("under StrictMode handshakes only the active deferred subscription and delivers its payload once", async () => {
    type SubscriberCall = {
      onFiles: (files: ReadonlyArray<OpenedFile>) => void;
      signal: AbortSignal | undefined;
      resolve: (subscription: { ready(): Promise<void>; dispose(): Promise<void> }) => void;
    };
    const calls: SubscriberCall[] = [];
    const bridge = vi.fn((_port, onFiles, _onDirectory, _onError, signal) =>
      new Promise<{ ready(): Promise<void>; dispose(): Promise<void> }>((resolve) => {
        calls.push({ onFiles, signal, resolve });
      }),
    );
    render(
      <StrictMode>
        <AppShell port={new InspectablePort()} subscribeToEvents={bridge} />
      </StrictMode>,
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].signal?.aborted).toBe(false);
    const first = { ready: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const second = { ready: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };

    calls[0].resolve(first);
    calls[1].resolve(second);
    await waitFor(() => expect(second.ready).toHaveBeenCalledOnce());
    expect(first.ready).not.toHaveBeenCalled();
    expect(first.dispose).toHaveBeenCalledOnce();

    act(() => calls[1].onFiles([file("/notes/launch.md", "startup payload")]));
    expect(screen.getAllByRole("tab", { name: /launch\.md/ })).toHaveLength(1);
    expect(editor()).toHaveTextContent("startup payload");
  });
});

describe("AppShell workspace drawer", () => {
  const workspacePort = () =>
    new MemoryDocumentPort(
      new Map([["/notes/alpha.md", file("/notes/alpha.md")]]),
      { workspace: { path: "/notes", title: "notes" } },
    );

  it("stays hidden in the empty state and opens after 打开文件夹", async () => {
    const user = userEvent.setup();
    render(<AppShell port={workspacePort()} />);

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开文件夹" }));

    const sidebar = await screen.findByRole("complementary", { name: "侧栏" });
    expect(within(sidebar).getByText("notes")).toBeInTheDocument();
    expect(
      await within(sidebar).findByRole("treeitem", { name: "alpha.md" }),
    ).toBeInTheDocument();
  });

  it("shows the sidebar for open tabs without a workspace, with no 文件夹 section", async () => {
    const user = userEvent.setup();
    render(
      <AppShell
        port={new MemoryDocumentPort(new Map([["/notes/a.md", file("/notes/a.md")]]))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "打开文件" }));

    const sidebar = await screen.findByRole("complementary", { name: "侧栏" });
    expect(
      within(sidebar).getByRole("button", { name: "打开的标签" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(within(sidebar).getByRole("tab", { name: /a\.md/ })).toBeVisible();
    expect(
      within(sidebar).queryByRole("button", { name: "文件夹" }),
    ).not.toBeInTheDocument();
  });

  it("opens a clicked tree file in a tab", async () => {
    const user = userEvent.setup();
    render(<AppShell port={workspacePort()} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    const sidebar = await screen.findByRole("complementary", { name: "侧栏" });

    await user.click(
      await within(sidebar).findByRole("treeitem", { name: "alpha.md" }),
    );

    expect(screen.getAllByRole("tab", { name: /alpha\.md/ })).toHaveLength(1);
    expect(editor()).toHaveTextContent("saved");
  });

  it("collapses the 打开的标签 and 文件夹 sections independently", async () => {
    const user = userEvent.setup();
    render(<AppShell port={workspacePort()} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    const sidebar = await screen.findByRole("complementary", { name: "侧栏" });
    await user.click(
      await within(sidebar).findByRole("treeitem", { name: "alpha.md" }),
    );
    await within(sidebar).findByRole("tab", { name: /alpha\.md/ });

    await user.click(within(sidebar).getByRole("button", { name: "打开的标签" }));
    expect(within(sidebar).queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("tree", { name: "工作区文件" })).toBeVisible();

    await user.click(within(sidebar).getByRole("button", { name: "打开的标签" }));
    expect(within(sidebar).getByRole("tab", { name: /alpha\.md/ })).toBeVisible();

    await user.click(within(sidebar).getByRole("button", { name: "文件夹" }));
    expect(within(sidebar).queryByRole("tree")).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("tab", { name: /alpha\.md/ })).toBeVisible();
  });

  it("remains manually collapsible and expandable", async () => {
    const user = userEvent.setup();
    render(<AppShell port={workspacePort()} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    await screen.findByRole("complementary", { name: "侧栏" });

    await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(
      await screen.findByRole("complementary", { name: "侧栏" }),
    ).toBeInTheDocument();
  });

  it("closes the workspace from the sidebar and hides the drawer", async () => {
    const user = userEvent.setup();
    render(<AppShell port={workspacePort()} />);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    const sidebar = await screen.findByRole("complementary", { name: "侧栏" });

    await user.click(
      within(sidebar).getByRole("button", { name: "关闭文件夹" }),
    );

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开侧栏" })).not.toBeInTheDocument();
  });

  it("persists collapse preferences and restores them from the session", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md")]]),
      {
        workspace: { path: "/notes", title: "notes" },
        session: {
          recent: [],
          openPaths: ["/notes/a.md"],
          activePath: "/notes/a.md",
          workspacePath: null,
          sidebar: {
            collapsed: true,
            tabsSectionCollapsed: true,
            filesSectionCollapsed: false,
          },
        },
      },
    );
    render(<AppShell port={port} />);

    // Restored: tabs are back, the whole sidebar starts collapsed.
    await screen.findByRole("button", { name: "展开侧栏" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    // Expanding reveals the restored tabs-section collapse, then every
    // interaction is written back into the persisted session.
    await user.click(screen.getByRole("button", { name: "展开侧栏" }));
    const sidebar = await screen.findByRole("complementary", { name: "侧栏" });
    expect(within(sidebar).queryByRole("tablist")).not.toBeInTheDocument();

    await user.click(within(sidebar).getByRole("button", { name: "打开的标签" }));
    expect(within(sidebar).getByRole("tab", { name: /a\.md/ })).toBeVisible();
    await waitFor(() =>
      expect(port.session?.sidebar).toEqual({
        collapsed: false,
        tabsSectionCollapsed: false,
        filesSectionCollapsed: false,
      }),
    );

    await user.click(within(sidebar).getByRole("button", { name: "收起侧栏" }));
    await waitFor(() =>
      expect(port.session?.sidebar?.collapsed).toBe(true),
    );
  });
});

describe("AppShell recent items and recovery", () => {
  const recentPort = () =>
    new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md", "alpha")]]),
      {
        workspace: { path: "/notes", title: "notes" },
        session: {
          recent: [
            { path: "/notes/a.md", kind: "file" },
            { path: "/notes", kind: "folder" },
            { path: "/notes/gone.md", kind: "file" },
          ],
          openPaths: [],
          activePath: null,
          workspacePath: null,
        },
      },
    );

  it("renders persisted recent items in the empty state and opens them through the port", async () => {
    const user = userEvent.setup();
    render(<AppShell port={recentPort()} />);

    const recent = await screen.findByRole("region", { name: "最近打开" });
    expect(within(recent).getByRole("button", { name: "文件 /notes/a.md" })).toBeVisible();
    expect(within(recent).getByRole("button", { name: "文件夹 /notes" })).toBeVisible();

    await user.click(within(recent).getByRole("button", { name: "文件夹 /notes" }));
    expect(await screen.findByRole("complementary", { name: "侧栏" })).toBeVisible();

    await user.click(
      within(await screen.findByRole("region", { name: "最近打开" })).getByRole("button", {
        name: "文件 /notes/a.md",
      }),
    );
    expect(await screen.findByRole("tab", { name: /a\.md/ })).toBeVisible();
    expect(editor()).toHaveTextContent("alpha");
    expect(screen.queryByRole("region", { name: "最近打开" })).not.toBeInTheDocument();
  });

  it("removes a recent entry only after a confirmed not_found, with a non-blocking message", async () => {
    const user = userEvent.setup();
    render(<AppShell port={recentPort()} />);
    const recent = await screen.findByRole("region", { name: "最近打开" });

    await user.click(within(recent).getByRole("button", { name: "文件 /notes/gone.md" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("/notes/gone.md");
    expect(
      screen.queryByRole("button", { name: "文件 /notes/gone.md" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文件 /notes/a.md" })).toBeVisible();
    expect(screen.getByRole("button", { name: "文件夹 /notes" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("restores a leftover draft through the recovery dialog as a dirty tab", async () => {
    const user = userEvent.setup();
    const leftover: RecoveryDraft = {
      draftId: "draft-document-9",
      originalPath: "/notes/a.md",
      title: "a.md",
      text: "unsaved recovery",
      hasUtf8Bom: false,
      newline: "lf",
      savedTextHash: "hash",
      savedVersion: "v1",
    };
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md", "alpha")]]),
      { drafts: [leftover] },
    );
    render(<AppShell port={port} />);

    const dialog = await screen.findByRole("dialog", { name: "恢复未保存的更改" });
    expect(screen.getByTestId("app-background")).toHaveAttribute("inert");

    await user.click(within(dialog).getByRole("button", { name: "查看源码" }));
    expect(await within(dialog).findByText("unsaved recovery")).toBeVisible();
    expect(port.drafts).toHaveLength(1);

    await user.click(within(dialog).getByRole("button", { name: "丢弃" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(port.drafts).toHaveLength(0);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("restores the draft text into a dirty tab and discards the stored draft", async () => {
    const user = userEvent.setup();
    const leftover: RecoveryDraft = {
      draftId: "draft-document-9",
      originalPath: "/notes/a.md",
      title: "a.md",
      text: "unsaved recovery",
      hasUtf8Bom: false,
      newline: "lf",
      savedTextHash: "hash",
      savedVersion: "version:/notes/a.md",
    };
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", file("/notes/a.md", "alpha")]]),
      { drafts: [leftover] },
    );
    render(<AppShell port={port} />);

    const dialog = await screen.findByRole("dialog", { name: "恢复未保存的更改" });
    await user.click(within(dialog).getByRole("button", { name: "恢复" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /a\.md.*未保存/ })).toBeVisible();
    expect(editor()).toHaveTextContent("unsaved recovery");
    expect(port.drafts).toHaveLength(0);
  });
});

describe("AppShell conflict and save-failure dialogs", () => {
  it("surfaces a conflict dialog on external change and keeps local text on 保留当前版本", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", file("/notes/a.md", "saved")]]));
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("local edits"));

    act(() => port.updateFile("/notes/a.md", "disk edit", "v2", 9));
    act(() =>
      port.emitDiskEvent({ kind: "changed", path: "/notes/a.md", modifiedUnixMs: 9, version: "v2" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "文件已在磁盘上更改" });
    expect(screen.getByTestId("app-background")).toHaveAttribute("inert");
    expect(within(dialog).getByRole("button", { name: "保留当前版本" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "保留当前版本" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editor()).toHaveTextContent("local edits");
    expect(screen.getByRole("tab", { name: /a\.md.*未保存/ })).toBeVisible();
  });

  it("reloads the disk version through the conflict dialog", async () => {
    const user = userEvent.setup();
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", file("/notes/a.md", "saved")]]));
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("local edits"));
    act(() => port.updateFile("/notes/a.md", "disk edit", "v2", 9));
    act(() =>
      port.emitDiskEvent({ kind: "changed", path: "/notes/a.md", modifiedUnixMs: 9, version: "v2" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "文件已在磁盘上更改" });
    await user.click(within(dialog).getByRole("button", { name: "载入磁盘版本" }));

    await waitFor(() => expect(editor()).toHaveTextContent("disk edit"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /a\.md/ })).not.toHaveTextContent("●");
  });

  it("offers retry and save-as after a failed save while keeping the dirty tab", async () => {
    const user = userEvent.setup();
    const first = deferred<SavedFile>();
    const port = new InspectablePort([file("/notes/a.md")]);
    port.writeResult = first.promise;
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("do not lose me"));
    editor().focus();
    await user.keyboard("{Control>}s{/Control}");
    expect(port.writes).toHaveLength(1);

    act(() => first.reject(new DocumentPortError("io", "disk full")));
    const dialog = await screen.findByRole("dialog", { name: "保存失败" });
    expect(dialog).toHaveTextContent("disk full");
    expect(within(dialog).getByRole("button", { name: "重试" })).toHaveFocus();
    expect(screen.getByTestId("app-background")).toHaveAttribute("inert");
    expect(screen.getByRole("tab", { hidden: true, name: /a\.md.*未保存/ })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { hidden: true, name: "Markdown 编辑器" }),
    ).toHaveTextContent("do not lose me");

    const second = deferred<SavedFile>();
    port.writeResult = second.promise;
    await user.click(within(dialog).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(port.writes).toHaveLength(2));
    expect(port.writes[1].text).toBe("do not lose me");

    act(() => second.reject(new DocumentPortError("io", "disk full again")));
    const retried = await screen.findByRole("dialog", { name: "保存失败" });
    expect(retried).toHaveTextContent("disk full again");

    // Save-as cancelled in the picker returns to the still-dirty tab.
    await user.click(within(retried).getByRole("button", { name: "另存为…" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "保存失败" })).not.toBeInTheDocument(),
    );
    expect(port.chosenTitles).toEqual(["a.md"]);
    expect(screen.getByRole("tab", { name: /a\.md.*未保存/ })).toBeVisible();
    expect(editor()).toHaveTextContent("do not lose me");
  });

  it("dismisses the save-failure dialog without touching the dirty tab", async () => {
    const user = userEvent.setup();
    const pending = deferred<SavedFile>();
    const port = new InspectablePort([file("/notes/a.md")]);
    port.writeResult = pending.promise;
    render(<AppShell port={port} />);
    await user.click(screen.getByRole("button", { name: "打开文件" }));
    act(() => replaceEditorText("unsaved"));
    editor().focus();
    await user.keyboard("{Control>}s{/Control}");
    act(() => pending.reject(new DocumentPortError("permission_denied", "read only")));
    await screen.findByRole("dialog", { name: "保存失败" });

    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /a\.md.*未保存/ })).toBeVisible();
    expect(editor()).toHaveTextContent("unsaved");
  });

  describe("large document light mode", () => {
    // Past the line threshold, so the tab opens in light mode. The rich
    // content sits on line 2: inside the initial viewport (jsdom has no
    // layout, so far-down lines never render) and untouched by the cursor,
    // which starts at 0 on line 1.
    const largeText = `intro\n$x$ and **bold**\n${"text\n".repeat(49_999)}tail`;
    const openLargeDocument = async (user: ReturnType<typeof userEvent.setup>) => {
      render(
        <AppShell port={new InspectablePort([file("/notes/big.md", largeText)])} />,
      );
      await user.click(screen.getByRole("button", { name: "打开文件" }));
      await screen.findByRole("tab", { name: /big\.md/ });
    };

    it("shows a banner and 继续完整渲染 restores full rendering for the tab", async () => {
      const user = userEvent.setup();
      await openLargeDocument(user);
      const banner = await screen.findByRole("status");
      expect(banner).toHaveTextContent("轻量模式");
      expect(document.querySelector(".md-math")).toBeNull();
      expect(document.querySelector(".cm-live-preview-strong")).not.toBeNull();

      await user.click(within(banner).getByRole("button", { name: "继续完整渲染" }));

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(document.querySelector(".md-math")).not.toBeNull();
      expect(editor()).toHaveTextContent("text");
    });

    it("dismisses the banner without leaving light mode", async () => {
      const user = userEvent.setup();
      await openLargeDocument(user);
      const banner = await screen.findByRole("status");

      await user.click(within(banner).getByRole("button", { name: "关闭轻量模式提示" }));

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(document.querySelector(".md-math")).toBeNull();
    });

    it("returns to automatic light mode when the tab is closed and reopened", async () => {
      const user = userEvent.setup();
      await openLargeDocument(user);
      await user.click(
        within(await screen.findByRole("status")).getByRole("button", { name: "继续完整渲染" }),
      );
      expect(document.querySelector(".md-math")).not.toBeNull();

      await user.click(screen.getByRole("button", { name: "关闭 big.md" }));
      screen.getByRole("main").focus();
      await user.keyboard("{Control>}{Shift>}t{/Shift}{/Control}");

      await screen.findByRole("tab", { name: /big\.md/ });
      expect(await screen.findByRole("status")).toHaveTextContent("轻量模式");
      expect(document.querySelector(".md-math")).toBeNull();
    });

    it("keeps regular documents in full mode without a banner", async () => {
      const user = userEvent.setup();
      render(
        <AppShell port={new InspectablePort([file("/notes/small.md", "plain intro\n\n$x$ and **bold**")])} />,
      );
      await user.click(screen.getByRole("button", { name: "打开文件" }));
      await screen.findByRole("tab", { name: /small\.md/ });

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(document.querySelector(".md-math")).not.toBeNull();
    });
  });
});
