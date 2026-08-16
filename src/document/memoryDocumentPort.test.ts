import { describe, expect, it } from "vitest";
import { MemoryDocumentPort } from "./memoryDocumentPort";
import type { OpenedFile } from "./types";

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
      outline: { width: 336 },
    };
    await port.saveSession(session);

    const loaded = await port.loadSession();
    expect(loaded).toEqual(session);
    expect(loaded).not.toBe(session);
    expect(loaded?.recent).not.toBe(session.recent);
    expect(loaded?.outline).not.toBe(session.outline);
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

  it("clones translation settings when storing and loading a session", async () => {
    const port = new MemoryDocumentPort(new Map());
    const settings = {
      endpoint: "https://api.openai.com/v1",
      apiKey: "secret",
      model: "gpt-4o-mini",
      targetLanguage: "中文",
      concurrency: 10,
    };
    const session = {
      recent: [],
      openPaths: [],
      activePath: null,
      workspacePath: null,
      translationSettings: settings,
    };
    await port.saveSession(session);

    const loaded = await port.loadSession();
    expect(loaded).toEqual(session);
    expect(loaded?.translationSettings).not.toBe(settings);
  });

  it("flushSession resolves immediately without discarding the stored session", async () => {
    const port = new MemoryDocumentPort(new Map());
    const session = {
      recent: [],
      openPaths: ["/notes/a.md"],
      activePath: null,
      workspacePath: null,
    };
    await port.saveSession(session);
    // saveSession stores synchronously, so the explicit flush is a no-op
    // that still resolves and never discards what was saved.
    await expect(port.flushSession()).resolves.toBeUndefined();
    await expect(port.loadSession()).resolves.toEqual(session);
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

describe("MemoryDocumentPort translation", () => {
  const settings = {
    endpoint: "https://api.openai.com/v1",
    apiKey: "secret",
    model: "gpt-4o-mini",
    targetLanguage: "中文",
    concurrency: 10,
  };

  it("fake-translates every requested segment in order", async () => {
    const port = new MemoryDocumentPort(new Map());
    const result = await port.translateSegments(settings, ["Hello", "World"]);
    expect(result).toEqual(["Ｈｅｌｌｏ", "Ｗｏｒｌｄ"]);
    expect(port.translationCallCount).toBe(1);
    expect(port.translationRequestedSegments).toBe(2);
  });

  it("serves repeated batches from cache without counting new requests", async () => {
    const port = new MemoryDocumentPort(new Map());
    const first = await port.translateSegments(settings, ["Hello", "World"]);
    const second = await port.translateSegments(settings, ["Hello", "World"]);
    expect(first).toEqual(second);
    expect(port.translationCallCount).toBe(1);
    expect(port.translationRequestedSegments).toBe(2);
  });

  it("keeps cache entries distinct per model, target language, and text", async () => {
    const port = new MemoryDocumentPort(new Map());
    const chinese = await port.translateSegments(settings, ["Hello"]);
    const japanese = await port.translateSegments(
      { ...settings, targetLanguage: "日本語" },
      ["Hello"],
    );
    const otherModel = await port.translateSegments(
      { ...settings, model: "gpt-4o" },
      ["Hello"],
    );
    const otherText = await port.translateSegments(settings, ["World"]);
    expect(chinese).toEqual(["Ｈｅｌｌｏ"]);
    expect(japanese).toEqual(["Ｈｅｌｌｏ"]);
    expect(otherModel).toEqual(["Ｈｅｌｌｏ"]);
    expect(otherText).toEqual(["Ｗｏｒｌｄ"]);
    expect(port.translationCallCount).toBe(4);
    expect(port.translationRequestedSegments).toBe(4);
  });

  it("returns a clone so callers cannot mutate the cached result", async () => {
    const port = new MemoryDocumentPort(new Map());
    const first = await port.translateSegments(settings, ["Hello"]);
    first[0] = "mutated";
    const second = await port.translateSegments(settings, ["Hello"]);
    expect(second).toEqual(["Ｈｅｌｌｏ"]);
    expect(port.translationCallCount).toBe(1);
  });

  it("records listTranslationModels calls and serves the fixed model list", async () => {
    const port = new MemoryDocumentPort(new Map());
    const models = await port.listTranslationModels(
      "https://api.openai.com/v1",
      "secret-key",
    );
    // Deliberately unsorted so dialogs that sort by display are exercised.
    expect(models).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(port.translationModelCalls).toEqual([
      { endpoint: "https://api.openai.com/v1", apiKey: "secret-key" },
    ]);
  });

  it("returns a clone of the model list so callers cannot mutate it", async () => {
    const port = new MemoryDocumentPort(new Map());
    const first = await port.listTranslationModels("https://api.openai.com/v1", "k");
    first[0] = "mutated";
    const second = await port.listTranslationModels("https://api.openai.com/v1", "k");
    expect(second).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(port.translationModelCalls).toHaveLength(2);
  });
});

describe("MemoryDocumentPort workspace operations", () => {
  const openedFile = (path: string): OpenedFile => ({
    path,
    text: "saved",
    hasUtf8Bom: false,
    newline: "lf",
    modifiedUnixMs: 100,
    version: "v1",
  });

  it("refuses to rename a file onto an existing directory name", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile("/notes/a.md")]]),
      { directories: ["/notes/sub.md"], pathPlatform: "linux" },
    );
    await expect(port.renameEntry("/notes", "a.md", "sub.md")).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("rejects renaming a file out of its Markdown extension", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile("/notes/a.md")]]),
      { pathPlatform: "linux" },
    );
    await expect(port.renameEntry("/notes", "a.md", "a.txt")).rejects.toMatchObject({
      code: "io",
    });
  });

  it("treats renaming a file to its own name as a no-op success", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile("/notes/a.md")]]),
      { pathPlatform: "linux" },
    );
    await expect(port.renameEntry("/notes", "a.md", "a.md")).resolves.toEqual({
      name: "a.md",
      path: "/notes/a.md",
      isDirectory: false,
    });
    await expect(port.openPath("/notes/a.md")).resolves.toMatchObject({ text: "saved" });
  });

  it("treats renaming a directory to its own name as a no-op success", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      directories: ["/notes/sub"],
      pathPlatform: "linux",
    });
    await expect(port.renameEntry("/notes", "sub", "sub")).resolves.toEqual({
      name: "sub",
      path: "/notes/sub",
      isDirectory: true,
    });
  });

  it("refuses to create a Markdown file that collides with a directory", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      directories: ["/notes/new.md"],
      pathPlatform: "linux",
    });
    await expect(port.createMarkdownFile("/notes", "new.md")).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("filters hidden entries out of directory listings", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/visible.md", openedFile("/notes/visible.md")],
        ["/notes/.hidden.md", openedFile("/notes/.hidden.md")],
        ["/notes/sub/inside.md", openedFile("/notes/sub/inside.md")],
      ]),
      { directories: ["/notes/.git", "/notes/sub"], pathPlatform: "linux" },
    );
    await expect(port.listDirectory("/notes", "")).resolves.toEqual([
      { name: "sub", path: "/notes/sub", isDirectory: true },
      { name: "visible.md", path: "/notes/visible.md", isDirectory: false },
    ]);
  });

  it("rejects trashing the workspace root with permission_denied", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile("/notes/a.md")]]),
      { workspace: { path: "/notes", title: "notes" }, pathPlatform: "linux" },
    );
    await expect(port.trashEntry("/notes", "")).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(port.openPath("/notes/a.md")).resolves.toMatchObject({
      path: "/notes/a.md",
    });
  });

  it("keeps the files that opened and skips missing ones in chooseAndOpenFiles", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile("/notes/a.md")]]),
      {
        chosenPaths: ["/notes/a.md", "/notes/missing.md"],
        pathPlatform: "linux",
      },
    );
    await expect(port.chooseAndOpenFiles()).resolves.toEqual([
      expect.objectContaining({ path: "/notes/a.md" }),
    ]);
  });

  it("clones the workspace option instead of holding it by reference", async () => {
    const workspace = { path: "/notes", title: "notes" };
    const port = new MemoryDocumentPort(new Map(), { workspace });
    workspace.title = "mutated";
    const chosen = await port.chooseWorkspace();
    expect(chosen).toEqual({ path: "/notes", title: "notes" });
    Reflect.set(chosen!, "title", "mutated again");
    expect(await port.chooseWorkspace()).toEqual({
      path: "/notes",
      title: "notes",
    });
  });
});
