import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DirectoryEntry, DocumentPort, SavedFile } from "../document/DocumentPort";
import { DocumentPortError } from "../document/DocumentPort";
import type { OpenedFile, PendingWriteRequest, RecoveryDraft, RecoveryDraftInfo, SaveTarget } from "../document/types";
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
  async subscribeToDiskEvents() { return () => {}; }
  async listDrafts() { return []; }
  async readDraft(): Promise<RecoveryDraft> { throw new DocumentPortError("not_found", "no drafts"); }
  async writeDraft(): Promise<RecoveryDraftInfo> { throw new DocumentPortError("io", "not supported"); }
  async discardDraft() {}
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
  async subscribeToDiskEvents() { return () => {}; }
  async listDrafts() { return []; }
  async readDraft(): Promise<RecoveryDraft> { throw new DocumentPortError("not_found", "no drafts"); }
  async writeDraft(): Promise<RecoveryDraftInfo> { throw new DocumentPortError("io", "not supported"); }
  async discardDraft() {}
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
