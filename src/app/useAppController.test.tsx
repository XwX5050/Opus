import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DirectoryEntry, DocumentPort, SavedFile } from "../document/DocumentPort";
import { DocumentPortError } from "../document/DocumentPort";
import { MemoryDocumentPort } from "../document/memoryDocumentPort";
import type { DiskEvent, OpenedFile, PendingWriteRequest, RecoveryDraft, RecoveryDraftInfo, SaveTarget } from "../document/types";
import { useAppController } from "./useAppController";

const file: OpenedFile = {
  path: "/notes/exact.md",
  text: "base",
  hasUtf8Bom: true,
  newline: "cr_lf",
  modifiedUnixMs: 1,
  version: "v1",
};

class InspectableControllerPort implements DocumentPort {
  request: PendingWriteRequest | undefined;
  readonly requests: PendingWriteRequest[] = [];

  constructor(
    private readonly file: OpenedFile,
    private readonly writeResult: Promise<SavedFile>,
    private readonly saveTarget: SaveTarget | null = null,
  ) {}

  async chooseAndOpenFiles() { return [this.file]; }
  async openPath() { return this.file; }
  async chooseSavePath() { return this.saveTarget; }
  write(request: PendingWriteRequest) {
    this.request = request;
    this.requests.push(request);
    return this.writeResult;
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
  async subscribeToDiskEvents(_handler: (event: DiskEvent) => void) { return () => {}; }
  async listDrafts() { return []; }
  async readDraft(): Promise<RecoveryDraft> { throw new DocumentPortError("not_found", "no drafts"); }
  async writeDraft(): Promise<RecoveryDraftInfo> { throw new DocumentPortError("io", "not supported"); }
  async discardDraft() {}
  async loadSession() { return null; }
  async saveSession() {}
  async onCloseRequested() { return () => {}; }
}

type ScopeCall =
  | { kind: "acquire"; consumerId: string; path: string }
  | { kind: "release"; consumerId: string };

class ScopeAwareControllerPort implements DocumentPort {
  readonly scopeCalls: ScopeCall[] = [];
  acquireGate: ((consumerId: string) => Promise<void>) | null = null;

  constructor(private readonly files: OpenedFile[]) {}

  async chooseAndOpenFiles() { return [...this.files]; }
  async openPath(path: string) {
    const opened = this.files.find((candidate) => candidate.path === path);
    if (!opened) throw new DocumentPortError("not_found", path);
    return opened;
  }
  async chooseSavePath() { return null; }
  async write(): Promise<SavedFile> { throw new DocumentPortError("io", "not writable"); }
  async saveClipboardImage() { return null; }
  async acquireDocumentScope(consumerId: string, path: string) {
    if (this.acquireGate) await this.acquireGate(consumerId);
    this.scopeCalls.push({ kind: "acquire", consumerId, path });
  }
  async acquireWorkspaceScope(consumerId: string, root: string) {
    if (this.acquireGate) await this.acquireGate(consumerId);
    this.scopeCalls.push({ kind: "acquire", consumerId, path: root });
  }
  async releaseAssetScope(consumerId: string) {
    this.scopeCalls.push({ kind: "release", consumerId });
  }
  workspaceRoot: { path: string; title: string } | null = null;
  async chooseWorkspace() { return this.workspaceRoot; }
  async openWorkspacePath(path: string) { return { path, title: path.split("/").at(-1) ?? path }; }
  async listDirectory() { return []; }
  async createMarkdownFile(): Promise<DirectoryEntry> { throw new DocumentPortError("io", "not supported"); }
  async renameEntry(): Promise<DirectoryEntry> { throw new DocumentPortError("io", "not supported"); }
  async trashEntry() {}
  async watchDocument() {}
  async watchWorkspace() {}
  async unwatch() {}
  async subscribeToDiskEvents(_handler: (event: DiskEvent) => void) { return () => {}; }
  async listDrafts() { return []; }
  async readDraft(): Promise<RecoveryDraft> { throw new DocumentPortError("not_found", "no drafts"); }
  async writeDraft(): Promise<RecoveryDraftInfo> { throw new DocumentPortError("io", "not supported"); }
  async discardDraft() {}
  async loadSession() { return null; }
  async saveSession() {}
  async onCloseRequested() { return () => {}; }
}

const scopedFile = (path: string): OpenedFile => ({
  path,
  text: "text",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: `version:${path}`,
});

describe("useAppController", () => {
  it("passes the exact frozen reducer request to write and keeps later edits dirty", async () => {
    let resolveWrite!: (value: SavedFile) => void;
    const write = new Promise<SavedFile>((resolve) => { resolveWrite = resolve; });
    const port = new InspectableControllerPort(file, write);
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openFiles());
    const id = hook.result.current.state.activeId!;
    act(() => hook.result.current.changeText(id, "snapshot A"));
    let saving!: Promise<boolean>;
    act(() => { saving = hook.result.current.save(id); });

    await waitFor(() => expect(port.request).toBeDefined());
    const pending = hook.result.current.state.tabs[0].pendingSave;
    expect(port.request).toBe(pending);
    expect(Object.isFrozen(port.request)).toBe(true);
    expect(port.request?.text).toBe("snapshot A");

    act(() => hook.result.current.changeText(id, "snapshot B"));
    resolveWrite({ path: file.path, modifiedUnixMs: 2, version: "v2" });
    await act(() => saving);
    expect(hook.result.current.state.tabs[0]).toMatchObject({
      text: "snapshot B",
      savedText: "snapshot A",
      status: "dirty",
    });
  });

  it("supports Save As for an existing document through a reducer-owned target", async () => {
    const port = new InspectableControllerPort(
      file,
      Promise.resolve({ path: "/notes/copy.md", modifiedUnixMs: 2, version: "copy-v1" }),
      { path: "/notes/copy.md", expectedVersion: null },
    );
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openFiles());
    const id = hook.result.current.state.activeId!;
    act(() => hook.result.current.changeText(id, "copy text"));

    await act(() => hook.result.current.saveAs(id));

    expect(port.request).toMatchObject({
      documentId: id,
      targetPath: "/notes/copy.md",
      text: "copy text",
      expectedVersion: null,
    });
    expect(hook.result.current.state.tabs[0]).toMatchObject({
      path: "/notes/copy.md",
      savedText: "copy text",
      status: "clean",
    });
  });

  it("atomically rejects every second close choice while the first save is pending", async () => {
    let resolveWrite!: (value: SavedFile) => void;
    const write = new Promise<SavedFile>((resolve) => { resolveWrite = resolve; });
    const port = new InspectableControllerPort(file, write);
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openFiles());
    const id = hook.result.current.state.activeId!;
    act(() => hook.result.current.changeText(id, "dirty"));
    act(() => hook.result.current.close(id));

    let first!: Promise<void>;
    let second!: Promise<void>;
    let discard!: Promise<void>;
    let cancel!: Promise<void>;
    act(() => {
      first = hook.result.current.confirmClose("save");
      second = hook.result.current.confirmClose("save");
      discard = hook.result.current.confirmClose("discard");
      cancel = hook.result.current.confirmClose("cancel");
    });

    await waitFor(() => expect(port.requests).toHaveLength(1));
    expect(hook.result.current.closeSaving).toBe(true);
    expect(hook.result.current.closeDocumentId).toBe(id);
    expect(hook.result.current.state.tabs).toHaveLength(1);

    resolveWrite({ path: file.path, modifiedUnixMs: 2, version: "v2" });
    await act(() => Promise.all([first, second, discard, cancel]));
    expect(port.requests).toHaveLength(1);
    expect(hook.result.current.state.tabs).toHaveLength(0);
    expect(hook.result.current.state.recentlyClosed).toHaveLength(1);
    expect(hook.result.current.closeDocumentId).toBeNull();
    expect(hook.result.current.closeSaving).toBe(false);
  });

  it("settles a deferred open without updating after unmount", async () => {
    let resolveOpen!: (value: ReadonlyArray<OpenedFile>) => void;
    const opening = new Promise<ReadonlyArray<OpenedFile>>((resolve) => { resolveOpen = resolve; });
    const port: DocumentPort = {
      chooseAndOpenFiles: () => opening,
      async openPath() { return file; },
      async chooseSavePath() { return null; },
      async write(request) {
        return { path: request.targetPath, modifiedUnixMs: 2, version: "v2" };
      },
      async saveClipboardImage() { return null; },
      async acquireDocumentScope() {},
      async acquireWorkspaceScope() {},
      async releaseAssetScope() {},
      async chooseWorkspace() { return null; },
      async openWorkspacePath(path: string) { return { path, title: path.split("/").at(-1) ?? path }; },
      async listDirectory() { return []; },
      async createMarkdownFile(): Promise<DirectoryEntry> { throw new DocumentPortError("io", "not supported"); },
      async renameEntry(): Promise<DirectoryEntry> { throw new DocumentPortError("io", "not supported"); },
      async trashEntry() {},
      async watchDocument() {},
      async watchWorkspace() {},
      async unwatch() {},
      async subscribeToDiskEvents() { return () => {}; },
      async listDrafts() { return []; },
      async readDraft() { throw new DocumentPortError("not_found", "no drafts"); },
      async writeDraft() { throw new DocumentPortError("io", "not supported"); },
      async discardDraft() {},
      async loadSession() { return null; },
      async saveSession() {},
      async onCloseRequested() { return () => {}; },
    };
    const hook = renderHook(() => useAppController(port));
    const openingAction = hook.result.current.openFiles();
    const stateBeforeUnmount = hook.result.current.state;
    hook.unmount();

    resolveOpen([file]);
    await openingAction;
    expect(hook.result.current.state).toBe(stateBeforeUnmount);
  });

  it("settles a deferred save without applying completion after unmount", async () => {
    let resolveWrite!: (value: SavedFile) => void;
    const writing = new Promise<SavedFile>((resolve) => { resolveWrite = resolve; });
    const port = new InspectableControllerPort(file, writing);
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openFiles());
    const id = hook.result.current.state.activeId!;
    act(() => hook.result.current.changeText(id, "dirty"));
    let saving!: Promise<boolean>;
    act(() => { saving = hook.result.current.save(id); });
    await waitFor(() => expect(hook.result.current.state.tabs[0].pendingSave).toBeDefined());
    const stateBeforeUnmount = hook.result.current.state;
    hook.unmount();

    resolveWrite({ path: file.path, modifiedUnixMs: 2, version: "v2" });
    await saving;
    expect(hook.result.current.state).toBe(stateBeforeUnmount);
    expect(stateBeforeUnmount.tabs[0].pendingSave).toBeDefined();
  });
});

describe("useAppController asset scopes", () => {
  it("acquires once per genuinely new tab, releases on close, and keeps a same-parent sibling held", async () => {
    const port = new ScopeAwareControllerPort([
      scopedFile("/notes/a.md"),
      scopedFile("/notes/b.md"),
    ]);
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openFiles());
    const [tabA, tabB] = hook.result.current.state.tabs;
    expect(port.scopeCalls).toEqual([
      { kind: "acquire", consumerId: tabA.id, path: "/notes/a.md" },
      { kind: "acquire", consumerId: tabB.id, path: "/notes/b.md" },
    ]);

    act(() => hook.result.current.close(tabA.id));

    // Closing tab A releases only its own consumer ID; tab B, which shares
    // the same parent directory, keeps its access.
    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "acquire", consumerId: tabA.id, path: "/notes/a.md" },
        { kind: "acquire", consumerId: tabB.id, path: "/notes/b.md" },
        { kind: "release", consumerId: tabA.id },
      ]),
    );

    hook.unmount();
    await waitFor(() =>
      expect(
        port.scopeCalls
          .filter((call) => call.kind === "release")
          .map((call) => call.consumerId)
          .sort(),
      ).toEqual([tabA.id, tabB.id].sort()),
    );
  });

  it("does not acquire again when opening a duplicate path only focuses the tab", async () => {
    const port = new ScopeAwareControllerPort([scopedFile("/notes/a.md")]);
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openFiles());
    await act(() => hook.result.current.openPath("/notes/a.md"));

    expect(hook.result.current.state.tabs).toHaveLength(1);
    expect(port.scopeCalls.filter((call) => call.kind === "acquire")).toHaveLength(1);
    hook.unmount();
  });

  it("re-acquires when a closed tab is reopened, serialized behind the release", async () => {
    const port = new ScopeAwareControllerPort([scopedFile("/notes/a.md")]);
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openFiles());
    const tab = hook.result.current.state.tabs[0];
    act(() => hook.result.current.close(tab.id));
    act(() => hook.result.current.reopenClosed());

    // The re-acquire reuses the same tab ID, so the backend must observe
    // acquire → release → acquire in order to keep the refcount balanced.
    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "acquire", consumerId: tab.id, path: "/notes/a.md" },
        { kind: "release", consumerId: tab.id },
        { kind: "acquire", consumerId: tab.id, path: "/notes/a.md" },
      ]),
    );
    hook.unmount();
  });

  it("never acquires a scope for an unsaved document", async () => {
    const port = new ScopeAwareControllerPort([]);
    const hook = renderHook(() => useAppController(port));

    act(() => hook.result.current.newDocument());

    expect(hook.result.current.state.tabs).toHaveLength(1);
    expect(port.scopeCalls).toEqual([]);
    hook.unmount();
  });

  it("serializes release behind a still-pending acquire so the backend sees acquire-then-release", async () => {
    let resolveAcquire!: () => void;
    const port = new ScopeAwareControllerPort([scopedFile("/notes/a.md")]);
    port.acquireGate = () => new Promise<void>((resolve) => { resolveAcquire = resolve; });
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openFiles());
    const tab = hook.result.current.state.tabs[0];

    // Close while the acquire is still in flight: neither call has reached
    // the backend yet, and the release must wait for the acquire.
    act(() => hook.result.current.close(tab.id));
    expect(port.scopeCalls).toEqual([]);

    resolveAcquire();
    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "acquire", consumerId: tab.id, path: "/notes/a.md" },
        { kind: "release", consumerId: tab.id },
      ]),
    );
    hook.unmount();
  });
});

describe("useAppController workspace scopes", () => {
  it("acquires under a stable workspace consumer id on genuine open and releases on close", async () => {
    const port = new ScopeAwareControllerPort([]);
    port.workspaceRoot = { path: "/notes", title: "notes" };
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openWorkspace());

    expect(hook.result.current.workspace).toEqual({ path: "/notes", title: "notes" });
    expect(port.scopeCalls).toEqual([
      { kind: "acquire", consumerId: "workspace:/notes", path: "/notes" },
    ]);

    act(() => hook.result.current.closeWorkspace());

    expect(hook.result.current.workspace).toBeNull();
    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "acquire", consumerId: "workspace:/notes", path: "/notes" },
        { kind: "release", consumerId: "workspace:/notes" },
      ]),
    );
    hook.unmount();
  });

  it("does nothing when the folder picker is cancelled", async () => {
    const port = new ScopeAwareControllerPort([]);
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openWorkspace());

    expect(hook.result.current.workspace).toBeNull();
    expect(port.scopeCalls).toEqual([]);
    hook.unmount();
  });

  it("replaces the workspace by releasing the old scope and acquiring the new one", async () => {
    const port = new ScopeAwareControllerPort([]);
    port.workspaceRoot = { path: "/notes", title: "notes" };
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openWorkspace());

    await act(() => hook.result.current.openWorkspacePath("/other"));

    expect(hook.result.current.workspace).toEqual({ path: "/other", title: "other" });
    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "acquire", consumerId: "workspace:/notes", path: "/notes" },
        { kind: "release", consumerId: "workspace:/notes" },
        { kind: "acquire", consumerId: "workspace:/other", path: "/other" },
      ]),
    );
    hook.unmount();
  });

  it("does not re-acquire when the already-open workspace path is opened again", async () => {
    const port = new ScopeAwareControllerPort([]);
    port.workspaceRoot = { path: "/notes", title: "notes" };
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openWorkspace());

    await act(() => hook.result.current.openWorkspacePath("/notes"));

    expect(port.scopeCalls.filter((call) => call.kind === "acquire")).toHaveLength(1);
    hook.unmount();
  });

  it("re-acquires a closed-then-reopened workspace serialized behind the release", async () => {
    const port = new ScopeAwareControllerPort([]);
    port.workspaceRoot = { path: "/notes", title: "notes" };
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openWorkspace());

    act(() => hook.result.current.closeWorkspace());
    await act(() => hook.result.current.openWorkspace());

    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "acquire", consumerId: "workspace:/notes", path: "/notes" },
        { kind: "release", consumerId: "workspace:/notes" },
        { kind: "acquire", consumerId: "workspace:/notes", path: "/notes" },
      ]),
    );
    hook.unmount();
  });

  it("releases the workspace scope on unmount", async () => {
    const port = new ScopeAwareControllerPort([]);
    port.workspaceRoot = { path: "/notes", title: "notes" };
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openWorkspace());

    hook.unmount();

    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "acquire", consumerId: "workspace:/notes", path: "/notes" },
        { kind: "release", consumerId: "workspace:/notes" },
      ]),
    );
  });
});

describe("useAppController disk watching", () => {
  const memoryFile = (path: string, text = "saved"): OpenedFile => ({
    path,
    text,
    hasUtf8Bom: false,
    newline: "lf",
    modifiedUnixMs: 1,
    version: `version:${path}`,
  });

  it("watches a genuinely new tab and unwatches it on close", async () => {
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", memoryFile("/notes/a.md")]]));
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openPath("/notes/a.md"));
    const tab = hook.result.current.state.tabs[0];
    await waitFor(() =>
      expect(port.watchCalls).toEqual([
        { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
      ]),
    );

    act(() => hook.result.current.close(tab.id));
    await waitFor(() =>
      expect(port.watchCalls).toEqual([
        { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
        { kind: "unwatch", consumerId: tab.id },
      ]),
    );
    hook.unmount();
  });

  it("watches the workspace under its scope consumer id", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      workspace: { path: "/notes", title: "notes" },
    });
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openWorkspace());
    await waitFor(() =>
      expect(port.watchCalls).toEqual([
        { kind: "workspace", consumerId: "workspace:/notes", root: "/notes" },
      ]),
    );

    act(() => hook.result.current.closeWorkspace());
    await waitFor(() =>
      expect(port.watchCalls).toEqual([
        { kind: "workspace", consumerId: "workspace:/notes", root: "/notes" },
        { kind: "unwatch", consumerId: "workspace:/notes" },
      ]),
    );
    hook.unmount();
  });

  it("reloads a clean tab when the file changes on disk", async () => {
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", memoryFile("/notes/a.md")]]));
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const id = hook.result.current.state.tabs[0].id;

    act(() => port.updateFile("/notes/a.md", "external edit", "v2", 42));
    act(() =>
      port.emitDiskEvent({ kind: "changed", path: "/notes/a.md", modifiedUnixMs: 42, version: "v2" }),
    );

    await waitFor(() =>
      expect(hook.result.current.state.tabs[0]).toMatchObject({
        text: "external edit",
        savedText: "external edit",
        version: "v2",
        status: "clean",
      }),
    );
    hook.unmount();
  });

  it("marks a dirty tab conflicted without overwriting local text", async () => {
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", memoryFile("/notes/a.md")]]));
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const id = hook.result.current.state.tabs[0].id;
    act(() => hook.result.current.changeText(id, "local edits"));

    act(() => port.updateFile("/notes/a.md", "external edit", "v2", 42));
    act(() =>
      port.emitDiskEvent({ kind: "changed", path: "/notes/a.md", modifiedUnixMs: 42, version: "v2" }),
    );

    await waitFor(() =>
      expect(hook.result.current.state.tabs[0]).toMatchObject({
        text: "local edits",
        savedText: "saved",
        version: "v2",
        status: "conflict",
      }),
    );
    hook.unmount();
  });

  it("ignores a changed event whose version matches the tab's last saved version", async () => {
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", memoryFile("/notes/a.md")]]));
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));

    act(() => port.updateFile("/notes/a.md", "echo content", "version:/notes/a.md", 7));
    act(() =>
      port.emitDiskEvent({
        kind: "changed",
        path: "/notes/a.md",
        modifiedUnixMs: 7,
        version: "version:/notes/a.md",
      }),
    );
    await act(async () => {});

    expect(hook.result.current.state.tabs[0]).toMatchObject({
      text: "saved",
      status: "clean",
    });
    hook.unmount();
  });

  it("keeps the buffer and marks the tab missing when the file vanishes", async () => {
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", memoryFile("/notes/a.md")]]));
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const id = hook.result.current.state.tabs[0].id;
    act(() => hook.result.current.changeText(id, "local edits"));

    act(() => port.removeFile("/notes/a.md"));
    act(() => port.emitDiskEvent({ kind: "missing", path: "/notes/a.md" }));

    await waitFor(() =>
      expect(hook.result.current.state.tabs[0]).toMatchObject({
        text: "local edits",
        status: "missing",
      }),
    );
    hook.unmount();
  });

  it("follows a moved clean tab and re-watches the new path", async () => {
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", memoryFile("/notes/a.md")]]));
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const tab = hook.result.current.state.tabs[0];
    await waitFor(() => expect(port.watchCalls).toHaveLength(1));

    act(() =>
      port.emitDiskEvent({ kind: "moved", from: "/notes/a.md", to: "/notes/renamed.md" }),
    );

    await waitFor(() =>
      expect(hook.result.current.state.tabs[0]).toMatchObject({
        path: "/notes/renamed.md",
        title: "renamed.md",
        status: "clean",
      }),
    );
    await waitFor(() =>
      expect(port.watchCalls).toEqual([
        { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
        { kind: "unwatch", consumerId: tab.id },
        { kind: "document", consumerId: tab.id, path: "/notes/renamed.md" },
      ]),
    );
    hook.unmount();
  });

  it("keeps a dirty tab's path and watch when the file is moved", async () => {
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", memoryFile("/notes/a.md")]]));
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const tab = hook.result.current.state.tabs[0];
    await waitFor(() => expect(port.watchCalls).toHaveLength(1));
    act(() => hook.result.current.changeText(tab.id, "local edits"));

    act(() =>
      port.emitDiskEvent({ kind: "moved", from: "/notes/a.md", to: "/notes/renamed.md" }),
    );
    await act(async () => {});

    expect(hook.result.current.state.tabs[0]).toMatchObject({
      path: "/notes/a.md",
      text: "local edits",
      status: "dirty",
    });
    expect(port.watchCalls).toHaveLength(1);
    hook.unmount();
  });

  it("ignores changed events while a save is in flight", async () => {
    let resolveWrite!: (value: SavedFile) => void;
    const write = new Promise<SavedFile>((resolve) => { resolveWrite = resolve; });
    class DiskAwarePort extends InspectableControllerPort {
      handler: ((event: DiskEvent) => void) | null = null;
      override async subscribeToDiskEvents(handler: (event: DiskEvent) => void) {
        this.handler = handler;
        return () => {};
      }
    }
    const port = new DiskAwarePort(file, write);
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openFiles());
    const id = hook.result.current.state.activeId!;
    act(() => hook.result.current.changeText(id, "local edits"));
    let saving!: Promise<boolean>;
    act(() => { saving = hook.result.current.save(id); });
    await waitFor(() => expect(hook.result.current.state.tabs[0].pendingSave).toBeDefined());
    await waitFor(() => expect(port.handler).not.toBeNull());

    // A changed event with a foreign version arriving mid-save must not
    // conflict the tab: the write's expectedVersion is the real guard here.
    act(() =>
      port.handler!({ kind: "changed", path: file.path, modifiedUnixMs: 9, version: "foreign" }),
    );
    expect(hook.result.current.state.tabs[0].status).toBe("dirty");

    resolveWrite({ path: file.path, modifiedUnixMs: 2, version: "v2" });
    await act(() => saving);
    expect(hook.result.current.state.tabs[0].status).toBe("clean");
    hook.unmount();
  });
});

describe("useAppController scope and watch retargeting", () => {
  const memoryFile = (path: string, text = "saved"): OpenedFile => ({
    path,
    text,
    hasUtf8Bom: false,
    newline: "lf",
    modifiedUnixMs: 1,
    version: `version:${path}`,
  });

  it("re-acquires the scope and re-issues the watch when a closed tab is reopened", async () => {
    const port = new MemoryDocumentPort(new Map([["/notes/a.md", memoryFile("/notes/a.md")]]));
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const tab = hook.result.current.state.tabs[0];
    await waitFor(() => expect(port.watchCalls).toHaveLength(1));

    act(() => hook.result.current.close(tab.id));
    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
        { kind: "release", consumerId: tab.id },
      ]),
    );

    act(() => hook.result.current.reopenClosed());

    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
        { kind: "release", consumerId: tab.id },
        { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
      ]),
    );
    expect(port.watchCalls).toEqual([
      { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
      { kind: "unwatch", consumerId: tab.id },
      { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
    ]);
    hook.unmount();
  });

  it("retargets scope and watch to the new path after a successful save-as", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", memoryFile("/notes/a.md")]]),
      { savePath: "/notes/copy.md" },
    );
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const tab = hook.result.current.state.tabs[0];
    await waitFor(() => expect(port.watchCalls).toHaveLength(1));
    act(() => hook.result.current.changeText(tab.id, "copy contents"));

    await act(() => hook.result.current.saveAs(tab.id));

    expect(hook.result.current.state.tabs[0]).toMatchObject({
      path: "/notes/copy.md",
      status: "clean",
    });
    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
        { kind: "release", consumerId: tab.id },
        { kind: "document", consumerId: tab.id, path: "/notes/copy.md" },
      ]),
    );
    expect(port.watchCalls).toEqual([
      { kind: "document", consumerId: tab.id, path: "/notes/a.md" },
      { kind: "unwatch", consumerId: tab.id },
      { kind: "document", consumerId: tab.id, path: "/notes/copy.md" },
    ]);
    hook.unmount();
  });

  it("delivers disk events for the new path after a save-as", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", memoryFile("/notes/a.md")]]),
      { savePath: "/notes/copy.md" },
    );
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const tab = hook.result.current.state.tabs[0];
    await act(() => hook.result.current.saveAs(tab.id));
    expect(hook.result.current.state.tabs[0].path).toBe("/notes/copy.md");

    act(() => port.updateFile("/notes/copy.md", "external edit", "foreign", 9));
    act(() =>
      port.emitDiskEvent({
        kind: "changed",
        path: "/notes/copy.md",
        modifiedUnixMs: 9,
        version: "foreign",
      }),
    );

    await waitFor(() =>
      expect(hook.result.current.state.tabs[0]).toMatchObject({
        text: "external edit",
        status: "clean",
      }),
    );
    hook.unmount();
  });

  it("acquires scope and watch when an untitled document is first saved", async () => {
    const port = new MemoryDocumentPort(new Map(), { savePath: "/notes/new.md" });
    const hook = renderHook(() => useAppController(port));
    act(() => hook.result.current.newDocument());
    const tab = hook.result.current.state.tabs[0];
    expect(port.scopeCalls).toEqual([]);
    act(() => hook.result.current.changeText(tab.id, "fresh content"));

    await act(() => hook.result.current.save(tab.id));

    expect(hook.result.current.state.tabs[0]).toMatchObject({
      path: "/notes/new.md",
      status: "clean",
    });
    await waitFor(() =>
      expect(port.scopeCalls).toEqual([
        { kind: "document", consumerId: tab.id, path: "/notes/new.md" },
      ]),
    );
    expect(port.watchCalls).toEqual([
      { kind: "document", consumerId: tab.id, path: "/notes/new.md" },
    ]);
    hook.unmount();
  });
});

describe("useAppController conflict resolution", () => {
  const conflictedController = async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", {
        path: "/notes/a.md",
        text: "saved",
        hasUtf8Bom: false,
        newline: "lf" as const,
        modifiedUnixMs: 1,
        version: "v1",
      }]]),
    );
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const id = hook.result.current.state.tabs[0].id;
    act(() => hook.result.current.changeText(id, "local edits"));
    act(() => port.updateFile("/notes/a.md", "disk version", "v2", 9));
    act(() =>
      port.emitDiskEvent({ kind: "changed", path: "/notes/a.md", modifiedUnixMs: 9, version: "v2" }),
    );
    await waitFor(() =>
      expect(hook.result.current.state.tabs[0].status).toBe("conflict"),
    );
    return { port, hook, id };
  };

  it("loadDiskVersion replaces the buffer with the disk content", async () => {
    const { hook, id } = await conflictedController();

    await act(() => hook.result.current.loadDiskVersion(id));

    expect(hook.result.current.state.tabs[0]).toMatchObject({
      text: "disk version",
      savedText: "disk version",
      version: "v2",
      status: "clean",
    });
    hook.unmount();
  });

  it("keepLocalVersion keeps the buffer and re-dirties the tab", async () => {
    const { hook, id } = await conflictedController();

    act(() => hook.result.current.keepLocalVersion(id));

    expect(hook.result.current.state.tabs[0]).toMatchObject({
      text: "local edits",
      version: "v2",
      status: "dirty",
    });
    hook.unmount();
  });
});

describe("useAppController save failures", () => {
  it("keeps the tab dirty and exposes the failure for retry or save-as", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", {
        path: "/notes/a.md",
        text: "saved",
        hasUtf8Bom: false,
        newline: "lf" as const,
        modifiedUnixMs: 1,
        version: "v1",
      }]]),
      { savePath: "/notes/copy.md" },
    );
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const id = hook.result.current.state.tabs[0].id;
    act(() => hook.result.current.changeText(id, "local edits"));

    // An external writer invalidates the expected version before our save.
    act(() => port.updateFile("/notes/a.md", "external", "v2", 9));
    await act(() => hook.result.current.save(id));

    expect(hook.result.current.saveError).toEqual({
      id,
      message: expect.stringContaining("/notes/a.md"),
    });
    expect(hook.result.current.state.tabs[0]).toMatchObject({
      text: "local edits",
      status: "dirty",
    });

    // Retry hits the same conflict and resurfaces the failure state.
    await act(() => hook.result.current.retrySave());
    expect(hook.result.current.saveError?.id).toBe(id);
    expect(hook.result.current.state.tabs[0].status).toBe("dirty");

    // Save-as to a fresh target succeeds and clears the failure state.
    await act(() => hook.result.current.saveErrorSaveAs());
    expect(hook.result.current.saveError).toBeNull();
    expect(hook.result.current.state.tabs[0]).toMatchObject({
      path: "/notes/copy.md",
      text: "local edits",
      status: "clean",
    });
    hook.unmount();
  });

  it("returns to the still-dirty tab when save-as is cancelled after a failure", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", {
        path: "/notes/a.md",
        text: "saved",
        hasUtf8Bom: false,
        newline: "lf" as const,
        modifiedUnixMs: 1,
        version: "v1",
      }]]),
      { savePath: null },
    );
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    const id = hook.result.current.state.tabs[0].id;
    act(() => hook.result.current.changeText(id, "local edits"));
    act(() => port.updateFile("/notes/a.md", "external", "v2", 9));
    await act(() => hook.result.current.save(id));
    expect(hook.result.current.saveError?.id).toBe(id);

    await act(() => hook.result.current.saveErrorSaveAs());

    expect(hook.result.current.saveError).toBeNull();
    expect(port.writes).toHaveLength(0);
    expect(hook.result.current.state.tabs[0]).toMatchObject({
      path: "/notes/a.md",
      text: "local edits",
      status: "dirty",
    });
    hook.unmount();
  });
});

describe("useAppController recovery drafts", () => {
  const draftableFile = (path: string): OpenedFile => ({
    path,
    text: "saved",
    hasUtf8Bom: false,
    newline: "lf",
    modifiedUnixMs: 1,
    version: `version:${path}`,
  });

  it("persists a debounced draft while dirty and discards it after a successful save", async () => {
    vi.useFakeTimers();
    try {
      const port = new MemoryDocumentPort(new Map([["/notes/a.md", draftableFile("/notes/a.md")]]));
      const hook = renderHook(() => useAppController(port));
      await act(() => hook.result.current.openPath("/notes/a.md"));
      const id = hook.result.current.state.tabs[0].id;

      act(() => hook.result.current.changeText(id, "unsaved work"));
      expect(port.drafts).toHaveLength(0);

      await act(async () => { vi.advanceTimersByTime(2000); });
      expect(port.drafts).toHaveLength(1);
      expect(port.drafts[0]).toMatchObject({
        draftId: `draft-${id}`,
        originalPath: "/notes/a.md",
        title: "a.md",
        text: "unsaved work",
        savedVersion: "version:/notes/a.md",
      });
      expect(port.drafts[0].savedTextHash).toMatch(/^[0-9a-f]{8}$/);

      act(() => hook.result.current.changeText(id, "unsaved work v2"));
      await act(async () => { vi.advanceTimersByTime(1999); });
      expect((await port.readDraft(`draft-${id}`)).text).toBe("unsaved work");
      await act(async () => { vi.advanceTimersByTime(1); });
      expect((await port.readDraft(`draft-${id}`)).text).toBe("unsaved work v2");

      await act(() => hook.result.current.save(id));
      expect(hook.result.current.state.tabs[0].status).toBe("clean");
      expect(port.drafts).toHaveLength(0);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards the draft when a dirty tab is closed with discard", async () => {
    vi.useFakeTimers();
    try {
      const port = new MemoryDocumentPort(new Map([["/notes/a.md", draftableFile("/notes/a.md")]]));
      const hook = renderHook(() => useAppController(port));
      await act(() => hook.result.current.openPath("/notes/a.md"));
      const id = hook.result.current.state.tabs[0].id;
      act(() => hook.result.current.changeText(id, "unsaved work"));
      await act(async () => { vi.advanceTimersByTime(2000); });
      expect(port.drafts).toHaveLength(1);

      act(() => hook.result.current.close(id));
      await act(() => hook.result.current.confirmClose("discard"));

      expect(hook.result.current.state.tabs).toHaveLength(0);
      expect(port.drafts).toHaveLength(0);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not postpone another tab's draft when typing in a different tab", async () => {
    vi.useFakeTimers();
    try {
      const port = new MemoryDocumentPort(new Map([
        ["/notes/a.md", draftableFile("/notes/a.md")],
        ["/notes/b.md", draftableFile("/notes/b.md")],
      ]));
      const hook = renderHook(() => useAppController(port));
      await act(() => hook.result.current.openPath("/notes/a.md"));
      await act(() => hook.result.current.openPath("/notes/b.md"));
      const [tabA, tabB] = hook.result.current.state.tabs;

      act(() => hook.result.current.changeText(tabA.id, "a-1"));
      act(() => hook.result.current.changeText(tabB.id, "b-1"));
      await act(async () => { vi.advanceTimersByTime(1000); });

      // Typing in A must not reset B's debounce: B's draft lands at its own
      // 2s mark while A's lands 2s after A's last keystroke.
      act(() => hook.result.current.changeText(tabA.id, "a-2"));
      await act(async () => { vi.advanceTimersByTime(999); });
      expect(port.drafts).toHaveLength(0);

      await act(async () => { vi.advanceTimersByTime(1); });
      expect(port.drafts).toHaveLength(1);
      expect(port.drafts[0]).toMatchObject({ draftId: `draft-${tabB.id}`, text: "b-1" });

      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(port.drafts).toHaveLength(2);
      expect(port.drafts.map((draft) => draft.draftId).sort()).toEqual(
        [`draft-${tabA.id}`, `draft-${tabB.id}`].sort(),
      );
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reschedules a draft write after a transient writeDraft failure", async () => {
    vi.useFakeTimers();
    try {
      class FlakyDraftPort extends MemoryDocumentPort {
        failures = 1;
        override async writeDraft(draft: RecoveryDraft): Promise<RecoveryDraftInfo> {
          if (this.failures > 0) {
            this.failures -= 1;
            throw new DocumentPortError("io", "transient draft failure");
          }
          return super.writeDraft(draft);
        }
      }
      const port = new FlakyDraftPort(new Map([["/notes/a.md", draftableFile("/notes/a.md")]]));
      const hook = renderHook(() => useAppController(port));
      await act(() => hook.result.current.openPath("/notes/a.md"));
      const id = hook.result.current.state.tabs[0].id;
      act(() => hook.result.current.changeText(id, "unsaved work"));

      await act(async () => { vi.advanceTimersByTime(2000); });
      expect(port.drafts).toHaveLength(0);

      // Any later state change must re-arm the debounce even when the tab's
      // text is unchanged; without it the failed write would never retry.
      act(() => hook.result.current.changeText(id, "unsaved work"));
      await act(async () => { vi.advanceTimersByTime(2000); });

      expect(port.drafts).toHaveLength(1);
      expect(port.drafts[0]).toMatchObject({ draftId: `draft-${id}`, text: "unsaved work" });
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes pending drafts when the window close is requested", async () => {
    vi.useFakeTimers();
    try {
      const port = new MemoryDocumentPort(new Map([["/notes/a.md", draftableFile("/notes/a.md")]]));
      const hook = renderHook(() => useAppController(port));
      await act(() => hook.result.current.openPath("/notes/a.md"));
      const id = hook.result.current.state.tabs[0].id;
      act(() => hook.result.current.changeText(id, "unsaved work"));

      await act(() => port.emitCloseRequested());

      expect(port.drafts).toHaveLength(1);
      expect(port.drafts[0]).toMatchObject({ draftId: `draft-${id}`, text: "unsaved work" });
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces leftover drafts on launch and restores one as a dirty tab", async () => {
    const leftover: RecoveryDraft = {
      draftId: "draft-document-9",
      originalPath: "/notes/a.md",
      title: "a.md",
      text: "unsaved",
      hasUtf8Bom: false,
      newline: "lf",
      savedTextHash: "hash",
      savedVersion: "v1",
    };
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", draftableFile("/notes/a.md")]]),
      { drafts: [leftover] },
    );
    const hook = renderHook(() => useAppController(port));

    await waitFor(() => expect(hook.result.current.recoveryDrafts).toHaveLength(1));

    await act(() => hook.result.current.restoreDraft(hook.result.current.recoveryDrafts![0]));

    const tab = hook.result.current.state.tabs[0];
    expect(tab).toMatchObject({
      path: "/notes/a.md",
      title: "a.md",
      text: "unsaved",
      version: "v1",
      status: "dirty",
    });
    expect(hook.result.current.recoveryDrafts).toEqual([]);
    expect(port.drafts).toHaveLength(0);
    await waitFor(() =>
      expect(port.scopeCalls).toContainEqual({
        kind: "document",
        consumerId: tab.id,
        path: "/notes/a.md",
      }),
    );
    hook.unmount();
  });

  it("discards a leftover draft without opening a tab", async () => {
    const leftover: RecoveryDraft = {
      draftId: "draft-document-9",
      originalPath: null,
      title: "Untitled",
      text: "unsaved",
      hasUtf8Bom: false,
      newline: "lf",
      savedTextHash: "hash",
      savedVersion: null,
    };
    const port = new MemoryDocumentPort(new Map(), { drafts: [leftover] });
    const hook = renderHook(() => useAppController(port));
    await waitFor(() => expect(hook.result.current.recoveryDrafts).toHaveLength(1));

    await act(() => hook.result.current.discardRecoveryDraft(hook.result.current.recoveryDrafts![0]));

    expect(hook.result.current.recoveryDrafts).toEqual([]);
    expect(hook.result.current.state.tabs).toHaveLength(0);
    expect(port.drafts).toHaveLength(0);
    hook.unmount();
  });
});

describe("useAppController sessions and recent items", () => {
  const sessionFile = (path: string): OpenedFile => ({
    path,
    text: `text:${path}`,
    hasUtf8Bom: false,
    newline: "lf",
    modifiedUnixMs: 1,
    version: `version:${path}`,
  });

  it("restores session tabs, the active tab, and the workspace on launch", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/a.md", sessionFile("/notes/a.md")],
        ["/notes/b.md", sessionFile("/notes/b.md")],
      ]),
      {
        workspace: { path: "/notes", title: "notes" },
        session: {
          recent: [],
          openPaths: ["/notes/a.md", "/notes/b.md"],
          activePath: "/notes/a.md",
          workspacePath: "/notes",
        },
      },
    );
    const hook = renderHook(() => useAppController(port));

    await waitFor(() => expect(hook.result.current.state.tabs).toHaveLength(2));

    expect(hook.result.current.state.tabs.map((tab) => tab.path)).toEqual([
      "/notes/a.md",
      "/notes/b.md",
    ]);
    const active = hook.result.current.state.tabs.find(
      (tab) => tab.id === hook.result.current.state.activeId,
    );
    expect(active?.path).toBe("/notes/a.md");
    await waitFor(() => expect(hook.result.current.workspace?.path).toBe("/notes"));
    hook.unmount();
  });

  it("restores and persists the outline width without an open-state preference", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      session: {
        recent: [],
        openPaths: [],
        activePath: null,
        workspacePath: null,
        outline: { width: 348 },
      },
    });
    const hook = renderHook(() => useAppController(port));

    await waitFor(() =>
      expect(hook.result.current.outlinePreferences.width).toBe(348),
    );
    act(() => {
      hook.result.current.setOutlinePreferences({ width: 372 });
    });
    await waitFor(() =>
      expect(port.session?.outline).toEqual({ width: 372 }),
    );
    expect(Object.keys(port.session?.outline ?? {})).toEqual(["width"]);
    hook.unmount();
  });

  it("skips unrestorable session files with a non-blocking message", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", sessionFile("/notes/a.md")]]),
      {
        session: {
          recent: [],
          openPaths: ["/notes/gone.md", "/notes/a.md"],
          activePath: null,
          workspacePath: null,
        },
      },
    );
    const hook = renderHook(() => useAppController(port));

    await waitFor(() => expect(hook.result.current.state.tabs).toHaveLength(1));

    expect(hook.result.current.state.tabs[0].path).toBe("/notes/a.md");
    expect(hook.result.current.error).toContain("/notes/gone.md");
    hook.unmount();
  });

  it("persists tab order, the active tab, and recent items as they change", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/a.md", sessionFile("/notes/a.md")],
        ["/notes/b.md", sessionFile("/notes/b.md")],
      ]),
    );
    const hook = renderHook(() => useAppController(port));
    await act(() => hook.result.current.openPath("/notes/a.md"));
    await act(() => hook.result.current.openPath("/notes/b.md"));

    await waitFor(() =>
      expect(port.session?.openPaths).toEqual(["/notes/a.md", "/notes/b.md"]),
    );
    expect(port.session?.activePath).toBe("/notes/b.md");
    expect(port.session?.recent.map((item) => item.path)).toEqual([
      "/notes/b.md",
      "/notes/a.md",
    ]);

    const tabA = hook.result.current.state.tabs[0];
    act(() => hook.result.current.activate(tabA.id));
    await waitFor(() => expect(port.session?.activePath).toBe("/notes/a.md"));
    hook.unmount();
  });

  it("dedupes recent entries by normalized path and caps the list at 10", async () => {
    const seeded = Array.from({ length: 10 }, (_, index) => ({
      path: `/notes/old-${index}.md`,
      kind: "file" as const,
    }));
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", sessionFile("/notes/a.md")]]),
      {
        session: { recent: seeded, openPaths: [], activePath: null, workspacePath: null },
      },
    );
    const hook = renderHook(() => useAppController(port));
    await waitFor(() => expect(hook.result.current.recent).toHaveLength(10));

    await act(() => hook.result.current.openPath("/notes/a.md"));
    await act(() => hook.result.current.openPath("/NOTES/a.md"));

    const recent = hook.result.current.recent;
    expect(recent).toHaveLength(10);
    // The stored file's canonical path is what gets recorded.
    expect(recent[0]).toEqual({ path: "/notes/a.md", kind: "file" });
    expect(
      recent.filter((item) => item.path.toLowerCase() === "/notes/a.md"),
    ).toHaveLength(1);
    hook.unmount();
  });

  it("opens recent entries and removes them only after a confirmed not_found", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", sessionFile("/notes/a.md")]]),
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
    const hook = renderHook(() => useAppController(port));
    await waitFor(() => expect(hook.result.current.recent).toHaveLength(3));

    await act(() => hook.result.current.openRecent({ path: "/notes/a.md", kind: "file" }));
    expect(hook.result.current.state.tabs.map((tab) => tab.path)).toEqual(["/notes/a.md"]);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.recent).toHaveLength(3);

    await act(() => hook.result.current.openRecent({ path: "/notes/gone.md", kind: "file" }));
    expect(hook.result.current.error).toContain("/notes/gone.md");
    expect(hook.result.current.recent.map((item) => item.path)).toEqual([
      "/notes/a.md",
      "/notes",
    ]);

    await act(() => hook.result.current.openRecent({ path: "/notes", kind: "folder" }));
    expect(hook.result.current.workspace?.path).toBe("/notes");
    hook.unmount();
  });
});

describe("useAppController canonical paths", () => {
  it("matches a canonical disk event to a tab opened through a symlinked path", async () => {
    // The backend returns canonical paths from open_document, so a tab opened
    // via a symlinked directory carries the canonical path and disk events
    // (always canonical) match it.
    const canonicalFile: OpenedFile = {
      path: "/private/tmp/notes/a.md",
      text: "saved",
      hasUtf8Bom: false,
      newline: "lf",
      modifiedUnixMs: 1,
      version: "v1",
    };
    class SymlinkAwarePort extends InspectableControllerPort {
      handler: ((event: DiskEvent) => void) | null = null;
      diskText = "external edit";
      override async openPath() {
        return { ...canonicalFile, text: this.diskText };
      }
      override async subscribeToDiskEvents(handler: (event: DiskEvent) => void) {
        this.handler = handler;
        return () => {};
      }
    }
    const port = new SymlinkAwarePort(canonicalFile, Promise.resolve({
      path: canonicalFile.path,
      modifiedUnixMs: 2,
      version: "v2",
    }));
    const hook = renderHook(() => useAppController(port));

    await act(() => hook.result.current.openPath("/tmp/notes/a.md"));
    expect(hook.result.current.state.tabs[0].path).toBe("/private/tmp/notes/a.md");
    await waitFor(() => expect(port.handler).not.toBeNull());

    act(() =>
      port.handler!({
        kind: "changed",
        path: "/private/tmp/notes/a.md",
        modifiedUnixMs: 9,
        version: "v2",
      }),
    );

    await waitFor(() =>
      expect(hook.result.current.state.tabs[0]).toMatchObject({
        text: "external edit",
        status: "clean",
      }),
    );
    hook.unmount();
  });
});

describe("useAppController per-tab view modes", () => {
  const twoFilePort = () =>
    new ScopeAwareControllerPort([scopedFile("/a.md"), scopedFile("/b.md")]);

  it("defaults to editing and remembers each tab's mode independently", async () => {
    const hook = renderHook(() => useAppController(twoFilePort()));
    await act(() => hook.result.current.openFiles());
    const [a, b] = hook.result.current.state.tabs.map((tab) => tab.id);

    expect(hook.result.current.viewModeOf(a)).toBe("editing");
    expect(hook.result.current.viewModeOf(b)).toBe("editing");
    expect(hook.result.current.viewModeOf(null)).toBe("editing");

    act(() => hook.result.current.setViewMode(a, "reading"));
    expect(hook.result.current.viewModeOf(a)).toBe("reading");
    expect(hook.result.current.viewModeOf(b)).toBe("editing");
  });

  it("prunes a closed tab's remembered mode", async () => {
    const hook = renderHook(() => useAppController(twoFilePort()));
    await act(() => hook.result.current.openFiles());
    const [a] = hook.result.current.state.tabs.map((tab) => tab.id);
    act(() => hook.result.current.setViewMode(a, "reading"));
    expect(hook.result.current.viewModes.has(a)).toBe(true);

    // The tab is clean, so close() removes it without a confirmation.
    act(() => hook.result.current.close(a));
    expect(hook.result.current.state.tabs.some((tab) => tab.id === a)).toBe(false);
    expect(hook.result.current.viewModes.has(a)).toBe(false);
    expect(hook.result.current.viewModeOf(a)).toBe("editing");
  });

  it("toggleReading switches between reading and editing", async () => {
    const hook = renderHook(() => useAppController(twoFilePort()));
    await act(() => hook.result.current.openFiles());
    const [a] = hook.result.current.state.tabs.map((tab) => tab.id);

    act(() => hook.result.current.toggleReading(a));
    expect(hook.result.current.viewModeOf(a)).toBe("reading");
    act(() => hook.result.current.toggleReading(a));
    expect(hook.result.current.viewModeOf(a)).toBe("editing");
  });
});
