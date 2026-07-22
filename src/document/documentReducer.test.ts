import { describe, expect, it } from "vitest";
import {
  documentReducer,
  initialDocumentState,
  normalizePathKey,
  type DocumentAction,
  type DocumentState,
} from "./documentReducer";
import { DocumentPortError } from "./DocumentPort";
import { MemoryDocumentPort } from "./memoryDocumentPort";
import type { DocumentSnapshot, OpenedFile } from "./types";

const openedFile = (overrides: Partial<OpenedFile> = {}): OpenedFile => ({
  path: "/Users/Alice/Notes/readme.md",
  text: "saved",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 100,
  version: "v1",
  ...overrides,
});

const document = (
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

const reduce = (actions: DocumentAction[]): DocumentState =>
  actions.reduce(documentReducer, initialDocumentState);

describe("documentReducer", () => {
  it("creates a clean untitled document and makes it active", () => {
    const state = reduce([{ type: "newDocument", id: "doc-1" }]);

    expect(state).toEqual({
      tabs: [
        {
          id: "doc-1",
          path: null,
          title: "Untitled",
          text: "",
          savedText: "",
          hasUtf8Bom: false,
          newline: "lf",
          modifiedUnixMs: null,
          version: null,
          status: "clean",
        },
      ],
      activeId: "doc-1",
      recentlyClosed: [],
    });
  });

  it("opens a file as a clean document", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
    ]);

    expect(state.tabs[0]).toEqual({
      id: "doc-1",
      path: "/Users/Alice/Notes/readme.md",
      title: "readme.md",
      text: "saved",
      savedText: "saved",
      hasUtf8Bom: false,
      newline: "lf",
      modifiedUnixMs: 100,
      version: "v1",
      status: "clean",
    });
  });

  it("focuses an existing macOS path instead of opening a duplicate", () => {
    const state = reduce([
      { type: "fileOpened", id: "first", file: openedFile() },
      {
        type: "fileOpened",
        id: "duplicate",
        file: openedFile({ path: "/users/alice/notes/./README.md" }),
        pathPlatform: "macos",
      },
    ]);

    expect(state.tabs.map((tab) => tab.id)).toEqual(["first"]);
    expect(state.activeId).toBe("first");
  });

  it("does not merge distinct case-sensitive Linux paths or Linux backslashes", () => {
    expect(normalizePathKey("/tmp/A.md", "linux")).not.toBe(
      normalizePathKey("/tmp/a.md", "linux"),
    );
    expect(normalizePathKey("/tmp/a\\b.md", "linux")).not.toBe(
      normalizePathKey("/tmp/a/b.md", "linux"),
    );
  });

  it("opens case-distinct Linux paths as two tabs through fileOpened", () => {
    const state = reduce([
      {
        type: "fileOpened",
        id: "upper",
        file: openedFile({ path: "/tmp/A.md" }),
        pathPlatform: "linux",
      },
      {
        type: "fileOpened",
        id: "lower",
        file: openedFile({ path: "/tmp/a.md" }),
        pathPlatform: "linux",
      },
    ]);

    expect(state.tabs.map((tab) => tab.id)).toEqual(["upper", "lower"]);
    expect(state.activeId).toBe("lower");
  });

  it("deduplicates equivalent Windows paths without merging distinct root forms", () => {
    const state = reduce([
      {
        type: "fileOpened",
        id: "absolute",
        file: openedFile({ path: "C:\\Notes\\A.md" }),
        pathPlatform: "windows",
      },
      {
        type: "fileOpened",
        id: "absolute-duplicate",
        file: openedFile({ path: "c:/notes/./a.md" }),
        pathPlatform: "windows",
      },
      {
        type: "fileOpened",
        id: "drive-relative",
        file: openedFile({ path: "C:Notes\\A.md" }),
        pathPlatform: "windows",
      },
    ]);

    expect(state.tabs.map((tab) => tab.id)).toEqual([
      "absolute",
      "drive-relative",
    ]);
  });

  it("focuses an existing id instead of adding a second tab", () => {
    const state = reduce([
      { type: "fileOpened", id: "same-id", file: openedFile() },
      {
        type: "fileOpened",
        id: "same-id",
        file: openedFile({ path: "/different.md" }),
      },
    ]);

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].path).toBe("/Users/Alice/Notes/readme.md");
    expect(state.activeId).toBe("same-id");
  });

  it("marks an edited document dirty while retaining the saved text", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edit" },
    ]);

    expect(state.tabs[0]).toMatchObject({
      id: "doc-1",
      text: "local edit",
      savedText: "saved",
      status: "dirty",
    });
  });

  it("returns to clean when text is edited back to savedText", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edit" },
      { type: "textChanged", id: "doc-1", text: "saved" },
    ]);

    expect(state.tabs[0].status).toBe("clean");
  });

  it("applies the latest successful save without changing the document id", () => {
    const state = reduce([
      { type: "newDocument", id: "stable-id" },
      { type: "textChanged", id: "stable-id", text: "new text" },
      {
        type: "saveStarted",
        id: "stable-id",
        requestId: "save-1",
        targetPath: "/notes/new.md",
        writtenText: "new text",
        previousVersion: null,
      },
      {
        type: "saveSucceeded",
        id: "stable-id",
        requestId: "save-1",
        result: {
          path: "/notes/new.md",
          modifiedUnixMs: 250,
          version: "strong-v2",
        },
      },
    ]);

    expect(state.tabs[0]).toMatchObject({
      id: "stable-id",
      path: "/notes/new.md",
      title: "new.md",
      text: "new text",
      savedText: "new text",
      modifiedUnixMs: 250,
      version: "strong-v2",
      status: "clean",
    });
  });

  it("keeps edits made during a save dirty and records only the written text", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile({ text: "base" }) },
      { type: "textChanged", id: "doc-1", text: "A" },
      {
        type: "saveStarted",
        id: "doc-1",
        requestId: "save-A",
        targetPath: "/Users/Alice/Notes/readme.md",
        writtenText: "A",
        previousVersion: "v1",
      },
      { type: "textChanged", id: "doc-1", text: "B" },
      {
        type: "saveSucceeded",
        id: "doc-1",
        requestId: "save-A",
        result: {
          path: "/Users/Alice/Notes/readme.md",
          modifiedUnixMs: 200,
          version: "v2",
        },
      },
    ]);

    expect(state.tabs[0]).toMatchObject({
      text: "B",
      savedText: "A",
      modifiedUnixMs: 200,
      version: "v2",
      status: "dirty",
    });
    expect(state.tabs[0].pendingSave).toBeUndefined();
  });

  it("ignores an out-of-order completion from an older save request", () => {
    const beforeOldCompletion = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile({ text: "base" }) },
      { type: "textChanged", id: "doc-1", text: "A" },
      {
        type: "saveStarted",
        id: "doc-1",
        requestId: "save-A",
        targetPath: "/notes/a.md",
        writtenText: "A",
        previousVersion: "v1",
      },
      { type: "textChanged", id: "doc-1", text: "B" },
      {
        type: "saveStarted",
        id: "doc-1",
        requestId: "save-B",
        targetPath: "/notes/b.md",
        writtenText: "B",
        previousVersion: "v1",
      },
    ]);
    const afterOldCompletion = documentReducer(beforeOldCompletion, {
      type: "saveSucceeded",
      id: "doc-1",
      requestId: "save-A",
      result: { path: "/notes/a.md", modifiedUnixMs: 200, version: "old" },
    });

    expect(beforeOldCompletion.tabs[0].pendingSave).toEqual({
      requestId: "save-B",
      targetPath: "/notes/b.md",
      writtenText: "B",
      previousVersion: "v1",
    });
    expect(afterOldCompletion).toBe(beforeOldCompletion);

    const afterLatestCompletion = documentReducer(afterOldCompletion, {
      type: "saveSucceeded",
      id: "doc-1",
      requestId: "save-B",
      result: { path: "/notes/b.md", modifiedUnixMs: 300, version: "latest" },
    });
    expect(afterLatestCompletion.tabs[0]).toMatchObject({
      path: "/notes/b.md",
      text: "B",
      savedText: "B",
      modifiedUnixMs: 300,
      version: "latest",
      status: "clean",
    });
  });

  it("fails closed when a save result collides with another open tab path", () => {
    const state: DocumentState = {
      tabs: [
        document("a", { path: "/notes/a.md", text: "changed", status: "dirty" }),
        document("b", { path: "/notes/b.md" }),
      ],
      activeId: "a",
      recentlyClosed: [],
    };
    const saving = documentReducer(state, {
      type: "saveStarted",
      id: "a",
      requestId: "save-as",
      targetPath: "/notes/b.md",
      writtenText: "changed",
      previousVersion: "v1",
    });

    const completed = documentReducer(saving, {
      type: "saveSucceeded",
      id: "a",
      requestId: "save-as",
      result: { path: "/notes/b.md", modifiedUnixMs: 200, version: "v2" },
    });

    expect(completed.tabs[0]).toMatchObject({
      path: "/notes/a.md",
      text: "changed",
      savedText: "saved",
      modifiedUnixMs: 100,
      version: "v1",
      status: "conflict",
    });
  });

  it("fails closed when a save result reports a path other than its target", () => {
    const state: DocumentState = {
      tabs: [document("a", { text: "changed", status: "dirty" })],
      activeId: "a",
      recentlyClosed: [],
    };
    const saving = documentReducer(state, {
      type: "saveStarted",
      id: "a",
      requestId: "save-as",
      targetPath: "/notes/expected.md",
      writtenText: "changed",
      previousVersion: "v1",
    });

    const completed = documentReducer(saving, {
      type: "saveSucceeded",
      id: "a",
      requestId: "save-as",
      result: {
        path: "/notes/unexpected.md",
        modifiedUnixMs: 200,
        version: "v2",
      },
    });

    expect(completed.tabs[0]).toMatchObject({
      path: "/notes/a.md",
      savedText: "saved",
      modifiedUnixMs: 100,
      version: "v1",
      status: "conflict",
    });
  });

  it("selects the right neighbor, then the left neighbor, when closing tabs", () => {
    const initial: DocumentState = {
      tabs: [document("a"), document("b"), document("c")],
      activeId: "b",
      recentlyClosed: [],
    };
    const afterB = documentReducer(initial, {
      type: "closeConfirmed",
      id: "b",
      disposition: "saved",
    });
    const afterC = documentReducer(afterB, {
      type: "closeConfirmed",
      id: "c",
      disposition: "saved",
    });

    expect(afterB.activeId).toBe("c");
    expect(afterC.activeId).toBe("a");
  });

  it("marks an external conflict without losing local text", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edit" },
      {
        type: "externalConflict",
        id: "doc-1",
        modifiedUnixMs: 101,
        version: "v2",
      },
    ]);

    expect(state.tabs[0]).toMatchObject({
      text: "local edit",
      savedText: "saved",
      modifiedUnixMs: 101,
      version: "v2",
      status: "conflict",
    });
  });

  it("marks an externally missing document without losing its buffer", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edit" },
      { type: "externalMissing", id: "doc-1" },
    ]);

    expect(state.tabs[0]).toMatchObject({ text: "local edit", status: "missing" });
  });

  it("keeps only the 20 most recently closed tabs", () => {
    let state: DocumentState = {
      tabs: Array.from({ length: 21 }, (_, index) => document(`doc-${index}`)),
      activeId: "doc-20",
      recentlyClosed: [],
    };
    for (let index = 0; index < 21; index += 1) {
      state = documentReducer(state, {
        type: "closeConfirmed",
        id: `doc-${index}`,
        disposition: "saved",
      });
    }

    expect(state.recentlyClosed).toHaveLength(20);
    expect(state.recentlyClosed[0].document.id).toBe("doc-20");
    expect(state.recentlyClosed.at(-1)?.document.id).toBe("doc-1");
  });

  it("reopens the latest closed tab at its original index and activates it", () => {
    const initial: DocumentState = {
      tabs: [document("a"), document("b"), document("c")],
      activeId: "b",
      recentlyClosed: [],
    };
    const closed = documentReducer(initial, {
      type: "closeConfirmed",
      id: "b",
      disposition: "saved",
    });
    const reopened = documentReducer(closed, { type: "reopenLastClosed" });

    expect(reopened.tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
    expect(reopened.activeId).toBe("b");
    expect(reopened.recentlyClosed).toEqual([]);
  });

  it("reopens recently closed tabs in LIFO order and preserves the remaining stack", () => {
    const initial: DocumentState = {
      tabs: [document("a"), document("b"), document("c")],
      activeId: "a",
      recentlyClosed: [],
    };
    const closedA = documentReducer(initial, {
      type: "closeConfirmed",
      id: "a",
      disposition: "saved",
    });
    const closedC = documentReducer(closedA, {
      type: "closeConfirmed",
      id: "c",
      disposition: "saved",
    });
    const closedB = documentReducer(closedC, {
      type: "closeConfirmed",
      id: "b",
      disposition: "saved",
    });

    const reopened = documentReducer(closedB, { type: "reopenLastClosed" });

    expect(reopened.tabs.map((tab) => tab.id)).toEqual(["b"]);
    expect(reopened.activeId).toBe("b");
    expect(reopened.recentlyClosed.map(({ document }) => document.id)).toEqual([
      "c",
      "a",
    ]);
  });

  it("focuses an existing id while reopening and consumes the stack item", () => {
    const existing = document("same", { path: "/notes/existing.md" });
    const closed = document("same", { path: "/notes/closed.md" });
    const state: DocumentState = {
      tabs: [existing],
      activeId: "same",
      recentlyClosed: [{ document: closed, closedIndex: 0 }],
    };

    const reopened = documentReducer(state, { type: "reopenLastClosed" });

    expect(reopened.tabs).toEqual([existing]);
    expect(reopened.activeId).toBe("same");
    expect(reopened.recentlyClosed).toEqual([]);
  });

  it("deduplicates recently closed entries and clones snapshots across collections", () => {
    const open = document("new", { path: "/NOTES/a.md" });
    const old = document("old", { path: "/notes/A.md" });
    const unrelated = document("other", { path: "/notes/other.md" });
    const state: DocumentState = {
      tabs: [open],
      activeId: "new",
      recentlyClosed: [
        { document: old, closedIndex: 3 },
        { document: unrelated, closedIndex: 2 },
      ],
    };

    const closed = documentReducer(state, {
      type: "closeConfirmed",
      id: "new",
      disposition: "saved",
    });

    expect(closed.recentlyClosed.map(({ document }) => document.id)).toEqual([
      "new",
      "other",
    ]);
    expect(closed.recentlyClosed[0].document).not.toBe(open);

    const reopened = documentReducer(closed, { type: "reopenLastClosed" });
    expect(reopened.tabs[0]).not.toBe(closed.recentlyClosed[0].document);
  });

  it("deduplicates pathless recently closed entries by stable id", () => {
    const open = document("untitled", { path: null });
    const older = document("untitled", { path: null, text: "older" });
    const state: DocumentState = {
      tabs: [open],
      activeId: "untitled",
      recentlyClosed: [{ document: older, closedIndex: 4 }],
    };

    const closed = documentReducer(state, {
      type: "closeConfirmed",
      id: "untitled",
      disposition: "saved",
    });

    expect(closed.recentlyClosed).toHaveLength(1);
    expect(closed.recentlyClosed[0].document.text).toBe("saved");
  });

  it("clamps a restored tab index and no-ops for invalid actions", () => {
    const state: DocumentState = {
      tabs: [document("a"), document("b")],
      activeId: "a",
      recentlyClosed: [{ document: document("c"), closedIndex: -4 }],
    };
    const nonActiveClosed = documentReducer(state, {
      type: "closeConfirmed",
      id: "b",
      disposition: "saved",
    });
    expect(nonActiveClosed.activeId).toBe("a");

    const restored = documentReducer(state, { type: "reopenLastClosed" });
    expect(restored.tabs.map((tab) => tab.id)).toEqual(["c", "a", "b"]);

    expect(documentReducer(state, { type: "activate", id: "missing" })).toBe(
      state,
    );
    expect(
      documentReducer(state, {
        type: "closeConfirmed",
        id: "missing",
        disposition: "saved",
      }),
    ).toBe(state);
    expect(
      documentReducer(state, {
        type: "textChanged",
        id: "missing",
        text: "ignored",
      }),
    ).toBe(state);
    expect(
      documentReducer(initialDocumentState, { type: "reopenLastClosed" }),
    ).toBe(initialDocumentState);
  });

  it("records saved text rather than discarded dirty edits", () => {
    const initial: DocumentState = {
      tabs: [document("a", { text: "discard me", status: "dirty" })],
      activeId: "a",
      recentlyClosed: [],
    };
    const state = documentReducer(initial, {
      type: "closeConfirmed",
      id: "a",
      disposition: "discarded",
    });

    expect(state.recentlyClosed[0].document).toMatchObject({
      id: "a",
      text: "saved",
      savedText: "saved",
      status: "clean",
    });
  });

  it("records a discarded untitled document as an empty clean snapshot", () => {
    const state = reduce([
      { type: "newDocument", id: "untitled" },
      { type: "textChanged", id: "untitled", text: "discard me" },
      {
        type: "closeConfirmed",
        id: "untitled",
        disposition: "discarded",
      },
    ]);

    expect(state.recentlyClosed[0].document).toMatchObject({
      id: "untitled",
      path: null,
      text: "",
      savedText: "",
      status: "clean",
    });
  });

  it("focuses an already-open normalized path when reopening and consumes the stack item", () => {
    const alreadyOpen = document("existing", {
      path: "/Users/Alice/Notes/readme.md",
    });
    const closedDuplicate = document("closed", {
      path: "/users/alice/notes/README.md",
    });
    const state: DocumentState = {
      tabs: [alreadyOpen],
      activeId: "existing",
      recentlyClosed: [{ document: closedDuplicate, closedIndex: 0 }],
    };

    const reopened = documentReducer(state, { type: "reopenLastClosed" });

    expect(reopened.tabs).toEqual([alreadyOpen]);
    expect(reopened.activeId).toBe("existing");
    expect(reopened.recentlyClosed).toEqual([]);
  });
});

describe("normalizePathKey", () => {
  it("keeps relative empty results relative on POSIX platforms", () => {
    expect(normalizePathKey("", "linux")).toBe("");
    expect(normalizePathKey("a/..", "linux")).toBe("");
    expect(normalizePathKey("a/..", "macos")).toBe("");
    expect(normalizePathKey("/../../a", "linux")).toBe("/a");
  });

  it("normalizes Windows roots without merging their distinct semantics", () => {
    expect(normalizePathKey("C:\\a\\..\\x", "windows")).toBe("c:\\x");
    expect(normalizePathKey("C:a\\..\\x", "windows")).toBe("c:x");
    expect(normalizePathKey("\\a\\..\\x", "windows")).toBe("\\x");
    expect(
      normalizePathKey("\\\\Server\\Share\\a\\..\\x", "windows"),
    ).toBe("\\\\server\\share\\x");
    expect(
      normalizePathKey("\\\\Server\\Share\\..\\..\\x", "windows"),
    ).toBe("\\\\server\\share\\x");
    expect(normalizePathKey("a\\..", "windows")).toBe("");

    expect(normalizePathKey("C:\\x", "windows")).not.toBe(
      normalizePathKey("C:x", "windows"),
    );
    expect(normalizePathKey("C:\\x", "windows")).not.toBe(
      normalizePathKey("\\x", "windows"),
    );
    expect(normalizePathKey("\\\\?\\C:\\x", "windows")).not.toBe(
      normalizePathKey("C:\\x", "windows"),
    );
    expect(normalizePathKey("\\\\?\\C:\\x", "windows")).not.toBe(
      normalizePathKey("\\\\.\\C:\\x", "windows"),
    );
  });
});

describe("MemoryDocumentPort", () => {
  it("clones constructor input and every returned opened file", async () => {
    const source = openedFile();
    const files = new Map([[source.path, source]]);
    const port = new MemoryDocumentPort(files);
    Reflect.set(source, "text", "mutated source");

    const first = await port.openPath("/Users/Alice/Notes/readme.md");
    Reflect.set(first, "text", "mutated return");
    const second = await port.openPath("/Users/Alice/Notes/readme.md");

    expect(second.text).toBe("saved");
  });

  it("records cloned writes and saves when the opaque version matches", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile({ path: "/notes/a.md" })]]),
    );
    const snapshot = document("a", {
      path: "/notes/a.md",
      text: "updated",
      version: "v1",
    });

    const result = await port.save(snapshot);
    Reflect.set(snapshot, "text", "mutated after save");
    const stored = await port.openPath("/notes/a.md");

    expect(result.path).toBe("/notes/a.md");
    expect(result.version).not.toBe("v1");
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0].text).toBe("updated");
    const returnedWrites = port.writes;
    Reflect.set(returnedWrites[0], "text", "mutated returned record");
    expect(port.writes[0].text).toBe("updated");
    expect(stored.text).toBe("updated");
  });

  it("never reuses an opaque version already present in the backing store", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        [
          "/notes/a.md",
          openedFile({ path: "/notes/a.md", version: "memory-version-1" }),
        ],
      ]),
    );

    const result = await port.save(
      document("a", { path: "/notes/a.md", version: "memory-version-1" }),
    );

    expect(result.version).not.toBe("memory-version-1");
  });

  it("can cancel choosing a save path without recording a write", async () => {
    const port = new MemoryDocumentPort(new Map(), { savePath: null });

    await expect(port.chooseSavePath("Untitled.md")).resolves.toBeNull();
    expect(port.writes).toEqual([]);
  });

  it("saves to a new chosen path only when the target is expected to be missing", async () => {
    const port = new MemoryDocumentPort(new Map(), {
      savePath: "/notes/new.md",
    });
    const snapshot = document("new", { path: null, text: "new" });

    const path = await port.chooseSavePath("Untitled.md");
    expect(path).toBe("/notes/new.md");
    const result = await port.saveToPath(path!, snapshot, null);

    expect(result.path).toBe("/notes/new.md");
    expect((await port.openPath("/notes/new.md")).text).toBe("new");

    const staleExpectation = new MemoryDocumentPort(new Map());
    await expect(
      staleExpectation.saveToPath("/notes/other.md", snapshot, "ghost-version"),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a stale same-path save without overwriting or recording it", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile({ path: "/notes/a.md", version: "v2" })]]),
    );
    const stale = document("a", {
      path: "/notes/a.md",
      text: "stale write",
      version: "v1",
    });

    await expect(port.save(stale)).rejects.toMatchObject({ code: "conflict" });
    expect((await port.openPath("/notes/a.md")).text).toBe("saved");
    expect(port.writes).toEqual([]);
  });

  it("requires the target version when overwriting through saveToPath", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/target.md", openedFile({ path: "/notes/target.md", version: "target-v1" })],
      ]),
    );
    const source = document("source", {
      path: "/notes/source.md",
      text: "replacement",
      version: "source-v1",
    });

    await expect(
      port.saveToPath("/notes/target.md", source, "stale-target"),
    ).rejects.toMatchObject({ code: "conflict" });
    const result = await port.saveToPath(
      "/notes/target.md",
      source,
      "target-v1",
    );

    expect(result.version).not.toBe("target-v1");
    expect((await port.openPath("/notes/target.md")).text).toBe("replacement");
    expect(port.writes).toHaveLength(1);
  });

  it("exposes stable typed errors with an optional cause", () => {
    const cause = new Error("disk failure");
    const error = new DocumentPortError("io", "could not write", { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DocumentPortError);
    expect(error.code).toBe("io");
    expect(error.cause).toBe(cause);
  });

  it("returns clones from chooseAndOpenFiles", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/a.md", openedFile({ path: "/notes/a.md", text: "a" })],
        ["/notes/b.md", openedFile({ path: "/notes/b.md", text: "b" })],
      ]),
    );

    const chosen = await port.chooseAndOpenFiles();
    Reflect.set(chosen[0], "text", "changed");

    expect((await port.chooseAndOpenFiles())[0].text).toBe("a");
  });
});
