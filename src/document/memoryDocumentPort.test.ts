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

describe("MemoryDocumentPort disk watching and recovery drafts", () => {
  it("records watch and unwatch calls in order", async () => {
    const port = new MemoryDocumentPort(new Map());
    await port.watchDocument("tab-1", "/notes/a.md");
    await port.watchWorkspace("ws-1", "/notes");
    await port.unwatch("tab-1");
    expect(port.watchCalls).toEqual([
      { kind: "document", consumerId: "tab-1", path: "/notes/a.md" },
      { kind: "workspace", consumerId: "ws-1", root: "/notes" },
      { kind: "unwatch", consumerId: "tab-1" },
    ]);
  });

  it("delivers scripted disk events until unsubscribed", async () => {
    const port = new MemoryDocumentPort(new Map());
    const seen: unknown[] = [];
    const stop = await port.subscribeToDiskEvents((event) => seen.push(event));
    port.emitDiskEvent({ kind: "changed", path: "/notes/a.md", modifiedUnixMs: 5, version: "v" });
    stop();
    port.emitDiskEvent({ kind: "missing", path: "/notes/a.md" });
    expect(seen).toEqual([
      { kind: "changed", path: "/notes/a.md", modifiedUnixMs: 5, version: "v" },
    ]);
  });

  it("round-trips drafts through write, list, read, and discard", async () => {
    const port = new MemoryDocumentPort(new Map());
    const draft = {
      draftId: "document-1",
      originalPath: "/notes/a.md",
      title: "a",
      text: "dirty",
      hasUtf8Bom: true,
      newline: "cr_lf" as const,
      savedTextHash: "h1",
      savedVersion: "v1",
    };
    const info = await port.writeDraft(draft);
    expect(info).toMatchObject({ draftId: "document-1", savedTextHash: "h1" });
    await expect(port.listDrafts()).resolves.toEqual([info]);
    await expect(port.readDraft("document-1")).resolves.toEqual(draft);
    await port.discardDraft("document-1");
    await expect(port.listDrafts()).resolves.toEqual([]);
    await expect(port.discardDraft("document-1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("serves pre-seeded drafts as restart leftovers", async () => {
    const leftover = {
      draftId: "document-9",
      originalPath: null,
      title: "untitled",
      text: "unsaved",
      hasUtf8Bom: false,
      newline: "lf" as const,
      savedTextHash: "h9",
      savedVersion: null,
    };
    const port = new MemoryDocumentPort(new Map(), { drafts: [leftover] });
    await expect(port.readDraft("document-9")).resolves.toEqual(leftover);
    await expect(port.listDrafts()).resolves.toHaveLength(1);
    await expect(port.readDraft("ghost")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("MemoryDocumentPort session and close requests", () => {
  it("returns null before any session is saved and clones what it stores", async () => {
    const port = new MemoryDocumentPort(new Map());
    await expect(port.loadSession()).resolves.toBeNull();

    const session = {
      recent: [{ path: "/notes/a.md", kind: "file" as const }],
      openPaths: ["/notes/a.md"],
      activePath: "/notes/a.md",
      workspacePath: null,
    };
    await port.saveSession(session);

    const loaded = await port.loadSession();
    expect(loaded).toEqual(session);
    expect(loaded).not.toBe(session);
    expect(loaded?.recent).not.toBe(session.recent);
  });

  it("serves a pre-seeded session as a restart leftover", async () => {
    const session = {
      recent: [
        { path: "/notes/a.md", kind: "file" as const },
        { path: "/notes", kind: "folder" as const },
      ],
      openPaths: ["/notes/a.md"],
      activePath: "/notes/a.md",
      workspacePath: "/notes",
    };
    const port = new MemoryDocumentPort(new Map(), { session });
    await expect(port.loadSession()).resolves.toEqual(session);
    expect(port.session).toEqual(session);
  });

  it("exposes the stored session through the session getter as a clone", async () => {
    const port = new MemoryDocumentPort(new Map());
    const session = {
      recent: [],
      openPaths: ["/notes/a.md"],
      activePath: null,
      workspacePath: null,
    };
    await port.saveSession(session);

    const stored = port.session;
    expect(stored).toEqual(session);
    expect(stored?.openPaths).not.toBe(session.openPaths);
  });

  it("runs close-requested handlers in order until unsubscribed", async () => {
    const port = new MemoryDocumentPort(new Map());
    const calls: string[] = [];
    const stopFirst = await port.onCloseRequested(() => {
      calls.push("first");
    });
    await port.onCloseRequested(async () => {
      await Promise.resolve();
      calls.push("second");
    });

    await port.emitCloseRequested();
    expect(calls).toEqual(["first", "second"]);

    stopFirst();
    await port.emitCloseRequested();
    expect(calls).toEqual(["first", "second", "second"]);
  });
});
