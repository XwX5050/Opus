import { describe, expect, it } from "vitest";
import { MemoryDocumentPort } from "./memoryDocumentPort";

describe("MemoryDocumentPort clipboard images and asset scopes", () => {
  it("records clipboard image saves with copied bytes and returns the configured path", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      clipboardImagePath: "assets/pasted.png",
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await port.saveClipboardImage({
      bytes,
      mimeType: "image/png",
      documentPath: "/notes/a.md",
    });
    expect(result).toBe("assets/pasted.png");
    expect(port.clipboardImageSaves).toHaveLength(1);
    expect(port.clipboardImageSaves[0]).toMatchObject({
      mimeType: "image/png",
      documentPath: "/notes/a.md",
    });
    bytes[0] = 99;
    expect([...port.clipboardImageSaves[0].bytes]).toEqual([1, 2, 3]);
  });

  it("defaults the clipboard image result to cancel and clones the recorded input", async () => {
    const port = new MemoryDocumentPort(new Map());
    await expect(
      port.saveClipboardImage({
        bytes: new Uint8Array([7]),
        mimeType: "image/jpeg",
        documentPath: null,
      }),
    ).resolves.toBeNull();
    const recorded = port.clipboardImageSaves[0];
    recorded.bytes[0] = 1;
    expect(port.clipboardImageSaves[0].bytes[0]).toBe(7);
  });

  it("records scope acquire and release calls in order", async () => {
    const port = new MemoryDocumentPort(new Map());
    await port.acquireDocumentScope("tab-1", "/notes/a.md");
    await port.acquireDocumentScope("tab-2", "/notes/b.md");
    await port.acquireWorkspaceScope("ws-1", "/notes");
    await port.releaseAssetScope("tab-1");
    expect(port.scopeCalls).toEqual([
      { kind: "document", consumerId: "tab-1", path: "/notes/a.md" },
      { kind: "document", consumerId: "tab-2", path: "/notes/b.md" },
      { kind: "workspace", consumerId: "ws-1", root: "/notes" },
      { kind: "release", consumerId: "tab-1" },
    ]);
  });
});
