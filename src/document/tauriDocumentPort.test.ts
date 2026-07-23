import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn(), listen: vi.fn(), emit: vi.fn(), convertFileSrc: vi.fn() }));
const { invoke, open } = mocks;

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: mocks.convertFileSrc }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emit: mocks.emit }));

import { DocumentPortError } from "./DocumentPort";
import { createTauriDocumentPort, subscribeToOpenPaths, tauriImagePreviewUrl } from "./tauriDocumentPort";

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
      expect(invoke).toHaveBeenCalledWith("save_clipboard_image", {
        path: "/notes/image-20260723-090507.png",
        bytes: [137, 80, 78, 71],
        mime_type: "image/png",
      });
      expect(result).toBe("image-20260723-090507.png");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a jpeg extension and returns an absolute path outside the document directory", async () => {
    mocks.save.mockResolvedValue("/elsewhere/pic.jpg");
    invoke.mockResolvedValue(undefined);
    const port = createTauriDocumentPort();
    const result = await port.saveClipboardImage({
      bytes: new Uint8Array([255, 216]),
      mimeType: "image/jpeg",
      documentPath: "/notes/a.md",
    });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: expect.stringMatching(/^\/notes\/image-\d{8}-\d{6}\.jpg$/),
    }));
    expect(invoke).toHaveBeenCalledWith("save_clipboard_image", {
      path: "/elsewhere/pic.jpg",
      bytes: [255, 216],
      mime_type: "image/jpeg",
    });
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
    expect(invoke).toHaveBeenNthCalledWith(1, "acquire_document_scope", { consumer_id: "tab-1", path: "/notes/a.md" });
    expect(invoke).toHaveBeenNthCalledWith(2, "acquire_workspace_scope", { consumer_id: "ws-1", root: "/notes" });
    expect(invoke).toHaveBeenNthCalledWith(3, "release_asset_scope", { consumer_id: "tab-1" });
  });

  it("exposes convertFileSrc through the preview URL helper", () => {
    mocks.convertFileSrc.mockReturnValue("asset://localhost/notes/pic.png");
    expect(tauriImagePreviewUrl("/notes/pic.png")).toBe("asset://localhost/notes/pic.png");
    expect(mocks.convertFileSrc).toHaveBeenCalledWith("/notes/pic.png");
  });
});
