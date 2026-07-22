import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open, save: vi.fn() }));

import { DocumentPortError } from "./DocumentPort";
import { createTauriDocumentPort } from "./tauriDocumentPort";

describe("tauri document port", () => {
  beforeEach(() => vi.clearAllMocks());

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
});
