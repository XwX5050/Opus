import { describe, expect, it } from "vitest";
import {
  documentReducer,
  initialDocumentState,
  normalizePathKey,
  type DocumentAction,
  type DocumentState,
} from "./documentReducer";
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

  it("applies a successful save without changing the document id", () => {
    const state = reduce([
      { type: "newDocument", id: "stable-id" },
      { type: "textChanged", id: "stable-id", text: "new text" },
      {
        type: "saveSucceeded",
        id: "stable-id",
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

describe("MemoryDocumentPort", () => {
  it("clones constructor input and every returned opened file", async () => {
    const source = openedFile();
    const files = new Map([[source.path, source]]);
    const port = new MemoryDocumentPort(files);
    source.text = "mutated source";

    const first = await port.openPath("/Users/Alice/Notes/readme.md");
    first.text = "mutated return";
    const second = await port.openPath("/Users/Alice/Notes/readme.md");

    expect(second.text).toBe("saved");
  });

  it("records cloned writes and updates the backing file with a strong version", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile({ path: "/notes/a.md" })]]),
    );
    const snapshot = document("a", {
      path: "/notes/a.md",
      text: "updated",
      version: "v1",
    });

    const result = await port.save(snapshot);
    snapshot.text = "mutated after save";
    const stored = await port.openPath("/notes/a.md");

    expect(result.path).toBe("/notes/a.md");
    expect(result.version).not.toBe("v1");
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0].text).toBe("updated");
    expect(stored.text).toBe("updated");
  });

  it("can cancel saveAs without recording a write", async () => {
    const port = new MemoryDocumentPort(new Map(), { saveAsPath: null });

    await expect(port.saveAs(document("new", { path: null }))).resolves.toBeNull();
    expect(port.writes).toEqual([]);
  });

  it("returns clones from chooseAndOpenFiles", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/a.md", openedFile({ path: "/notes/a.md", text: "a" })],
        ["/notes/b.md", openedFile({ path: "/notes/b.md", text: "b" })],
      ]),
    );

    const chosen = await port.chooseAndOpenFiles();
    chosen[0].text = "changed";

    expect((await port.chooseAndOpenFiles())[0].text).toBe("a");
  });
});
