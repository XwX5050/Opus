import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn(), listen: vi.fn(), emit: vi.fn(), convertFileSrc: vi.fn() }));
const { invoke, open } = mocks;

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: mocks.convertFileSrc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emit: mocks.emit }));

import { DocumentPortError } from "./DocumentPort";
import { createTauriDocumentPort, restoreWindowGeometry, subscribeToImageDrops, subscribeToMenuActions, subscribeToOpenPaths, tauriImagePreviewUrl } from "./tauriDocumentPort";

describe("tauri document port", () => {
  beforeEach(() => vi.resetAllMocks());

  it("maps open_document's snake case DTO", async () => {
    invoke.mockResolvedValue({ path: "/tmp/a.md", text: "a", has_utf8_bom: true, newline: "cr_lf", modified_unix_ms: 12, version: "hash" });
    const result = await createTauriDocumentPort().openPath("/tmp/a.md");
    expect(invoke).toHaveBeenCalledWith("open_document", { path: "/tmp/a.md" });
    expect(result).toEqual({ path: "/tmp/a.md", text: "a", hasUtf8Bom: true, newline: "cr_lf", modifiedUnixMs: 12, version: "hash" });
  });

  it("maps structured command errors", async () => {
    invoke.mockRejectedValue({ code: "invalid_utf8", message: "bad" });
    await expect(createTauriDocumentPort().openPath("/tmp/a.md")).rejects.toMatchObject({ code: "invalid_utf8", message: "bad" } satisfies Partial<DocumentPortError>);
  });

  it("maps conflict errors", async () => {
    invoke.mockRejectedValue({ code: "conflict", message: "stale" });
    await expect(createTauriDocumentPort().openPath("/tmp/a.md")).rejects.toMatchObject({ code: "conflict" });
  });

  it("returns no files when open dialog is cancelled", async () => {
    open.mockResolvedValue(null);
    await expect(createTauriDocumentPort().chooseAndOpenFiles()).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes a frozen pending request exactly once", async () => {
    const request = Object.freeze({ requestId: "r", documentId: "d", targetPath: "/tmp/a.md", text: "x", hasUtf8Bom: false, newline: "lf" as const, expectedVersion: "v", pathPlatform: "macos" as const });
    invoke.mockResolvedValue({ path: "/tmp/a.md", modified_unix_ms: 2, version: "v2" });
    await expect(createTauriDocumentPort().write(request)).resolves.toEqual({ path: "/tmp/a.md", modifiedUnixMs: 2, version: "v2" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("save_document", { request: { request_id: "r", document_id: "d", target_path: "/tmp/a.md", text: "x", has_utf8_bom: false, newline: "lf", expected_version: "v", path_platform: "macos" } });
  });

  it("chooses save targets without writing", async () => {
    mocks.save.mockResolvedValueOnce(null).mockResolvedValueOnce("/tmp/new.md").mockResolvedValueOnce("/tmp/old.md");
    invoke.mockRejectedValueOnce({ code: "not_found", message: "missing" }).mockResolvedValueOnce({ path: "/tmp/old.md", text: "", has_utf8_bom: false, newline: "lf", modified_unix_ms: 1, version: "v" });
    const port = createTauriDocumentPort();
    await expect(port.chooseSavePath("a.md")).resolves.toBeNull();
    await expect(port.chooseSavePath("a.md")).resolves.toEqual({ path: "/tmp/new.md", expectedVersion: null });
    await expect(port.chooseSavePath("a.md")).resolves.toEqual({ path: "/tmp/old.md", expectedVersion: "v" });
    expect(invoke.mock.calls.every(([command]) => command === "open_document")).toBe(true);
  });

  it("opens dialog files independently and reports each failure", async () => {
    open.mockResolvedValue(["/tmp/bad.md", "/tmp/good.md"]);
    invoke.mockRejectedValueOnce({ code: "not_found", message: "gone" }).mockResolvedValueOnce({ path: "/tmp/good.md", text: "ok", has_utf8_bom: false, newline: "lf", modified_unix_ms: 1, version: "v" });
    const onError = vi.fn();
    const files = await createTauriDocumentPort(onError).chooseAndOpenFiles();
    expect(files.map(file => file.path)).toEqual(["/tmp/good.md"]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "not_found" }), { path: "/tmp/bad.md", source: "dialog" });
  });

  it("cleans up a successful listener when handshake emit fails", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValue(unlisten); mocks.emit.mockRejectedValue(new Error("emit failed"));
    await expect(subscribeToOpenPaths(createTauriDocumentPort(), vi.fn())).rejects.toThrow("emit failed");
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("isolates event open failures and still delivers later files", async () => {
    let handler!: (event: { payload: { files: string[]; directories: string[] } }) => void;
    mocks.listen.mockImplementation(async (_name, value) => { handler = value; return vi.fn(); });
    const port = { ...createTauriDocumentPort(), openPath: vi.fn(async path => {
      if (path.includes("bad")) throw new DocumentPortError("not_found", "gone");
      return { path, text: "", hasUtf8Bom: false, newline: "lf" as const, modifiedUnixMs: 1, version: "v" };
    }) };
    const onFiles = vi.fn(); const onError = vi.fn();
    const subscriptions = await subscribeToOpenPaths(port, onFiles, vi.fn(), onError);
    await subscriptions.ready();
    handler({ payload: { files: ["/tmp/bad.md", "/tmp/good.md"], directories: [] } });
    await vi.waitFor(() => expect(onFiles).toHaveBeenCalledWith([expect.objectContaining({ path: "/tmp/good.md" })]));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "not_found" }), { path: "/tmp/bad.md", source: "event" });
    await subscriptions.dispose();
  });

  it("processes event payloads in arrival order", async () => {
    let handler!: (event: { payload: { files: string[]; directories: string[] } }) => void;
    mocks.listen.mockImplementation(async (_name, value) => { handler = value; return vi.fn(); });
    let resolveFirst!: (value: { path: string; text: string; hasUtf8Bom: false; newline: "lf"; modifiedUnixMs: number; version: string }) => void;
    const first = new Promise<Parameters<typeof resolveFirst>[0]>(resolve => { resolveFirst = resolve; });
    const openPath = vi.fn((path: string) => path.includes("first") ? first : Promise.resolve({ path, text: "", hasUtf8Bom: false as const, newline: "lf" as const, modifiedUnixMs: 1, version: "v" }));
    const subscriptions = await subscribeToOpenPaths({ ...createTauriDocumentPort(), openPath }, vi.fn()); await subscriptions.ready();
    handler({ payload: { files: ["/tmp/first.md"], directories: [] } });
    handler({ payload: { files: ["/tmp/second.md"], directories: [] } });
    await vi.waitFor(() => expect(openPath).toHaveBeenCalledTimes(1));
    expect(openPath).toHaveBeenNthCalledWith(1, "/tmp/first.md");
    resolveFirst({ path: "/tmp/first.md", text: "", hasUtf8Bom: false, newline: "lf", modifiedUnixMs: 1, version: "v" });
    await vi.waitFor(() => expect(openPath).toHaveBeenCalledTimes(2)); await subscriptions.dispose();
  });

  it("dispose during an in-flight open suppresses every callback and is idempotent", async () => {
    let handler!: (event: { payload: { files: string[]; directories: string[] } }) => void;
    const unlisten = vi.fn(); mocks.listen.mockImplementation(async (_name, value) => { handler = value; return unlisten; });
    let resolveOpen!: (value: { path: string; text: string; hasUtf8Bom: false; newline: "lf"; modifiedUnixMs: number; version: string }) => void;
    const pending = new Promise<Parameters<typeof resolveOpen>[0]>(resolve => { resolveOpen = resolve; });
    const port = { ...createTauriDocumentPort(), openPath: vi.fn(() => pending) };
    const onFiles = vi.fn(); const onDirectory = vi.fn(); const onError = vi.fn();
    const subscriptions = await subscribeToOpenPaths(port, onFiles, onDirectory, onError); await subscriptions.ready();
    handler({ payload: { files: ["/tmp/a.md"], directories: [] } }); await vi.waitFor(() => expect(port.openPath).toHaveBeenCalled());
    const disposing = subscriptions.dispose(); subscriptions.dispose();
    resolveOpen({ path: "/tmp/a.md", text: "", hasUtf8Bom: false, newline: "lf", modifiedUnixMs: 1, version: "v" });
    await disposing;
    expect(onFiles).not.toHaveBeenCalled(); expect(onDirectory).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled(); expect(unlisten).toHaveBeenCalledOnce();
  });

  it("dispose during ready flush does not deliver a queued result", async () => {
    let handler!: (event: { payload: { files: string[]; directories: string[] } }) => void;
    mocks.listen.mockImplementation(async (_name, value) => { handler = value; return vi.fn(); });
    let resolveOpen!: (value: { path: string; text: string; hasUtf8Bom: false; newline: "lf"; modifiedUnixMs: number; version: string }) => void;
    const pending = new Promise<Parameters<typeof resolveOpen>[0]>(resolve => { resolveOpen = resolve; });
    const port = { ...createTauriDocumentPort(), openPath: vi.fn(() => pending) }; const onFiles = vi.fn();
    const subscriptions = await subscribeToOpenPaths(port, onFiles); handler({ payload: { files: ["/tmp/a.md"], directories: [] } });
    const ready = subscriptions.ready(); await vi.waitFor(() => expect(port.openPath).toHaveBeenCalled()); const disposing = subscriptions.dispose();
    resolveOpen({ path: "/tmp/a.md", text: "", hasUtf8Bom: false, newline: "lf", modifiedUnixMs: 1, version: "v" });
    await Promise.all([ready, disposing]); expect(onFiles).not.toHaveBeenCalled();
  });

  it("listens before handshake, queues until ready, handles typed drop, and disposes", async () => {
    let openHandler!: (event: { payload: { files: string[]; directories: string[] } }) => void;
    const unlistenOpen = vi.fn();
    mocks.listen.mockImplementation(async (_name, handler) => { openHandler = handler; return unlistenOpen; });
    const port = { ...createTauriDocumentPort(), openPath: vi.fn(async path => ({ path, text: "", hasUtf8Bom: false, newline: "lf" as const, modifiedUnixMs: 1, version: "v" })) };
    const files = vi.fn(); const directory = vi.fn();
    const subscriptions = await subscribeToOpenPaths(port, files, directory);
    expect(mocks.listen).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith("frontend-ready");
    openHandler({ payload: { files: ["/tmp/a.md"], directories: ["/tmp/folder.md"] } });
    expect(files).not.toHaveBeenCalled();
    await subscriptions.ready();
    expect(files).toHaveBeenCalledTimes(1); expect(directory).toHaveBeenCalledWith("/tmp/folder.md");
    openHandler({ payload: { files: [], directories: ["/tmp/raw"] } });
    await subscriptions.dispose();
    expect(unlistenOpen).toHaveBeenCalledOnce();
  });

  it("does not handshake when registration finishes after its signal was aborted", async () => {
    let finishListening!: (unlisten: () => void) => void;
    const registered = new Promise<() => void>((resolve) => { finishListening = resolve; });
    const unlisten = vi.fn();
    mocks.listen.mockReturnValue(registered);
    const controller = new AbortController();

    const subscribing = subscribeToOpenPaths(
      createTauriDocumentPort(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      controller.signal,
    );
    controller.abort();
    finishListening(unlisten);
    const subscription = await subscribing;

    expect(unlisten).toHaveBeenCalledOnce();
    expect(mocks.emit).not.toHaveBeenCalled();
    await subscription.ready();
    await subscription.dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("tauri document port clipboard images and asset scopes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null without writing when the image save dialog is cancelled", async () => {
    mocks.save.mockResolvedValue(null);
    const port = createTauriDocumentPort();
    const result = await port.saveClipboardImage({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      documentPath: "/notes/a.md",
    });
    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("defaults the dialog to the document directory with a timestamped png name", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 6, 23, 9, 5, 7));
      mocks.save.mockResolvedValue("/notes/image-20260723-090507.png");
      invoke.mockResolvedValue(undefined);
      const port = createTauriDocumentPort();
      const bytes = new Uint8Array([137, 80, 78, 71]);
      const result = await port.saveClipboardImage({
        bytes,
        mimeType: "image/png",
        documentPath: "/notes/a.md",
      });
      expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
        defaultPath: "/notes/image-20260723-090507.png",
      }));
      expect(invoke).toHaveBeenCalledTimes(1);
      const [command, payload] = invoke.mock.calls[0];
      expect(command).toBe("save_clipboard_image");
      expect(payload).toMatchObject({
        path: "/notes/image-20260723-090507.png",
        mimeType: "image/png",
      });
      // The typed array is forwarded as-is; Tauri's IPC serializes it
      // without an Array.from copy.
      expect(payload.bytes).toBe(bytes);
      expect(result).toBe("image-20260723-090507.png");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a jpeg extension and returns an absolute path outside the document directory", async () => {
    mocks.save.mockResolvedValue("/elsewhere/pic.jpg");
    invoke.mockResolvedValue(undefined);
    const port = createTauriDocumentPort();
    const bytes = new Uint8Array([255, 216]);
    const result = await port.saveClipboardImage({
      bytes,
      mimeType: "image/jpeg",
      documentPath: "/notes/a.md",
    });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: expect.stringMatching(/^\/notes\/image-\d{8}-\d{6}\.jpg$/),
    }));
    const [command, payload] = invoke.mock.calls[0];
    expect(command).toBe("save_clipboard_image");
    expect(payload).toMatchObject({ path: "/elsewhere/pic.jpg", mimeType: "image/jpeg" });
    expect(payload.bytes).toBe(bytes);
    expect(result).toBe("/elsewhere/pic.jpg");
  });

  it("still opens a dialog with a sensible default for an unsaved document", async () => {
    mocks.save.mockResolvedValue("/tmp/image-1.png");
    invoke.mockResolvedValue(undefined);
    const port = createTauriDocumentPort();
    const result = await port.saveClipboardImage({
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      documentPath: null,
    });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: expect.stringMatching(/^image-\d{8}-\d{6}\.png$/),
    }));
    expect(result).toBe("/tmp/image-1.png");
  });

  it("propagates structured write failures from save_clipboard_image", async () => {
    mocks.save.mockResolvedValue("/notes/image.png");
    invoke.mockRejectedValue({ code: "permission_denied", message: "nope" });
    const port = createTauriDocumentPort();
    await expect(port.saveClipboardImage({
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      documentPath: "/notes/a.md",
    })).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("issues acquire and release scope commands exactly once each", async () => {
    invoke.mockResolvedValue(undefined);
    const port = createTauriDocumentPort();
    await port.acquireDocumentScope("tab-1", "/notes/a.md");
    await port.acquireWorkspaceScope("ws-1", "/notes");
    await port.releaseAssetScope("tab-1");
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(1, "acquire_document_scope", { consumerId: "tab-1", path: "/notes/a.md" });
    expect(invoke).toHaveBeenNthCalledWith(2, "acquire_workspace_scope", { consumerId: "ws-1", root: "/notes" });
    expect(invoke).toHaveBeenNthCalledWith(3, "release_asset_scope", { consumerId: "tab-1" });
  });

  it("exposes convertFileSrc through the preview URL helper", () => {
    mocks.convertFileSrc.mockReturnValue("asset://localhost/notes/pic.png");
    expect(tauriImagePreviewUrl("/notes/pic.png")).toBe("asset://localhost/notes/pic.png");
    expect(mocks.convertFileSrc).toHaveBeenCalledWith("/notes/pic.png");
  });
});

describe("tauri document port workspace commands", () => {
  beforeEach(() => vi.resetAllMocks());

  it("maps list_directory DTOs to camelCase entries", async () => {
    invoke.mockResolvedValue([
      { name: "notes", path: "/ws/notes", is_directory: true },
      { name: "a.md", path: "/ws/a.md", is_directory: false },
    ]);

    const entries = await createTauriDocumentPort().listDirectory("/ws", "");

    expect(invoke).toHaveBeenCalledWith("list_directory", { root: "/ws", relative: "" });
    expect(entries).toEqual([
      { name: "notes", path: "/ws/notes", isDirectory: true },
      { name: "a.md", path: "/ws/a.md", isDirectory: false },
    ]);
  });

  it("passes rename_entry's new name as camel case toName", async () => {
    invoke.mockResolvedValue({ name: "renamed.md", path: "/ws/renamed.md", is_directory: false });

    const entry = await createTauriDocumentPort().renameEntry("/ws", "old.md", "renamed.md");

    expect(invoke).toHaveBeenCalledWith("rename_entry", { root: "/ws", from: "old.md", toName: "renamed.md" });
    expect(entry).toEqual({ name: "renamed.md", path: "/ws/renamed.md", isDirectory: false });
  });

  it("chooseWorkspace picks a directory through the dialog plugin and validates via open_workspace", async () => {
    open.mockResolvedValue("/ws");
    invoke.mockImplementation(async (command: string) => {
      if (command === "open_workspace") return { path: "/ws", title: "ws" };
      throw new Error(`unexpected ${command}`);
    });
    const port = createTauriDocumentPort();

    const root = await port.chooseWorkspace();

    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(invoke).toHaveBeenCalledWith("open_workspace", { root: "/ws" });
    expect(root).toEqual({ path: "/ws", title: "ws" });
  });

  it("chooseWorkspace returns null on cancel without invoking the backend", async () => {
    open.mockResolvedValue(null);

    await expect(createTauriDocumentPort().chooseWorkspace()).resolves.toBeNull();

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("subscribeToImageDrops", () => {
  beforeEach(() => vi.resetAllMocks());

  it("maps native drop payloads to CSS coordinates and cloned paths", async () => {
    let handler!: (event: { payload: { paths: string[]; x: number; y: number } }) => void;
    const unlisten = vi.fn();
    mocks.listen.mockImplementation(async (_name, value) => { handler = value; return unlisten; });
    const onImages = vi.fn();

    const stop = await subscribeToImageDrops(onImages);
    expect(mocks.listen).toHaveBeenCalledWith("image-files-dropped", expect.any(Function));
    handler({ payload: { paths: ["/p/pic.png"], x: 200, y: 100 } });

    const scale = window.devicePixelRatio || 1;
    expect(onImages).toHaveBeenCalledWith({
      paths: ["/p/pic.png"],
      x: 200 / scale,
      y: 100 / scale,
    });
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("unlistens without delivering when the signal aborts before registration finishes", async () => {
    let finishListening!: (unlisten: () => void) => void;
    const registered = new Promise<() => void>((resolve) => { finishListening = resolve; });
    mocks.listen.mockReturnValue(registered);
    const unlisten = vi.fn();
    const controller = new AbortController();

    const subscribing = subscribeToImageDrops(vi.fn(), controller.signal);
    controller.abort();
    finishListening(unlisten);

    const stop = await subscribing;
    expect(unlisten).toHaveBeenCalledOnce();
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("subscribeToMenuActions", () => {
  beforeEach(() => vi.resetAllMocks());

  it("delivers menu-action payloads and unlistens on stop", async () => {
    let handler!: (event: { payload: string }) => void;
    const unlisten = vi.fn();
    mocks.listen.mockImplementation(async (_name, value) => { handler = value; return unlisten; });
    const onAction = vi.fn();

    const stop = await subscribeToMenuActions(onAction);

    expect(mocks.listen).toHaveBeenCalledWith("menu-action", expect.any(Function));
    handler({ payload: "menu.new" });
    expect(onAction).toHaveBeenCalledWith("menu.new");
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("unlistens without delivering when the signal aborts before registration finishes", async () => {
    let finishListening!: (unlisten: () => void) => void;
    const registered = new Promise<() => void>((resolve) => { finishListening = resolve; });
    mocks.listen.mockReturnValue(registered);
    const unlisten = vi.fn();
    const controller = new AbortController();

    const subscribing = subscribeToMenuActions(vi.fn(), controller.signal);
    controller.abort();
    finishListening(unlisten);

    const stop = await subscribing;
    expect(unlisten).toHaveBeenCalledOnce();
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("tauri document port disk watching and recovery drafts", () => {
  beforeEach(() => vi.resetAllMocks());

  it("issues watch and unwatch commands with snake case consumer ids", async () => {
    invoke.mockResolvedValue(undefined);
    const port = createTauriDocumentPort();
    await port.watchDocument("tab-1", "/notes/a.md");
    await port.watchWorkspace("ws-1", "/notes");
    await port.unwatch("tab-1");
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(1, "watch_document", { consumerId: "tab-1", path: "/notes/a.md" });
    expect(invoke).toHaveBeenNthCalledWith(2, "watch_workspace", { consumerId: "ws-1", root: "/notes" });
    expect(invoke).toHaveBeenNthCalledWith(3, "unwatch", { consumerId: "tab-1" });
  });

  it("maps structured watch command errors", async () => {
    invoke.mockRejectedValue({ code: "io", message: "file watching is unavailable" });
    await expect(createTauriDocumentPort().watchDocument("tab-1", "/notes/a.md")).rejects.toMatchObject({ code: "io", message: "file watching is unavailable" });
  });

  it("listens to document-disk-event and maps every payload kind", async () => {
    let handler!: (event: { payload: unknown }) => void;
    const unlisten = vi.fn();
    mocks.listen.mockImplementation(async (_name, value) => { handler = value; return unlisten; });
    const onDiskEvent = vi.fn();

    const stop = await createTauriDocumentPort().subscribeToDiskEvents(onDiskEvent);

    expect(mocks.listen).toHaveBeenCalledWith("document-disk-event", expect.any(Function));
    handler({ payload: { kind: "changed", path: "/notes/a.md", modified_unix_ms: 42, version: "v1" } });
    handler({ payload: { kind: "missing", path: "/notes/b.md" } });
    handler({ payload: { kind: "moved", from: "/notes/c.md", to: "/notes/d.md" } });
    expect(onDiskEvent).toHaveBeenNthCalledWith(1, { kind: "changed", path: "/notes/a.md", modifiedUnixMs: 42, version: "v1" });
    expect(onDiskEvent).toHaveBeenNthCalledWith(2, { kind: "missing", path: "/notes/b.md" });
    expect(onDiskEvent).toHaveBeenNthCalledWith(3, { kind: "moved", from: "/notes/c.md", to: "/notes/d.md" });
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("maps draft info DTOs from list_recovery_drafts", async () => {
    invoke.mockResolvedValue([
      { draft_id: "document-1", original_path: "/notes/a.md", title: "a", saved_text_hash: "h1", saved_version: "v1", updated_unix_ms: 99 },
      { draft_id: "document-2", original_path: null, title: "untitled", saved_text_hash: "h2", saved_version: null, updated_unix_ms: 100 },
    ]);
    const drafts = await createTauriDocumentPort().listDrafts();
    expect(invoke).toHaveBeenCalledWith("list_recovery_drafts");
    expect(drafts).toEqual([
      { draftId: "document-1", originalPath: "/notes/a.md", title: "a", savedTextHash: "h1", savedVersion: "v1", updatedUnixMs: 99 },
      { draftId: "document-2", originalPath: null, title: "untitled", savedTextHash: "h2", savedVersion: null, updatedUnixMs: 100 },
    ]);
  });

  it("passes write_recovery_draft's record as snake case and maps the info result", async () => {
    invoke.mockResolvedValue({ draft_id: "document-1", original_path: "/notes/a.md", title: "a", saved_text_hash: "h1", saved_version: "v1", updated_unix_ms: 7 });
    const info = await createTauriDocumentPort().writeDraft({
      draftId: "document-1",
      originalPath: "/notes/a.md",
      title: "a",
      text: "dirty text",
      hasUtf8Bom: true,
      newline: "cr_lf",
      savedTextHash: "h1",
      savedVersion: "v1",
    });
    expect(invoke).toHaveBeenCalledWith("write_recovery_draft", {
      request: {
        draft_id: "document-1",
        original_path: "/notes/a.md",
        title: "a",
        text: "dirty text",
        has_utf8_bom: true,
        newline: "cr_lf",
        saved_text_hash: "h1",
        saved_version: "v1",
      },
    });
    expect(info).toEqual({ draftId: "document-1", originalPath: "/notes/a.md", title: "a", savedTextHash: "h1", savedVersion: "v1", updatedUnixMs: 7 });
  });

  it("maps the full record from read_recovery_draft", async () => {
    invoke.mockResolvedValue({ draft_id: "document-1", original_path: null, title: "t", text: "body", has_utf8_bom: false, newline: "lf", saved_text_hash: "h", saved_version: null });
    const draft = await createTauriDocumentPort().readDraft("document-1");
    expect(invoke).toHaveBeenCalledWith("read_recovery_draft", { draftId: "document-1" });
    expect(draft).toEqual({ draftId: "document-1", originalPath: null, title: "t", text: "body", hasUtf8Bom: false, newline: "lf", savedTextHash: "h", savedVersion: null });
  });

  it("invokes discard_recovery_draft and maps not_found errors", async () => {
    invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce({ code: "not_found", message: "no recovery draft: x" });
    const port = createTauriDocumentPort();
    await port.discardDraft("document-1");
    expect(invoke).toHaveBeenCalledWith("discard_recovery_draft", { draftId: "document-1" });
    await expect(port.discardDraft("x")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("tauri document port session, window geometry, and close requests", () => {
  const storeMocks = vi.hoisted(() => ({
    values: new Map<string, unknown>(),
    load: vi.fn(),
  }));
  const windowMocks = vi.hoisted(() => ({
    closeHandler: null as null | ((event: { preventDefault(): void }) => Promise<void>),
    destroyed: 0,
    resized: null as null | (() => void),
    moved: null as null | (() => void),
    setSize: vi.fn(),
    setPosition: vi.fn(),
    unlisten: vi.fn(),
    monitors: [{ position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }],
  }));

  vi.mock("@tauri-apps/plugin-store", () => ({
    Store: { load: storeMocks.load },
  }));

  vi.mock("@tauri-apps/api/window", () => ({
    availableMonitors: async () => windowMocks.monitors,
    getCurrentWindow: () => ({
      async onCloseRequested(handler: (event: { preventDefault(): void }) => Promise<void>) {
        windowMocks.closeHandler = handler;
        return windowMocks.unlisten;
      },
      async onResized(handler: () => void) { windowMocks.resized = handler; return windowMocks.unlisten; },
      async onMoved(handler: () => void) { windowMocks.moved = handler; return windowMocks.unlisten; },
      async innerSize() { return { width: 1280, height: 800 }; },
      async outerPosition() { return { x: 10, y: 20 }; },
      setSize: windowMocks.setSize,
      setPosition: windowMocks.setPosition,
      async destroy() { windowMocks.destroyed += 1; },
    }),
    PhysicalSize: class PhysicalSize {
      constructor(readonly width: number, readonly height: number) {}
    },
    PhysicalPosition: class PhysicalPosition {
      constructor(readonly x: number, readonly y: number) {}
    },
  }));

  beforeEach(() => {
    storeMocks.values.clear();
    // Other describes in this file call vi.resetAllMocks(), so the store
    // implementation must be re-applied before every test here.
    storeMocks.load.mockReset();
    storeMocks.load.mockImplementation(async () => ({
      async get(key: string) { return storeMocks.values.get(key) ?? null; },
      async set(key: string, value: unknown) { storeMocks.values.set(key, value); },
      async save() {},
    }));
    windowMocks.closeHandler = null;
    windowMocks.destroyed = 0;
    windowMocks.resized = null;
    windowMocks.moved = null;
    windowMocks.setSize.mockClear();
    windowMocks.setPosition.mockClear();
    windowMocks.unlisten.mockClear();
    windowMocks.monitors = [{ position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }];
  });

  it("returns null when no session was persisted and round-trips a saved session", async () => {
    vi.useFakeTimers();
    try {
      const port = createTauriDocumentPort();
      await expect(port.loadSession()).resolves.toBeNull();

      const session = {
        recent: [{ path: "/notes/a.md", kind: "file" as const }],
        openPaths: ["/notes/a.md"],
        activePath: "/notes/a.md",
        workspacePath: "/notes",
      };
      await port.saveSession(session);
      // Writes are debounced; nothing is persisted until the timer fires.
      expect(storeMocks.values.has("session")).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(storeMocks.values.get("session")).toEqual(session);
      await expect(port.loadSession()).resolves.toEqual(session);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses a burst of session saves into one debounced store write", async () => {
    vi.useFakeTimers();
    try {
      const port = createTauriDocumentPort();
      const sessionFor = (path: string) => ({
        recent: [],
        openPaths: [path],
        activePath: path,
        workspacePath: null,
      });
      await port.saveSession(sessionFor("/notes/a.md"));
      await port.saveSession(sessionFor("/notes/b.md"));
      await port.saveSession(sessionFor("/notes/c.md"));
      // Nothing is written until the burst settles.
      expect(storeMocks.values.has("session")).toBe(false);
      await vi.advanceTimersByTimeAsync(499);
      expect(storeMocks.values.has("session")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // The latest snapshot wins and only one store round trip happened,
      // so an older snapshot can never land after a newer one.
      expect(storeMocks.values.get("session")).toEqual(sessionFor("/notes/c.md"));
      expect(storeMocks.load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(storeMocks.load).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a pending debounced session save before destroying the window", async () => {
    vi.useFakeTimers();
    try {
      const port = createTauriDocumentPort();
      const stop = await port.onCloseRequested(async () => {});
      const session = { recent: [], openPaths: [], activePath: null, workspacePath: null };
      await port.saveSession(session);
      expect(storeMocks.values.has("session")).toBe(false);

      await windowMocks.closeHandler!({ preventDefault: () => {} });

      expect(storeMocks.values.get("session")).toEqual(session);
      expect(windowMocks.destroyed).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the pending session save even when the close-requested handler fails", async () => {
    vi.useFakeTimers();
    try {
      const port = createTauriDocumentPort();
      await port.onCloseRequested(async () => {
        throw new Error("flush failed");
      });
      const session = { recent: [], openPaths: [], activePath: null, workspacePath: null };
      await port.saveSession(session);

      await windowMocks.closeHandler!({ preventDefault: () => {} });

      expect(storeMocks.values.get("session")).toEqual(session);
      expect(windowMocks.destroyed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops malformed entries when loading a session", async () => {
    storeMocks.values.set("session", {
      recent: [
        { path: "/notes/a.md", kind: "file" },
        { path: 42, kind: "file" },
        { path: "/notes", kind: "folder" },
        "garbage",
      ],
      openPaths: ["/notes/a.md", 7],
      activePath: 9,
      workspacePath: "/notes",
    });
    await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
      recent: [
        { path: "/notes/a.md", kind: "file" },
        { path: "/notes", kind: "folder" },
      ],
      openPaths: ["/notes/a.md"],
      activePath: null,
      workspacePath: "/notes",
    });
  });

  it("returns null for a non-object persisted session", async () => {
    storeMocks.values.set("session", "corrupt");
    await expect(createTauriDocumentPort().loadSession()).resolves.toBeNull();
  });

  it("round-trips sidebar preferences and normalizes malformed ones to defaults", async () => {
    vi.useFakeTimers();
    try {
      const port = createTauriDocumentPort();
      const session = {
        recent: [],
        openPaths: [],
        activePath: null,
        workspacePath: null,
        sidebar: { collapsed: true, tabsSectionCollapsed: false, filesSectionCollapsed: true, width: 320 },
      };
      await port.saveSession(session);
      await vi.advanceTimersByTimeAsync(500);
      await expect(port.loadSession()).resolves.toEqual(session);

      storeMocks.values.set("session", {
        recent: [],
        openPaths: [],
        activePath: null,
        workspacePath: null,
        sidebar: { collapsed: "yes", tabsSectionCollapsed: 1, width: "wide" },
      });
      await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
        recent: [],
        openPaths: [],
        activePath: null,
        workspacePath: null,
        sidebar: { collapsed: false, tabsSectionCollapsed: false, filesSectionCollapsed: false, width: 260 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps persisted sidebar width and defaults a missing one", async () => {
    const base = {
      recent: [],
      openPaths: [],
      activePath: null,
      workspacePath: null,
    };
    const sidebar = (width?: number) => ({
      collapsed: false,
      tabsSectionCollapsed: false,
      filesSectionCollapsed: false,
      ...(width !== undefined ? { width } : {}),
    });

    storeMocks.values.set("session", { ...base, sidebar: sidebar(40) });
    await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
      ...base,
      sidebar: { ...sidebar(200) },
    });

    storeMocks.values.set("session", { ...base, sidebar: sidebar(9999) });
    await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
      ...base,
      sidebar: { ...sidebar(480) },
    });

    storeMocks.values.set("session", { ...base, sidebar: sidebar() });
    await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
      ...base,
      sidebar: { ...sidebar(260) },
    });
  });

  it("normalizes the persisted outline width without accepting open state", async () => {
    const base = {
      recent: [],
      openPaths: [],
      activePath: null,
      workspacePath: null,
    };
    storeMocks.values.set("session", {
      ...base,
      outline: { width: 40, open: true },
    });
    await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
      ...base,
      outline: { width: 200 },
    });

    storeMocks.values.set("session", {
      ...base,
      outline: { width: 9999 },
    });
    await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
      ...base,
      outline: { width: 480 },
    });

    storeMocks.values.set("session", {
      ...base,
      outline: { width: "wide" },
    });
    await expect(createTauriDocumentPort().loadSession()).resolves.toEqual({
      ...base,
      outline: { width: 300 },
    });
  });

  it("flushes on close request before destroying the window", async () => {
    const port = createTauriDocumentPort();
    const stop = await port.onCloseRequested(async () => {
      storeMocks.values.set("flushed", true);
    });
    expect(windowMocks.closeHandler).not.toBeNull();

    let prevented = false;
    await windowMocks.closeHandler!({ preventDefault: () => { prevented = true; } });

    expect(prevented).toBe(true);
    expect(storeMocks.values.get("flushed")).toBe(true);
    expect(windowMocks.destroyed).toBe(1);
    stop();
    expect(windowMocks.unlisten).toHaveBeenCalled();
  });

  it("destroys the window even when the close-requested flush fails", async () => {
    const port = createTauriDocumentPort();
    await port.onCloseRequested(async () => {
      throw new Error("flush failed");
    });
    await windowMocks.closeHandler!({ preventDefault: () => {} });
    expect(windowMocks.destroyed).toBe(1);
  });

  it("restores saved window geometry and persists changes debounced", async () => {
    vi.useFakeTimers();
    try {
      storeMocks.values.set("windowGeometry", { width: 900, height: 700, x: 5, y: 6 });
      const stop = await restoreWindowGeometry();

      expect(windowMocks.setSize).toHaveBeenCalledWith(
        expect.objectContaining({ width: 900, height: 700 }),
      );
      expect(windowMocks.setPosition).toHaveBeenCalledWith(
        expect.objectContaining({ x: 5, y: 6 }),
      );
      expect(windowMocks.resized).not.toBeNull();
      expect(windowMocks.moved).not.toBeNull();

      windowMocks.resized!();
      windowMocks.moved!();
      storeMocks.values.delete("windowGeometry");
      await vi.advanceTimersByTimeAsync(499);
      expect(storeMocks.values.has("windowGeometry")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(storeMocks.values.get("windowGeometry")).toEqual({
        width: 1280,
        height: 800,
        x: 10,
        y: 20,
      });

      stop();
      expect(windowMocks.unlisten).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the persisted position when it is off every connected display", async () => {
    storeMocks.values.set("windowGeometry", { width: 900, height: 700, x: 5000, y: 4000 });
    const stop = await restoreWindowGeometry();

    expect(windowMocks.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 900, height: 700 }),
    );
    expect(windowMocks.setPosition).not.toHaveBeenCalled();
    stop();
  });

  it("applies the persisted position when it lands on a connected display", async () => {
    windowMocks.monitors = [
      { position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 } },
      { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
    ];
    storeMocks.values.set("windowGeometry", { width: 900, height: 700, x: -100, y: 50 });
    const stop = await restoreWindowGeometry();

    expect(windowMocks.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: -100, y: 50 }),
    );
    stop();
  });
});

describe("tauri document port translation", () => {
  beforeEach(() => vi.resetAllMocks());

  const settings = {
    endpoint: "https://api.openai.com/v1",
    apiKey: "secret",
    model: "gpt-4o-mini",
    targetLanguage: "中文",
  };

  it("invokes translate_segments with camel case settings and returns translations in order", async () => {
    invoke.mockResolvedValue(["Ｈｅｌｌｏ", "Ｗｏｒｌｄ"]);
    const result = await createTauriDocumentPort().translateSegments(settings, ["Hello", "World"]);
    expect(invoke).toHaveBeenCalledWith("translate_segments", {
      settings: {
        endpoint: "https://api.openai.com/v1",
        apiKey: "secret",
        model: "gpt-4o-mini",
        targetLanguage: "中文",
      },
      segments: ["Hello", "World"],
    });
    expect(result).toEqual(["Ｈｅｌｌｏ", "Ｗｏｒｌｄ"]);
  });

  it("maps structured translate_segments failures", async () => {
    invoke.mockRejectedValue({ code: "io", message: "translation failed" });
    await expect(
      createTauriDocumentPort().translateSegments(settings, ["Hello"]),
    ).rejects.toMatchObject({ code: "io", message: "translation failed" });
  });

  it("maps non-structured failures to io DocumentPortError", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    await expect(
      createTauriDocumentPort().translateSegments(settings, ["Hello"]),
    ).rejects.toMatchObject({ code: "io", message: "boom" });
  });

  it("invokes list_translation_models with a camel case api key", async () => {
    invoke.mockResolvedValue(["gpt-4o", "gpt-4o-mini"]);
    const result = await createTauriDocumentPort().listTranslationModels(
      "https://api.openai.com/v1",
      "secret",
    );
    expect(invoke).toHaveBeenCalledWith("list_translation_models", {
      endpoint: "https://api.openai.com/v1",
      apiKey: "secret",
    });
    expect(result).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("maps structured list_translation_models failures", async () => {
    invoke.mockRejectedValue({ code: "io", message: "listing failed" });
    await expect(
      createTauriDocumentPort().listTranslationModels(
        "https://api.openai.com/v1",
        "secret",
      ),
    ).rejects.toMatchObject({ code: "io", message: "listing failed" });
  });
});
