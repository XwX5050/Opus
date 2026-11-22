import { describe, expect, it } from "vitest";
import { DocumentPortError } from "./DocumentPort";
import {
  decideDiskEvent,
  findTabByPath,
  isReadCommitCurrent,
  parentPathKey,
  readCurrentDiskVersion,
  type DiskReadHost,
  type DiskReadRequest,
} from "./externalChanges";
import type {
  DiskEvent,
  DocumentSnapshot,
  DocumentState,
  OpenedFile,
  PathPlatform,
  PendingWriteRequest,
} from "./types";

const MACOS: PathPlatform = "macos";
const WINDOWS: PathPlatform = "windows";
const LINUX: PathPlatform = "linux";

const snapshot = (
  id: string,
  overrides: Partial<DocumentSnapshot> = {},
): DocumentSnapshot => ({
  id,
  path: `/notes/${id}.md`,
  title: `${id}.md`,
  text: "saved",
  savedText: "saved",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 100,
  version: "v1",
  status: "clean",
  ...overrides,
});

const stateOf = (...tabs: ReadonlyArray<DocumentSnapshot>): DocumentState => ({
  tabs,
  activeId: tabs[0]?.id ?? null,
  recentlyClosed: [],
  nextSaveSequence: 0,
});

const openedFile = (overrides: Partial<OpenedFile> = {}): OpenedFile => ({
  path: "/notes/doc-1.md",
  text: "fresh",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 200,
  version: "v2",
  ...overrides,
});

const pendingSave = (
  overrides: Partial<PendingWriteRequest> = {},
): PendingWriteRequest => ({
  requestId: "save-1",
  documentId: "doc-1",
  targetPath: "/notes/doc-1.md",
  text: "updated",
  hasUtf8Bom: false,
  newline: "lf",
  expectedVersion: "v1",
  pathPlatform: "macos",
  ...overrides,
});

const changed = (path: string, version = "v2"): DiskEvent => ({
  kind: "changed",
  path,
  modifiedUnixMs: 200,
  version,
});

const missing = (path: string): DiskEvent => ({ kind: "missing", path });

const moved = (from: string, to: string): DiskEvent => ({
  kind: "moved",
  from,
  to,
});

const request = (
  overrides: Partial<DiskReadRequest> = {},
): DiskReadRequest => ({
  tabId: "doc-1",
  path: "/notes/doc-1.md",
  expectedVersion: "v1",
  generation: 7,
  purpose: "watch",
  ...overrides,
});

const deferred = <T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const host = (
  openPath: DiskReadHost["openPath"],
  getState: DiskReadHost["getState"],
  getGeneration: DiskReadHost["getGeneration"],
  pathPlatform: PathPlatform,
): DiskReadHost => ({
  openPath,
  getState,
  getGeneration,
  pathPlatform,
});

describe("findTabByPath", () => {
  it("finds a tab through the platform's normalized path key", () => {
    const tab = snapshot("doc-1", { path: "/users/alice/notes/readme.md" });

    expect(
      findTabByPath(
        stateOf(tab),
        "/Users/Alice/Notes/./README.md",
        MACOS,
      ),
    ).toBe(tab);
  });

  it("does not match differently cased paths on linux", () => {
    const state = stateOf(snapshot("doc-1", { path: "/notes/readme.md" }));

    expect(
      findTabByPath(state, "/notes/README.md", LINUX),
    ).toBeUndefined();
  });

  it("matches windows separators and drive-letter case", () => {
    const tab = snapshot("doc-1", { path: "C:\\Notes\\A.md" });

    expect(
      findTabByPath(stateOf(tab), "c:/notes/./a.md", WINDOWS),
    ).toBe(tab);
  });

  it("ignores untitled tabs and unknown paths", () => {
    expect(
      findTabByPath(
        stateOf(snapshot("doc-1", { path: null })),
        "/notes/doc-1.md",
        MACOS,
      ),
    ).toBeUndefined();
    expect(
      findTabByPath(stateOf(snapshot("doc-1")), "/notes/other.md", MACOS),
    ).toBeUndefined();
  });
});

describe("parentPathKey", () => {
  it("uses one normalized key for files in the same directory", () => {
    expect(parentPathKey("/Users/Alice/Notes/a.md", MACOS)).toBe(
      parentPathKey("/Users/Alice/Notes/b.md", MACOS),
    );
    expect(parentPathKey("/Users/Alice/Notes/a.md", MACOS)).toBe(
      "/users/alice/notes",
    );
  });

  it("distinguishes different directories", () => {
    expect(parentPathKey("/Users/Alice/Notes/a.md", MACOS)).not.toBe(
      parentPathKey("/Users/Alice/Archive/a.md", MACOS),
    );
  });

  it("returns the root key for a file at the root", () => {
    expect(parentPathKey("/readme.md", MACOS)).toBe("/");
  });

  it("normalizes windows separators and drive letters", () => {
    expect(parentPathKey("C:\\Notes\\a.md", WINDOWS)).toBe(
      parentPathKey("c:/notes/./b.md", WINDOWS),
    );
    expect(parentPathKey("C:\\Notes\\a.md", WINDOWS)).not.toBe(
      parentPathKey("C:\\Archive\\a.md", WINDOWS),
    );
  });

  it("keeps linux parent keys case-sensitive", () => {
    expect(parentPathKey("/Notes/a.md", LINUX)).not.toBe(
      parentPathKey("/notes/a.md", LINUX),
    );
  });
});

describe("isReadCommitCurrent", () => {
  it("accepts a matching tab when the path normalizes equal", () => {
    const state = stateOf(snapshot("doc-1", { path: "/Notes/Doc-1.md" }));

    expect(
      isReadCommitCurrent(
        state,
        request({ path: "/notes/./doc-1.md" }),
        7,
        MACOS,
      ),
    ).toBe(true);
  });

  it("rejects a tab whose version changed during the read", () => {
    const state = stateOf(snapshot("doc-1", { version: "v2" }));

    expect(isReadCommitCurrent(state, request(), 7, MACOS)).toBe(false);
  });

  it("rejects a read from an older lifecycle generation", () => {
    const state = stateOf(snapshot("doc-1"));

    expect(
      isReadCommitCurrent(state, request({ generation: 6 }), 7, MACOS),
    ).toBe(false);
  });

  it("rejects a tab retargeted by Save As or rename", () => {
    const state = stateOf(snapshot("doc-1", { path: "/notes/renamed.md" }));

    expect(isReadCommitCurrent(state, request(), 7, MACOS)).toBe(false);
  });

  it("rejects closed and untitled tabs", () => {
    expect(isReadCommitCurrent(stateOf(), request(), 7, MACOS)).toBe(false);
    expect(
      isReadCommitCurrent(
        stateOf(snapshot("doc-1", { path: null, version: null })),
        request({ expectedVersion: null }),
        7,
        MACOS,
      ),
    ).toBe(false);
  });

  it("accepts windows alias spellings in the commit guard", () => {
    const state = stateOf(snapshot("doc-1", { path: "C:\\Notes\\A.md" }));

    expect(
      isReadCommitCurrent(
        state,
        request({ path: "c:/notes/./a.md" }),
        7,
        WINDOWS,
      ),
    ).toBe(true);
  });

  it("rejects case-only aliases on linux", () => {
    const state = stateOf(snapshot("doc-1", { path: "/notes/a.md" }));

    expect(
      isReadCommitCurrent(
        state,
        request({ path: "/notes/A.md" }),
        7,
        LINUX,
      ),
    ).toBe(false);
  });
});

describe("decideDiskEvent", () => {
  it("reloads a changed tab with the guard captured before the read", () => {
    const tab = snapshot("doc-1", { version: "v1" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        changed("/Notes/DOC-1.md", "v2"),
        MACOS,
      ),
    ).toEqual({
      kind: "reload",
      tabId: "doc-1",
      path: "/notes/doc-1.md",
      expectedVersion: "v1",
    });
  });

  it("reloads a dirty tab so the reducer can surface a conflict", () => {
    const tab = snapshot("doc-1", { status: "dirty", text: "local edit" });

    expect(
      decideDiskEvent(stateOf(tab), changed("/notes/doc-1.md"), MACOS),
    ).toEqual({
      kind: "reload",
      tabId: "doc-1",
      path: "/notes/doc-1.md",
      expectedVersion: "v1",
    });
  });

  it("does not treat a null tab version as a self-save echo", () => {
    const tab = snapshot("doc-1", { version: null });

    expect(
      decideDiskEvent(stateOf(tab), changed("/notes/doc-1.md", "v1"), MACOS),
    ).toEqual({
      kind: "reload",
      tabId: "doc-1",
      path: "/notes/doc-1.md",
      expectedVersion: null,
    });
  });

  it("ignores changed events for unknown paths", () => {
    expect(
      decideDiskEvent(
        stateOf(snapshot("doc-1")),
        changed("/notes/other.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "unknown-path" });
  });

  it("ignores changed events while a save is pending", () => {
    const tab = snapshot("doc-1", { pendingSave: pendingSave() });

    expect(
      decideDiskEvent(stateOf(tab), changed("/notes/doc-1.md"), MACOS),
    ).toEqual({ kind: "ignore", reason: "pending-save" });
  });

  it("ignores the version echo of our own completed save", () => {
    const tab = snapshot("doc-1", { version: "v2" });

    expect(
      decideDiskEvent(stateOf(tab), changed("/notes/doc-1.md", "v2"), MACOS),
    ).toEqual({ kind: "ignore", reason: "self-save-echo" });
  });

  it("ignores the echo even when the tab became dirty again", () => {
    const tab = snapshot("doc-1", { version: "v2", status: "dirty" });

    expect(
      decideDiskEvent(stateOf(tab), changed("/notes/doc-1.md", "v2"), MACOS),
    ).toEqual({ kind: "ignore", reason: "self-save-echo" });
  });

  it("marks a dirty tab missing when its file disappears", () => {
    const tab = snapshot("doc-1", { status: "dirty", text: "local edit" });

    expect(
      decideDiskEvent(stateOf(tab), missing("/notes/doc-1.md"), MACOS),
    ).toEqual({ kind: "missing", tabId: "doc-1" });
  });

  it("marks a tab missing on a missing event", () => {
    expect(
      decideDiskEvent(
        stateOf(snapshot("doc-1")),
        missing("/notes/doc-1.md"),
        MACOS,
      ),
    ).toEqual({ kind: "missing", tabId: "doc-1" });
  });

  it("ignores missing events for unknown paths and pending saves", () => {
    const pending = snapshot("doc-1", { pendingSave: pendingSave() });

    expect(
      decideDiskEvent(stateOf(pending), missing("/notes/other.md"), MACOS),
    ).toEqual({ kind: "ignore", reason: "unknown-path" });
    expect(
      decideDiskEvent(
        stateOf(pending),
        missing("/notes/doc-1.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "pending-save" });
  });

  it("moves a clean tab within its directory without a scope change", () => {
    const tab = snapshot("doc-1", { path: "/notes/a.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/a.md", "/notes/b.md"),
        MACOS,
      ),
    ).toEqual({
      kind: "moved",
      tabId: "doc-1",
      previousPath: "/notes/a.md",
      from: "/notes/a.md",
      to: "/notes/b.md",
      scopeChanged: false,
    });
  });

  it("reports a scope change when a clean tab moves across directories", () => {
    const tab = snapshot("doc-1", { path: "/notes/a.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/a.md", "/archive/a.md"),
        MACOS,
      ),
    ).toEqual({
      kind: "moved",
      tabId: "doc-1",
      previousPath: "/notes/a.md",
      from: "/notes/a.md",
      to: "/archive/a.md",
      scopeChanged: true,
    });
  });

  it("reports the tab's previous path when event.from is a case alias", () => {
    const tab = snapshot("doc-1", { path: "/Notes/Caf\u00e9/a.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/caf\u00e9/./a.md", "/Notes/Caf\u00e9/b.md"),
        MACOS,
      ),
    ).toEqual({
      kind: "moved",
      tabId: "doc-1",
      previousPath: "/Notes/Caf\u00e9/a.md",
      from: "/notes/caf\u00e9/./a.md",
      to: "/Notes/Caf\u00e9/b.md",
      scopeChanged: false,
    });
  });

  it("reports the tab's previous path when event.from is a unicode alias", () => {
    const tab = snapshot("doc-1", { path: "/Notes/Cafe\u0301/a.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved(
          "/notes/Caf\u00e9/./a.md",
          "/Archive/Caf\u00e9/a.md",
        ),
        MACOS,
      ),
    ).toEqual({
      kind: "moved",
      tabId: "doc-1",
      previousPath: "/Notes/Cafe\u0301/a.md",
      from: "/notes/Caf\u00e9/./a.md",
      to: "/Archive/Caf\u00e9/a.md",
      scopeChanged: true,
    });
  });

  it("does not follow moves for dirty, conflicted, or missing tabs", () => {
    for (const status of ["dirty", "conflict", "missing"] as const) {
      const tab = snapshot("doc-1", { path: "/notes/a.md", status });
      expect(
        decideDiskEvent(
          stateOf(tab),
          moved("/notes/a.md", "/notes/b.md"),
          MACOS,
        ),
      ).toEqual({ kind: "ignore", reason: "not-clean" });
    }
  });

  it("ignores moves while a save is pending", () => {
    const tab = snapshot("doc-1", {
      path: "/notes/a.md",
      pendingSave: pendingSave(),
    });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/a.md", "/notes/b.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "pending-save" });
  });

  it("ignores moves from unknown paths and case-only moves", () => {
    const tab = snapshot("doc-1", { path: "/notes/a.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/unknown.md", "/notes/b.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "unknown-path" });
    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/A.md", "/notes/a.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "same-path" });
  });

  it("reloads the open target of an atomic replace", () => {
    const tab = snapshot("doc-1", { path: "/notes/doc.md", version: "v1" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/.doc.md.tmp-123", "/notes/doc.md"),
        MACOS,
      ),
    ).toEqual({
      kind: "reload",
      tabId: "doc-1",
      path: "/notes/doc.md",
      expectedVersion: "v1",
    });
  });

  it("reloads a dirty atomic-replace target so the reducer can conflict", () => {
    const tab = snapshot("doc-1", {
      path: "/notes/doc.md",
      status: "dirty",
      text: "local edit",
    });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/.doc.md.tmp-123", "/notes/doc.md"),
        MACOS,
      ),
    ).toEqual({
      kind: "reload",
      tabId: "doc-1",
      path: "/notes/doc.md",
      expectedVersion: "v1",
    });
  });

  it("ignores an atomic replace whose target has a pending save", () => {
    const tab = snapshot("doc-1", {
      path: "/notes/doc.md",
      status: "dirty",
      pendingSave: pendingSave({ targetPath: "/notes/doc.md" }),
    });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/.doc.md.tmp-123", "/notes/doc.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "pending-save" });
  });

  it("ignores an atomic replace whose target is not open", () => {
    const tab = snapshot("doc-1", { path: "/notes/doc.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/.other.md.tmp", "/notes/other.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "unknown-path" });
  });

  it("matches an atomic-replace target through windows normalization", () => {
    const tab = snapshot("doc-1", { path: "C:\\Notes\\A.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("C:\\Notes\\.a.md.tmp", "c:/notes/./a.md"),
        WINDOWS,
      ),
    ).toEqual({
      kind: "reload",
      tabId: "doc-1",
      path: "C:\\Notes\\A.md",
      expectedVersion: "v1",
    });
  });

  it("matches an atomic-replace target through unicode normalization", () => {
    const tab = snapshot("doc-1", { path: "/Notes/Cafe\u0301/a.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/Notes/.a.md.tmp", "/notes/Caf\u00e9/./a.md"),
        MACOS,
      ),
    ).toEqual({
      kind: "reload",
      tabId: "doc-1",
      path: "/Notes/Cafe\u0301/a.md",
      expectedVersion: "v1",
    });
  });

  it("does not match a case-only atomic-replace target on linux", () => {
    const tab = snapshot("doc-1", { path: "/notes/a.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("/notes/.a.md.tmp", "/notes/A.md"),
        LINUX,
      ),
    ).toEqual({ kind: "ignore", reason: "unknown-path" });
  });

  it("keeps moved semantics when the source is an open tab", () => {
    const source = snapshot("temp", { path: "/notes/temp.md" });
    const target = snapshot("doc-1", { path: "/notes/doc.md" });

    expect(
      decideDiskEvent(
        stateOf(source, target),
        moved("/notes/temp.md", "/notes/doc.md"),
        MACOS,
      ),
    ).toEqual({
      kind: "moved",
      tabId: "temp",
      previousPath: "/notes/temp.md",
      from: "/notes/temp.md",
      to: "/notes/doc.md",
      scopeChanged: false,
    });
  });

  it("falls back to an open target when a non-clean source does not move", () => {
    const target = snapshot("doc-1", { path: "/notes/doc.md" });

    for (const status of ["dirty", "conflict", "missing"] as const) {
      const source = snapshot("temp", {
        path: "/notes/temp.md",
        status,
        text: "local edit",
      });

      expect(
        decideDiskEvent(
          stateOf(source, target),
          moved("/notes/temp.md", "/notes/doc.md"),
          MACOS,
        ),
      ).toEqual({
        kind: "reload",
        tabId: "doc-1",
        path: "/notes/doc.md",
        expectedVersion: "v1",
      });
    }
  });

  it("ignores a non-clean source move when the target is not open", () => {
    const source = snapshot("temp", {
      path: "/notes/temp.md",
      status: "dirty",
      text: "local edit",
    });

    expect(
      decideDiskEvent(
        stateOf(source),
        moved("/notes/temp.md", "/notes/doc.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "not-clean" });
  });

  it("does not fall back when the source has a pending save", () => {
    const source = snapshot("temp", {
      path: "/notes/temp.md",
      pendingSave: pendingSave({
        documentId: "temp",
        targetPath: "/notes/temp.md",
      }),
    });
    const target = snapshot("doc-1", { path: "/notes/doc.md" });

    expect(
      decideDiskEvent(
        stateOf(source, target),
        moved("/notes/temp.md", "/notes/doc.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "pending-save" });
  });

  it("ignores a non-clean fallback when the target has a pending save", () => {
    const source = snapshot("temp", {
      path: "/notes/temp.md",
      status: "dirty",
      text: "local edit",
    });
    const target = snapshot("doc-1", {
      path: "/notes/doc.md",
      pendingSave: pendingSave({ targetPath: "/notes/doc.md" }),
    });

    expect(
      decideDiskEvent(
        stateOf(source, target),
        moved("/notes/temp.md", "/notes/doc.md"),
        MACOS,
      ),
    ).toEqual({ kind: "ignore", reason: "pending-save" });
  });

  it("matches windows alias spellings for changed events", () => {
    const tab = snapshot("doc-1", { path: "C:\\Notes\\A.md" });

    expect(
      decideDiskEvent(stateOf(tab), changed("c:/notes/./a.md"), WINDOWS),
    ).toEqual({
      kind: "reload",
      tabId: "doc-1",
      path: "C:\\Notes\\A.md",
      expectedVersion: "v1",
    });
  });

  it("does not match case-only changed paths on linux", () => {
    const tab = snapshot("doc-1", { path: "/notes/a.md" });

    expect(
      decideDiskEvent(stateOf(tab), changed("/notes/A.md"), LINUX),
    ).toEqual({ kind: "ignore", reason: "unknown-path" });
  });

  it("computes windows move scope changes from the tab's previous path", () => {
    const tab = snapshot("doc-1", { path: "C:\\Notes\\A.md" });

    expect(
      decideDiskEvent(
        stateOf(tab),
        moved("c:/notes/./a.md", "C:\\Archive\\a.md"),
        WINDOWS,
      ),
    ).toEqual({
      kind: "moved",
      tabId: "doc-1",
      previousPath: "C:\\Notes\\A.md",
      from: "c:/notes/./a.md",
      to: "C:\\Archive\\a.md",
      scopeChanged: true,
    });
  });

  it("does not mutate the state it reads", () => {
    const tab = snapshot("doc-1");
    const tabs = [tab];
    const state: DocumentState = {
      tabs,
      activeId: "doc-1",
      recentlyClosed: [],
      nextSaveSequence: 0,
    };

    decideDiskEvent(state, changed("/notes/doc-1.md"), MACOS);

    expect(state.tabs).toBe(tabs);
    expect(state.tabs[0]).toBe(tab);
  });
});

describe("readCurrentDiskVersion", () => {
  it("returns the loaded file while the tab guard is current", async () => {
    const file = openedFile();
    const seenPaths: string[] = [];

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async (path) => {
          seenPaths.push(path);
          return file;
        },
        () => stateOf(snapshot("doc-1")),
        () => 7,
        MACOS,
      ),
    );

    expect(seenPaths).toEqual(["/notes/doc-1.md"]);
    expect(result).toEqual({ kind: "loaded", file });
  });

  it("accepts a tab whose path still normalizes to the requested path", async () => {
    const file = openedFile();

    const result = await readCurrentDiskVersion(
      request({ path: "/Notes/Doc-1.md" }),
      host(
        async () => file,
        () => stateOf(snapshot("doc-1", { path: "/notes/./doc-1.md" })),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "loaded", file });
  });

  it("returns unchanged for a clean tab when the disk echoes the saved version", async () => {
    const file = openedFile({ version: "v1" });

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async () => file,
        () => stateOf(snapshot("doc-1")),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "unchanged" });
  });

  it("returns unchanged for a dirty tab when the disk echoes the saved version", async () => {
    const file = openedFile({ version: "v1" });

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async () => file,
        () =>
          stateOf(snapshot("doc-1", { status: "dirty", text: "local edit" })),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "unchanged" });
  });

  it("returns loaded for an explicit load of a conflicted tab with the same version", async () => {
    const file = openedFile({ version: "v1" });

    const result = await readCurrentDiskVersion(
      request({ purpose: "explicit" }),
      host(
        async () => file,
        () =>
          stateOf(
            snapshot("doc-1", { status: "conflict", text: "local edit" }),
          ),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "loaded", file });
  });

  it("returns loaded for an explicit load with the same version", async () => {
    const file = openedFile({ version: "v1" });

    const result = await readCurrentDiskVersion(
      request({ purpose: "explicit" }),
      host(
        async () => file,
        () => stateOf(snapshot("doc-1")),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "loaded", file });
  });

  it("returns unchanged for a watch reload of a conflicted tab with the same version", async () => {
    const file = openedFile({ version: "v1" });

    const result = await readCurrentDiskVersion(
      request({ purpose: "watch" }),
      host(
        async () => file,
        () =>
          stateOf(
            snapshot("doc-1", { status: "conflict", text: "local edit" }),
          ),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "unchanged" });
  });

  it("returns loaded for an external write with a different version", async () => {
    const file = openedFile({ version: "w" });

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async () => file,
        () => stateOf(snapshot("doc-1")),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "loaded", file });
  });

  it("returns loaded for an external write to a dirty tab", async () => {
    const file = openedFile({ version: "w" });

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async () => file,
        () =>
          stateOf(snapshot("doc-1", { status: "dirty", text: "local edit" })),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "loaded", file });
  });

  it("prefers stale over unchanged when the tab is renamed during the read", async () => {
    const read = deferred<OpenedFile>();
    let state = stateOf(snapshot("doc-1"));

    const outcome = readCurrentDiskVersion(
      request(),
      host(() => read.promise, () => state, () => 7, MACOS),
    );

    state = stateOf(snapshot("doc-1", { path: "/notes/renamed.md" }));
    read.resolve(openedFile({ version: "v1" }));

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("prefers stale over unchanged when the generation changed during the read", async () => {
    const read = deferred<OpenedFile>();
    let generation = 7;

    const outcome = readCurrentDiskVersion(
      request(),
      host(
        () => read.promise,
        () => stateOf(snapshot("doc-1")),
        () => generation,
        MACOS,
      ),
    );

    generation = 8;
    read.resolve(openedFile({ version: "v1" }));

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("prefers stale over unchanged when the tab version changed during the read", async () => {
    const read = deferred<OpenedFile>();
    let state = stateOf(snapshot("doc-1"));

    const outcome = readCurrentDiskVersion(
      request(),
      host(() => read.promise, () => state, () => 7, MACOS),
    );

    state = stateOf(snapshot("doc-1", { version: "v2" }));
    read.resolve(openedFile({ version: "v1" }));

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("keeps stale priority for an explicit load", async () => {
    const read = deferred<OpenedFile>();
    let state = stateOf(snapshot("doc-1"));

    const outcome = readCurrentDiskVersion(
      request({ purpose: "explicit" }),
      host(() => read.promise, () => state, () => 7, MACOS),
    );

    state = stateOf(snapshot("doc-1", { path: "/notes/renamed.md" }));
    read.resolve(openedFile({ version: "v1" }));

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("turns stale when Save As retargets the tab during the read", async () => {
    const read = deferred<OpenedFile>();
    let state = stateOf(snapshot("doc-1"));

    const outcome = readCurrentDiskVersion(
      request(),
      host(() => read.promise, () => state, () => 7, MACOS),
    );

    state = stateOf(
      snapshot("doc-1", { path: "/notes/saved-as.md", version: "v2" }),
    );
    read.resolve(openedFile({ path: "/notes/saved-as.md", version: "v2" }));

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("turns stale when the tab is renamed during the read", async () => {
    const read = deferred<OpenedFile>();
    let state = stateOf(snapshot("doc-1"));

    const outcome = readCurrentDiskVersion(
      request(),
      host(() => read.promise, () => state, () => 7, MACOS),
    );

    state = stateOf(snapshot("doc-1", { path: "/notes/renamed.md" }));
    read.resolve(openedFile());

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("turns stale when a save changes the tab version during the read", async () => {
    const read = deferred<OpenedFile>();
    let state = stateOf(snapshot("doc-1"));

    const outcome = readCurrentDiskVersion(
      request(),
      host(() => read.promise, () => state, () => 7, MACOS),
    );

    state = stateOf(snapshot("doc-1", { version: "v2" }));
    read.resolve(openedFile());

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("turns stale when the tab closes during the read", async () => {
    const read = deferred<OpenedFile>();
    let state = stateOf(snapshot("doc-1"));

    const outcome = readCurrentDiskVersion(
      request(),
      host(() => read.promise, () => state, () => 7, MACOS),
    );

    state = stateOf();
    read.resolve(openedFile());

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("turns stale when the lifecycle generation changes during the read", async () => {
    const read = deferred<OpenedFile>();
    let generation = 7;

    const outcome = readCurrentDiskVersion(
      request(),
      host(
        () => read.promise,
        () => stateOf(snapshot("doc-1")),
        () => generation,
        MACOS,
      ),
    );

    generation = 8;
    read.resolve(openedFile());

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("classifies not_found as missing while the guard is current", async () => {
    const error = new DocumentPortError("not_found", "file is gone");

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async () => {
          throw error;
        },
        () => stateOf(snapshot("doc-1")),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "missing" });
  });

  it("classifies not_found as missing for a dirty tab", async () => {
    const error = new DocumentPortError("not_found", "file is gone");

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async () => {
          throw error;
        },
        () =>
          stateOf(snapshot("doc-1", { status: "dirty", text: "local edit" })),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "missing" });
  });

  it("classifies other failures as errors while the guard is current", async () => {
    const error = new DocumentPortError("permission_denied", "denied");

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async () => {
          throw error;
        },
        () => stateOf(snapshot("doc-1")),
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "error", error });
  });

  it("leaves error policy to the caller without mutating state", async () => {
    const error = new DocumentPortError("permission_denied", "denied");
    const tab = snapshot("doc-1");
    const state = stateOf(tab);

    const result = await readCurrentDiskVersion(
      request(),
      host(
        async () => {
          throw error;
        },
        () => state,
        () => 7,
        MACOS,
      ),
    );

    expect(result).toEqual({ kind: "error", error });
    expect(state.tabs[0]).toBe(tab);
  });

  it("turns a failed read stale when the tab moved after the read started", async () => {
    const read = deferred<OpenedFile>();
    let state = stateOf(snapshot("doc-1"));

    const outcome = readCurrentDiskVersion(
      request(),
      host(() => read.promise, () => state, () => 7, MACOS),
    );

    state = stateOf(snapshot("doc-1", { path: "/notes/moved.md" }));
    read.reject(new DocumentPortError("not_found", "file is gone"));

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("turns an error stale when the generation changed during the read", async () => {
    const read = deferred<OpenedFile>();
    let generation = 7;

    const outcome = readCurrentDiskVersion(
      request(),
      host(
        () => read.promise,
        () => stateOf(snapshot("doc-1")),
        () => generation,
        MACOS,
      ),
    );

    generation = 8;
    read.reject(new DocumentPortError("permission_denied", "denied"));

    await expect(outcome).resolves.toEqual({ kind: "stale" });
  });

  it("uses the host platform when validating a windows read", async () => {
    const file = openedFile({ path: "C:\\Notes\\A.md" });

    const result = await readCurrentDiskVersion(
      request({ path: "c:/notes/./a.md" }),
      host(
        async () => file,
        () => stateOf(snapshot("doc-1", { path: "C:\\Notes\\A.md" })),
        () => 7,
        WINDOWS,
      ),
    );

    expect(result).toEqual({ kind: "loaded", file });
  });

  it("turns a linux case-only read stale", async () => {
    const file = openedFile({ path: "/notes/A.md" });

    const result = await readCurrentDiskVersion(
      request({ path: "/notes/A.md" }),
      host(
        async () => file,
        () => stateOf(snapshot("doc-1", { path: "/notes/a.md" })),
        () => 7,
        LINUX,
      ),
    );

    expect(result).toEqual({ kind: "stale" });
  });
});
