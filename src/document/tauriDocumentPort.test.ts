import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn(), listen: vi.fn(), emit: vi.fn() }));
const { invoke, open } = mocks;

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emit: mocks.emit }));

import { DocumentPortError } from "./DocumentPort";
import { createTauriDocumentPort, subscribeToOpenPaths } from "./tauriDocumentPort";

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
});
