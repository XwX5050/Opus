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
import type {
  DocumentSnapshot,
  OpenedFile,
  PendingWriteRequest,
} from "./types";

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

const writeRequest = (
  overrides: Partial<PendingWriteRequest> = {},
): PendingWriteRequest =>
  Object.freeze({
    requestId: "save-1",
    documentId: "doc-1",
    targetPath: "/notes/a.md",
    text: "updated",
    hasUtf8Bom: false,
    newline: "lf",
    expectedVersion: "v1",
    pathPlatform: "macos",
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
      nextSaveSequence: 0,
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

  it("restores session tabs without stealing the active tab", () => {
    const state = reduce([
      { type: "fileOpened", id: "explicit", file: openedFile({ path: "/tmp/new.md" }) },
      {
        type: "fileOpened",
        id: "restored",
        file: openedFile(),
        activate: false,
      },
      {
        type: "fileOpened",
        id: "restored-duplicate",
        file: openedFile({ path: "/tmp/new.md" }),
        activate: false,
      },
    ]);

    expect(state.tabs.map((tab) => tab.id)).toEqual(["explicit", "restored"]);
    expect(state.activeId).toBe("explicit");
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

  it("derives one immutable write request and passes its exact values to the port", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile({ path: "/notes/a.md" })]]),
    );
    const edited = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile({ path: "/notes/a.md" }) },
      { type: "textChanged", id: "doc-1", text: "write exactly this" },
    ]);
    const saving = documentReducer(edited, {
      type: "saveRequested",
      id: "doc-1",
    });
    const request = saving.tabs[0].pendingSave!;

    expect(request).toEqual({
      requestId: "save-1",
      documentId: "doc-1",
      targetPath: "/notes/a.md",
      text: "write exactly this",
      hasUtf8Bom: false,
      newline: "lf",
      expectedVersion: "v1",
      pathPlatform: "macos",
    });
    expect(Object.isFrozen(request)).toBe(true);

    const result = await port.write(request);
    expect(port.writes[0]).toEqual(request);
    expect(port.writes[0]).not.toBe(request);

    const saved = documentReducer(saving, {
      type: "saveSucceeded",
      requestId: request.requestId,
      result,
    });
    expect(saved.tabs[0]).toMatchObject({
      id: "doc-1",
      text: "write exactly this",
      savedText: "write exactly this",
      version: result.version,
      status: "clean",
    });
  });

  it("keeps edits made during a save dirty and uses pending request text", () => {
    const saving = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile({ text: "base" }) },
      { type: "textChanged", id: "doc-1", text: "A" },
      {
        type: "saveRequested",
        id: "doc-1",
      },
    ]);
    const requestId = saving.tabs[0].pendingSave!.requestId;
    const editedAgain = documentReducer(saving, {
      type: "textChanged",
      id: "doc-1",
      text: "B",
    });
    const state = documentReducer(editedAgain, {
      type: "saveSucceeded",
      requestId,
      result: {
        path: "/Users/Alice/Notes/readme.md",
        modifiedUnixMs: 200,
        version: "v2",
      },
    });

    expect(state.tabs[0]).toMatchObject({
      text: "B",
      savedText: "A",
      modifiedUnixMs: 200,
      version: "v2",
      status: "dirty",
    });
    expect(state.tabs[0].pendingSave).toBeUndefined();
  });

  it("fails closed when a save result path differs from the frozen target", () => {
    const saving = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile({ path: "/notes/a.md" }) },
      { type: "textChanged", id: "doc-1", text: "unconfirmed local text" },
      {
        type: "saveRequested",
        id: "doc-1",
        target: { path: "/notes/expected.md", expectedVersion: null },
      },
    ]);
    const pending = saving.tabs[0].pendingSave!;
    expect(Object.isFrozen(pending)).toBe(true);
    expect(pending.targetPath).toBe("/notes/expected.md");

    const completed = documentReducer(saving, {
      type: "saveSucceeded",
      requestId: pending.requestId,
      result: {
        path: "/notes/unexpected.md",
        modifiedUnixMs: 999,
        version: "unexpected-version",
      },
    });

    expect(completed.tabs[0]).toMatchObject({
      path: "/notes/a.md",
      text: "unconfirmed local text",
      savedText: "saved",
      modifiedUnixMs: 100,
      version: "v1",
      status: "conflict",
    });
    expect(completed.tabs[0].pendingSave).toBeUndefined();
  });

  it("generates monotonic request ids and ignores out-of-order completion", () => {
    const first = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile({ text: "base" }) },
      { type: "textChanged", id: "doc-1", text: "A" },
      {
        type: "saveRequested",
        id: "doc-1",
        target: { path: "/notes/a.md", expectedVersion: "v1" },
      },
    ]);
    const firstId = first.tabs[0].pendingSave!.requestId;
    const second = documentReducer(
      documentReducer(first, { type: "textChanged", id: "doc-1", text: "B" }),
      {
        type: "saveRequested",
        id: "doc-1",
        target: { path: "/notes/b.md", expectedVersion: null },
      },
    );
    const secondId = second.tabs[0].pendingSave!.requestId;

    expect([firstId, secondId]).toEqual(["save-1", "save-2"]);
    const afterOld = documentReducer(second, {
      type: "saveSucceeded",
      requestId: firstId,
      result: { path: "/notes/a.md", modifiedUnixMs: 200, version: "old" },
    });
    expect(afterOld).toBe(second);

    const afterLatest = documentReducer(afterOld, {
      type: "saveSucceeded",
      requestId: secondId,
      result: { path: "/notes/b.md", modifiedUnixMs: 300, version: "latest" },
    });
    expect(afterLatest.tabs[0]).toMatchObject({
      path: "/notes/b.md",
      text: "B",
      savedText: "B",
      version: "latest",
      status: "clean",
    });
  });

  it("blocks a save request whose target is already open", () => {
    const state: DocumentState = {
      tabs: [
        document("a", { path: "/notes/a.md", text: "changed", status: "dirty" }),
        document("b", { path: "/NOTES/b.md", text: "target text" }),
      ],
      activeId: "a",
      recentlyClosed: [],
      nextSaveSequence: 0,
    };

    const blocked = documentReducer(state, {
      type: "saveRequested",
      id: "a",
      target: { path: "/notes/B.md", expectedVersion: "v1" },
      pathPlatform: "macos",
    });

    expect(blocked.tabs[0]).toMatchObject({ status: "conflict" });
    expect(blocked.tabs[0].pendingSave).toBeUndefined();
    expect(blocked.nextSaveSequence).toBe(0);
  });

  it("does not orphan an existing pending request when a newer target is blocked", () => {
    const saving = reduce([
      { type: "fileOpened", id: "source", file: openedFile({ path: "/notes/a.md" }) },
      { type: "textChanged", id: "source", text: "source local" },
      { type: "saveRequested", id: "source" },
    ]);
    const request = saving.tabs[0].pendingSave;
    const targetOpened = documentReducer(saving, {
      type: "fileOpened",
      id: "target",
      file: openedFile({ path: "/notes/b.md" }),
    });

    const blocked = documentReducer(targetOpened, {
      type: "saveRequested",
      id: "source",
      target: { path: "/notes/b.md", expectedVersion: "v1" },
    });

    expect(blocked.tabs[0].status).toBe("conflict");
    expect(blocked.tabs[0].pendingSave).toBe(request);
    expect(blocked.nextSaveSequence).toBe(1);
  });

  it("marks both tabs conflict if the target opens while a write is pending", () => {
    const saving = reduce([
      { type: "fileOpened", id: "source", file: openedFile({ path: "/notes/a.md" }) },
      { type: "textChanged", id: "source", text: "source local" },
      {
        type: "saveRequested",
        id: "source",
        target: { path: "/notes/b.md", expectedVersion: null },
      },
    ]);
    const requestId = saving.tabs[0].pendingSave!.requestId;
    const targetOpened = documentReducer(saving, {
      type: "fileOpened",
      id: "target",
      file: openedFile({ path: "/notes/b.md", text: "target text" }),
    });

    const completed = documentReducer(targetOpened, {
      type: "saveSucceeded",
      requestId,
      result: { path: "/notes/b.md", modifiedUnixMs: 200, version: "v2" },
    });

    expect(completed.tabs.map(({ text, status }) => ({ text, status }))).toEqual([
      { text: "source local", status: "conflict" },
      { text: "target text", status: "conflict" },
    ]);
    expect(completed.tabs[0].pendingSave).toBeUndefined();
  });

  it("clears only the matching failed or cancelled save request", () => {
    const first = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "A" },
      {
        type: "saveRequested",
        id: "doc-1",
        target: { path: "/notes/a.md", expectedVersion: "v1" },
      },
    ]);
    const firstId = first.tabs[0].pendingSave!.requestId;
    const second = documentReducer(
      documentReducer(first, { type: "textChanged", id: "doc-1", text: "B" }),
      {
        type: "saveRequested",
        id: "doc-1",
        target: { path: "/notes/b.md", expectedVersion: null },
      },
    );
    const secondId = second.tabs[0].pendingSave!.requestId;

    const staleFailure = documentReducer(second, {
      type: "saveFailed",
      requestId: firstId,
      error: new DocumentPortError("io", "old failure"),
    });
    expect(staleFailure).toBe(second);

    const failed = documentReducer(staleFailure, {
      type: "saveFailed",
      requestId: secondId,
      error: new DocumentPortError("io", "current failure"),
    });
    expect(failed.tabs[0]).toMatchObject({
      text: "B",
      savedText: "saved",
      version: "v1",
      status: "dirty",
    });
    expect(failed.tabs[0].pendingSave).toBeUndefined();

    const closedAfterFailure = documentReducer(failed, {
      type: "closeConfirmed",
      id: "doc-1",
      disposition: "discarded",
    });
    const reopenedAfterFailure = documentReducer(closedAfterFailure, {
      type: "reopenLastClosed",
    });
    expect(reopenedAfterFailure.tabs[0].pendingSave).toBeUndefined();

    const retrying = documentReducer(failed, {
      type: "saveRequested",
      id: "doc-1",
      target: { path: "/notes/b.md", expectedVersion: null },
    });
    const cancelled = documentReducer(retrying, {
      type: "saveCancelled",
      requestId: retrying.tabs[0].pendingSave!.requestId,
    });
    expect(cancelled.tabs[0]).toMatchObject({ text: "B", status: "dirty" });
    expect(cancelled.tabs[0].pendingSave).toBeUndefined();
  });

  it("does not close a tab with a pending write and never archives pending state", () => {
    const saving = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "dirty" },
      {
        type: "saveRequested",
        id: "doc-1",
      },
    ]);
    const blockedClose = documentReducer(saving, {
      type: "closeConfirmed",
      id: "doc-1",
      disposition: "saved",
    });
    expect(blockedClose).toBe(saving);

    const cancelled = documentReducer(saving, {
      type: "saveCancelled",
      requestId: saving.tabs[0].pendingSave!.requestId,
    });
    const closed = documentReducer(cancelled, {
      type: "closeConfirmed",
      id: "doc-1",
      disposition: "discarded",
    });
    expect(closed.tabs).toEqual([]);
    expect(closed.recentlyClosed[0].document.pendingSave).toBeUndefined();
  });

  it("sanitizes stale pending data from a restored recently closed entry", () => {
    const stale = document("stale", {
      pendingSave: writeRequest({ documentId: "stale" }),
    });
    const staleDeeper = document("deeper", {
      pendingSave: writeRequest({ documentId: "deeper", requestId: "save-6" }),
    });
    const state: DocumentState = {
      tabs: [],
      activeId: null,
      recentlyClosed: [
        { document: stale, closedIndex: 0 },
        { document: staleDeeper, closedIndex: 1 },
      ],
      nextSaveSequence: 7,
    };

    const reopened = documentReducer(state, { type: "reopenLastClosed" });

    expect(reopened.tabs[0].pendingSave).toBeUndefined();
    expect(reopened.recentlyClosed[0].document.pendingSave).toBeUndefined();
    expect(reopened.nextSaveSequence).toBe(7);
  });

  it("selects the right neighbor, then the left neighbor, when closing tabs", () => {
    const initial: DocumentState = {
      tabs: [document("a"), document("b"), document("c")],
      activeId: "b",
      recentlyClosed: [],
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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
      nextSaveSequence: 0,
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

  it("records cloned exact requests and writes when the opaque version matches", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile({ path: "/notes/a.md" })]]),
    );
    const request = writeRequest();

    const result = await port.write(request);
    Reflect.set(request, "text", "mutated after save");
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

    const result = await port.write(
      writeRequest({ expectedVersion: "memory-version-1" }),
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
    const target = await port.chooseSavePath("Untitled.md");
    expect(target).toEqual({ path: "/notes/new.md", expectedVersion: null });
    const result = await port.write(
      writeRequest({
        documentId: "new",
        targetPath: target!.path,
        text: "new",
        expectedVersion: target!.expectedVersion,
      }),
    );

    expect(result.path).toBe("/notes/new.md");
    expect((await port.openPath("/notes/new.md")).text).toBe("new");

    const staleExpectation = new MemoryDocumentPort(new Map());
    await expect(
      staleExpectation.write(
        writeRequest({
          targetPath: "/notes/other.md",
          expectedVersion: "ghost-version",
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a stale same-path save without overwriting or recording it", async () => {
    const port = new MemoryDocumentPort(
      new Map([["/notes/a.md", openedFile({ path: "/notes/a.md", version: "v2" })]]),
    );
    await expect(
      port.write(writeRequest({ text: "stale write", expectedVersion: "v1" })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await port.openPath("/notes/a.md")).text).toBe("saved");
    expect(port.writes).toEqual([]);
  });

  it("requires the chosen target version when overwriting", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        ["/notes/target.md", openedFile({ path: "/notes/target.md", version: "target-v1" })],
      ]),
      { savePath: "/notes/target.md" },
    );
    const target = await port.chooseSavePath("source.md");
    expect(target).toEqual({
      path: "/notes/target.md",
      expectedVersion: "target-v1",
    });
    await expect(
      port.write(
        writeRequest({
          targetPath: "/notes/target.md",
          text: "replacement",
          expectedVersion: "stale-target",
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const result = await port.write(
      writeRequest({
        targetPath: target!.path,
        text: "replacement",
        expectedVersion: target!.expectedVersion,
      }),
    );

    expect(result.version).not.toBe("target-v1");
    expect((await port.openPath("/notes/target.md")).text).toBe("replacement");
    expect(port.writes).toHaveLength(1);
  });

  it("uses normalized macOS keys for open, target selection, and CAS", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        [
          "/Notes/A.md",
          openedFile({ path: "/Notes/A.md", version: "v1" }),
        ],
      ]),
      { savePath: "/notes/./a.md", pathPlatform: "macos" },
    );

    expect((await port.openPath("/notes/a.md")).path).toBe("/Notes/A.md");
    expect(await port.chooseSavePath("A.md")).toEqual({
      path: "/notes/./a.md",
      expectedVersion: "v1",
    });
    const result = await port.write(
      writeRequest({ targetPath: "/NOTES/a.md", expectedVersion: "v1" }),
    );

    expect(result.path).toBe("/Notes/A.md");
    expect((await port.openPath("/notes/../notes/A.md")).text).toBe("updated");
  });

  it("uses Windows separator and case semantics in its backing index", async () => {
    const port = new MemoryDocumentPort(
      new Map([
        [
          "C:\\Notes\\A.md",
          openedFile({ path: "C:\\Notes\\A.md", version: "v1" }),
        ],
      ]),
      { pathPlatform: "windows" },
    );

    const result = await port.write(
      writeRequest({
        targetPath: "c:/notes/./a.md",
        expectedVersion: "v1",
      }),
    );

    expect(result.path).toBe("C:\\Notes\\A.md");
    expect((await port.openPath("c:/notes/a.md")).text).toBe("updated");
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

describe("documentReducer disk events", () => {
  const freshFile = (overrides: Partial<OpenedFile> = {}): OpenedFile =>
    openedFile({ text: "disk text", modifiedUnixMs: 200, version: "v2", ...overrides });

  it("reloads a clean tab on externalChanged and keeps it clean", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "externalChanged", id: "doc-1", file: freshFile() },
    ]);

    expect(state.tabs[0]).toMatchObject({
      text: "disk text",
      savedText: "disk text",
      modifiedUnixMs: 200,
      version: "v2",
      status: "clean",
    });
  });

  it("marks a dirty tab conflicted on externalChanged without overwriting local text", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edits" },
      { type: "externalChanged", id: "doc-1", file: freshFile() },
    ]);

    expect(state.tabs[0]).toMatchObject({
      text: "local edits",
      savedText: "saved",
      version: "v2",
      modifiedUnixMs: 200,
      status: "conflict",
    });
  });

  it("marks a tab conflicted when externalChanged arrives during a pending save", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edits" },
      { type: "saveRequested", id: "doc-1" },
      { type: "externalChanged", id: "doc-1", file: freshFile() },
    ]);

    expect(state.tabs[0]).toMatchObject({
      text: "local edits",
      version: "v2",
      status: "conflict",
    });
    expect(state.tabs[0].pendingSave).toBeDefined();
  });

  it("ignores externalChanged for unknown tabs", () => {
    const before = reduce([{ type: "fileOpened", id: "doc-1", file: openedFile() }]);
    const after = documentReducer(before, {
      type: "externalChanged",
      id: "ghost",
      file: freshFile(),
    });

    expect(after).toBe(before);
  });

  it("keeps the buffer and marks missing on externalMissing", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edits" },
      { type: "externalMissing", id: "doc-1" },
    ]);

    expect(state.tabs[0]).toMatchObject({ text: "local edits", status: "missing" });
  });

  it("moves a clean tab's path and title on externalMoved", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      {
        type: "externalMoved",
        from: "/Users/Alice/Notes/readme.md",
        to: "/Users/Alice/Notes/renamed.md",
      },
    ]);

    expect(state.tabs[0]).toMatchObject({
      path: "/Users/Alice/Notes/renamed.md",
      title: "renamed.md",
      text: "saved",
      status: "clean",
    });
  });

  it("matches the move source through the platform path key", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      {
        type: "externalMoved",
        from: "/users/alice/notes/./README.md",
        to: "/Users/Alice/Notes/renamed.md",
      },
    ]);

    expect(state.tabs[0].path).toBe("/Users/Alice/Notes/renamed.md");
  });

  it("keeps a dirty tab's path and text on externalMoved so edits stay saveable", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edits" },
      {
        type: "externalMoved",
        from: "/Users/Alice/Notes/readme.md",
        to: "/Users/Alice/Notes/renamed.md",
      },
    ]);

    expect(state.tabs[0]).toMatchObject({
      path: "/Users/Alice/Notes/readme.md",
      text: "local edits",
      status: "dirty",
    });
  });

  it("does not move a clean tab onto a path another tab already owns", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      {
        type: "fileOpened",
        id: "doc-2",
        file: openedFile({ path: "/Users/Alice/Notes/other.md" }),
      },
      {
        type: "externalMoved",
        from: "/Users/Alice/Notes/readme.md",
        to: "/users/alice/notes/OTHER.md",
      },
    ]);

    expect(state.tabs[0].path).toBe("/Users/Alice/Notes/readme.md");
    expect(state.tabs[1].path).toBe("/Users/Alice/Notes/other.md");
  });

  it("restores a recovery draft as a dirty tab keyed by its original path", () => {
    const state = reduce([
      {
        type: "documentRestored",
        id: "doc-1",
        draft: {
          draftId: "draft-document-7",
          originalPath: "/notes/a.md",
          title: "a.md",
          text: "unsaved work",
          hasUtf8Bom: true,
          newline: "cr_lf",
          savedTextHash: "hash",
          savedVersion: "v9",
        },
      },
    ]);

    expect(state.tabs[0]).toEqual({
      id: "doc-1",
      path: "/notes/a.md",
      title: "a.md",
      text: "unsaved work",
      savedText: "",
      hasUtf8Bom: true,
      newline: "cr_lf",
      modifiedUnixMs: null,
      version: "v9",
      status: "dirty",
    });
    expect(state.activeId).toBe("doc-1");
  });

  it("merges a restored draft into an already-open tab for the same path", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      {
        type: "documentRestored",
        id: "doc-2",
        draft: {
          draftId: "draft-document-7",
          originalPath: "/users/alice/notes/README.md",
          title: "readme.md",
          text: "unsaved work",
          hasUtf8Bom: false,
          newline: "lf",
          savedTextHash: "hash",
          savedVersion: "v1",
        },
      },
    ]);

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      id: "doc-1",
      text: "unsaved work",
      savedText: "saved",
      version: "v1",
      status: "dirty",
    });
    expect(state.activeId).toBe("doc-1");
  });

  it("focuses an existing tab instead of restoring onto the same tab id", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "newDocument", id: "doc-2" },
      {
        type: "documentRestored",
        id: "doc-1",
        draft: {
          draftId: "draft-document-1",
          originalPath: null,
          title: "Untitled",
          text: "ignored",
          hasUtf8Bom: false,
          newline: "lf",
          savedTextHash: "hash",
          savedVersion: null,
        },
      },
    ]);

    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0].text).toBe("saved");
    expect(state.activeId).toBe("doc-1");
  });

  it("replaces a conflicted tab with the loaded disk version on diskVersionLoaded", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edits" },
      { type: "externalChanged", id: "doc-1", file: freshFile() },
      { type: "diskVersionLoaded", id: "doc-1", file: freshFile({ version: "v3" }) },
    ]);

    expect(state.tabs[0]).toMatchObject({
      text: "disk text",
      savedText: "disk text",
      version: "v3",
      status: "clean",
    });
  });

  it("keeps local text and re-dirties the tab on conflictKeptLocal", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "textChanged", id: "doc-1", text: "local edits" },
      { type: "externalChanged", id: "doc-1", file: freshFile() },
      { type: "conflictKeptLocal", id: "doc-1" },
    ]);

    expect(state.tabs[0]).toMatchObject({
      text: "local edits",
      version: "v2",
      status: "dirty",
    });
  });

  it("resolves to clean on conflictKeptLocal when the buffer matches the saved text", () => {
    const state = reduce([
      { type: "fileOpened", id: "doc-1", file: openedFile() },
      { type: "externalConflict", id: "doc-1", modifiedUnixMs: 200, version: "v2" },
      { type: "conflictKeptLocal", id: "doc-1" },
    ]);

    expect(state.tabs[0]).toMatchObject({ text: "saved", status: "clean" });
  });
});
