import { describe, expect, it } from "vitest";
import { DocumentPortError } from "../document/DocumentPort";
import type {
  DocumentSnapshot,
  DocumentState,
  PathPlatform,
  RecoveryDraft,
  RecoveryDraftInfo,
} from "../document/types";
import { draftFromSnapshot, draftIdForTab, hashText } from "./drafts";
import {
  restoreDraft,
  type RestoreAdoption,
  type RestoreDraftHost,
  type RestoreDraftOutcome,
} from "./restoreDraft";

const draft = (overrides: Partial<RecoveryDraft> = {}): RecoveryDraft => ({
  draftId: "draft-document-9",
  originalPath: "/notes/a.md",
  title: "a.md",
  text: "未保存内容\n",
  hasUtf8Bom: false,
  newline: "lf",
  savedTextHash: hashText("已保存内容\n"),
  savedVersion: "v1",
  ...overrides,
});

const draftInfo = (
  overrides: Partial<RecoveryDraftInfo> = {},
): RecoveryDraftInfo => ({
  draftId: "draft-document-9",
  originalPath: "/notes/a.md",
  title: "a.md",
  savedTextHash: hashText("已保存内容\n"),
  savedVersion: "v1",
  updatedUnixMs: 1,
  ...overrides,
});

const tab = (overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({
  id: "document-1",
  path: "/notes/a.md",
  title: "a.md",
  text: "已保存内容\n",
  savedText: "已保存内容\n",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: "v1",
  status: "clean",
  ...overrides,
});

const state = (
  tabs: ReadonlyArray<DocumentSnapshot>,
  activeId: string | null = tabs[0]?.id ?? null,
): DocumentState => ({
  tabs,
  activeId,
  recentlyClosed: [],
  nextSaveSequence: 0,
});

const adoptedState = (
  tabs: ReadonlyArray<DocumentSnapshot>,
  added?: DocumentSnapshot,
): RestoreAdoption => ({ state: state(tabs), added });

const restored = (
  tabId: string,
  overrides: {
    readonly persisted?: boolean;
    readonly draftWriteFailed?: boolean;
  } = {},
): RestoreDraftOutcome => ({
  kind: "restored",
  tabId,
  persisted: overrides.persisted ?? true,
  draftWriteFailed: overrides.draftWriteFailed ?? false,
});

/** The fresh tab `documentRestored` appends for a draft with no open owner. */
const restoredTab = (id: string, recovered: RecoveryDraft): DocumentSnapshot =>
  tab({
    id,
    path: recovered.originalPath,
    title: recovered.title,
    text: recovered.text,
    savedText: "",
    hasUtf8Bom: recovered.hasUtf8Bom,
    newline: recovered.newline,
    modifiedUnixMs: null,
    version: recovered.savedVersion,
    status: "dirty",
  });

interface RecorderOptions {
  readonly generation?: number;
  readonly current?: boolean;
  readonly readDraft?: RecoveryDraft;
  readonly readError?: unknown;
  readonly createTabId?: string;
  readonly pathPlatform?: PathPlatform;
  readonly adopt?: (id: string, recovered: RecoveryDraft) => RestoreAdoption;
  readonly writeError?: unknown;
  readonly discardError?: unknown;
}

interface Recorder {
  readonly calls: string[];
  readonly writtenDrafts: RecoveryDraft[];
  readonly host: RestoreDraftHost;
}

const createRecorder = (options: RecorderOptions = {}): Recorder => {
  const calls: string[] = [];
  const writtenDrafts: RecoveryDraft[] = [];
  const recovered = options.readDraft ?? draft();
  const host: RestoreDraftHost = {
    generation: options.generation ?? 1,
    pathPlatform: options.pathPlatform ?? "macos",
    isCurrent(generation) {
      calls.push(`isCurrent:${generation}`);
      return options.current ?? true;
    },
    createTabId() {
      calls.push("createTabId");
      return options.createTabId ?? "document-2";
    },
    adoptDraft(id, adopted) {
      calls.push(`adoptDraft:${id}`);
      if (options.adopt) return options.adopt(id, adopted);
      const added = restoredTab(id, adopted);
      return adoptedState([tab(), added], added);
    },
    onOwnerReady(owner, created) {
      calls.push(`onOwnerReady:${owner.id}:${created ? "fresh" : "merged"}`);
    },
    markPersisted(id) {
      calls.push(`markPersisted:${id}`);
    },
    unmarkPersisted(id) {
      calls.push(`unmarkPersisted:${id}`);
    },
    async writeDraft(written) {
      calls.push(`writeDraft:${written.draftId}`);
      writtenDrafts.push(written);
      if (options.writeError) throw options.writeError;
      return {
        draftId: written.draftId,
        originalPath: written.originalPath,
        title: written.title,
        savedTextHash: written.savedTextHash,
        savedVersion: written.savedVersion,
        updatedUnixMs: 2,
      };
    },
    async discardDraft(draftId) {
      calls.push(`discardDraft:${draftId}`);
      if (options.discardError) throw options.discardError;
    },
    async readDraft(draftId) {
      calls.push(`readDraft:${draftId}`);
      if (options.readError) throw options.readError;
      return recovered;
    },
  };
  return { calls, writtenDrafts, host };
};

describe("restoreDraft", () => {
  it("reads, checks the generation, adopts, then ready → persist → discard", async () => {
    const recorder = createRecorder();

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-2"));
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
      "onOwnerReady:document-2:fresh",
      "markPersisted:document-2",
      `writeDraft:${draftIdForTab("document-2")}`,
      "discardDraft:draft-document-9",
    ]);
    // The owner draft is rebuilt from the adopted snapshot, so its saved-text
    // hash/version describe the tab now holding the recovered text.
    expect(recorder.writtenDrafts).toEqual([
      draftFromSnapshot(restoredTab("document-2", draft())),
    ]);
  });

  it("prefers the freshly created tab over a same-path merged tab", async () => {
    const recovered = draft();
    const merged = tab({
      id: "document-7",
      path: "/notes/A.md",
      text: recovered.text,
      savedText: "旧内容\n",
      status: "dirty",
    });
    const recorder = createRecorder({
      readDraft: recovered,
      adopt: (id) => {
        const added = restoredTab(id, recovered);
        return adoptedState([merged, added], added);
      },
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-2"));
    expect(recorder.calls).toContain("onOwnerReady:document-2:fresh");
    expect(recorder.calls).not.toContain("onOwnerReady:document-7:merged");
    expect(recorder.writtenDrafts.map((written) => written.draftId)).toEqual([
      draftIdForTab("document-2"),
    ]);
  });

  it("reports a merged owner as not created, ready before its draft write", async () => {
    const recovered = draft({ originalPath: "/notes/a.md" });
    const merged = tab({
      id: "document-7",
      path: "/notes/A.md",
      text: recovered.text,
      savedText: "旧内容\n",
      status: "dirty",
    });
    const recorder = createRecorder({
      readDraft: recovered,
      adopt: () => adoptedState([merged]),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-7"));
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
      "onOwnerReady:document-7:merged",
      "markPersisted:document-7",
      `writeDraft:${draftIdForTab("document-7")}`,
      "discardDraft:draft-document-9",
    ]);
  });

  it("uses the host path platform for merged-owner normalization", async () => {
    const recovered = draft({ originalPath: "C:\\notes\\a.md" });
    const merged = tab({
      id: "document-7",
      path: "c:/notes/a.md",
      text: recovered.text,
      savedText: "旧内容\n",
      status: "dirty",
    });
    const recorder = createRecorder({
      readDraft: recovered,
      pathPlatform: "windows",
      adopt: () => adoptedState([merged]),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-7"));
    expect(recorder.calls).toContain("onOwnerReady:document-7:merged");
  });

  it("refuses a same-path tab that does not hold the recovered text", async () => {
    const recorder = createRecorder({
      adopt: () =>
        adoptedState([
          tab({ id: "document-7", text: "别的文字", status: "dirty" }),
        ]),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "refused" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
    ]);
    expect(recorder.writtenDrafts).toEqual([]);
  });

  it("refuses an ownerless restore without writing or deleting", async () => {
    const recovered = draft({ originalPath: null, title: "Untitled" });
    const recorder = createRecorder({
      readDraft: recovered,
      adopt: () => adoptedState([]),
    });

    const outcome = await restoreDraft(draftInfo({ originalPath: null }), recorder.host);

    expect(outcome).toEqual({ kind: "refused" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
    ]);
  });

  it("refuses a colliding createTabId instead of treating the existing tab as new", async () => {
    const existing = tab({
      id: "document-1",
      text: "已有内容\n",
      status: "dirty",
    });
    const recorder = createRecorder({
      createTabId: "document-1",
      adopt: () => adoptedState([existing]),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "refused" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-1",
    ]);
    expect(recorder.writtenDrafts).toEqual([]);
  });

  it("treats a colliding id holding the recovered text as merged, never fresh", async () => {
    const recovered = draft();
    const existing = tab({
      id: "document-1",
      text: recovered.text,
      savedText: "旧内容\n",
      status: "dirty",
    });
    const recorder = createRecorder({
      readDraft: recovered,
      createTabId: "document-1",
      adopt: () => adoptedState([existing]),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-1"));
    expect(recorder.calls).toContain("onOwnerReady:document-1:merged");
    expect(recorder.calls).toContain(`writeDraft:${draftIdForTab("document-1")}`);
    expect(recorder.calls).toContain("discardDraft:draft-document-9");
  });

  it("ignores an added tab that does not actually exist in the adopted state", async () => {
    const recovered = draft();
    const ghost = restoredTab("document-2", recovered);
    const existing = tab({
      id: "document-1",
      text: "别的文字\n",
      status: "dirty",
    });
    const recorder = createRecorder({
      readDraft: recovered,
      adopt: () => ({ state: state([existing]), added: ghost }),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "refused" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
    ]);
    expect(recorder.writtenDrafts).toEqual([]);
  });

  it("skips the owner write for a clean owner and still discards the leftover", async () => {
    const recovered = draft();
    const recorder = createRecorder({
      readDraft: recovered,
      adopt: (id) => {
        const added = tab({
          id,
          text: recovered.text,
          savedText: recovered.text,
          status: "clean",
        });
        return adoptedState([added], added);
      },
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-2"));
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
      "onOwnerReady:document-2:fresh",
      "discardDraft:draft-document-9",
    ]);
    expect(recorder.writtenDrafts).toEqual([]);
  });

  it("persists an owner whose status is not clean even when its text matches", async () => {
    const recovered = draft();
    const recorder = createRecorder({
      readDraft: recovered,
      adopt: (id) => {
        const added = tab({
          id,
          text: recovered.text,
          savedText: recovered.text,
          status: "conflict",
        });
        return adoptedState([added], added);
      },
    });

    await restoreDraft(draftInfo(), recorder.host);

    expect(recorder.calls).toContain("markPersisted:document-2");
    expect(recorder.calls).toContain(`writeDraft:${draftIdForTab("document-2")}`);
    expect(recorder.calls).toContain("discardDraft:draft-document-9");
  });

  it("keeps the leftover and unmarks the owner when its draft write fails", async () => {
    const writeError = new Error("disk full");
    const recorder = createRecorder({ writeError });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(
      restored("document-2", { persisted: false, draftWriteFailed: true }),
    );
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
      "onOwnerReady:document-2:fresh",
      "markPersisted:document-2",
      `writeDraft:${draftIdForTab("document-2")}`,
      "unmarkPersisted:document-2",
    ]);
  });

  it("keeps the leftover and unmarks the owner when writeDraft throws synchronously", async () => {
    const writeError = new Error("sync write failure");
    const recorder = createRecorder();
    recorder.host.writeDraft = (written) => {
      recorder.calls.push(`writeDraft:${written.draftId}`);
      throw writeError;
    };

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(
      restored("document-2", { persisted: false, draftWriteFailed: true }),
    );
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
      "onOwnerReady:document-2:fresh",
      "markPersisted:document-2",
      `writeDraft:${draftIdForTab("document-2")}`,
      "unmarkPersisted:document-2",
    ]);
  });

  it("never discards the leftover whose id the owner reused", async () => {
    const recovered = draft({ draftId: draftIdForTab("document-2") });
    const recorder = createRecorder({ readDraft: recovered });

    const outcome = await restoreDraft(
      draftInfo({ draftId: draftIdForTab("document-2") }),
      recorder.host,
    );

    expect(outcome).toEqual(restored("document-2"));
    expect(recorder.calls).toContain(`writeDraft:${draftIdForTab("document-2")}`);
    expect(recorder.calls).not.toContain(
      `discardDraft:${draftIdForTab("document-2")}`,
    );
  });

  it("never discards a reused id even when the owner needs no write", async () => {
    const recovered = draft({ draftId: draftIdForTab("document-2") });
    const recorder = createRecorder({
      readDraft: recovered,
      adopt: (id) => {
        const added = tab({
          id,
          text: recovered.text,
          savedText: recovered.text,
          status: "clean",
        });
        return adoptedState([added], added);
      },
    });

    await restoreDraft(
      draftInfo({ draftId: draftIdForTab("document-2") }),
      recorder.host,
    );

    expect(recorder.writtenDrafts).toEqual([]);
    expect(recorder.calls.some((call) => call.startsWith("discardDraft"))).toBe(false);
  });

  it("writes the namespaced owner copy before discarding a legacy draft id", async () => {
    const recovered = draft({ draftId: "draft-document-9" });
    const recorder = createRecorder({ readDraft: recovered });
    const ownerDraftId = draftIdForTab("document-2");

    const outcome = await restoreDraft(
      draftInfo({ draftId: "draft-document-9" }),
      recorder.host,
    );

    expect(ownerDraftId).not.toBe("draft-document-9");
    expect(outcome).toEqual(restored("document-2"));
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
      "createTabId",
      "adoptDraft:document-2",
      "onOwnerReady:document-2:fresh",
      "markPersisted:document-2",
      `writeDraft:${ownerDraftId}`,
      "discardDraft:draft-document-9",
    ]);
    expect(recorder.writtenDrafts.map((written) => written.draftId)).toEqual([
      ownerDraftId,
    ]);
  });

  it("refuses a draft whose returned id does not match the requested leftover", async () => {
    const recorder = createRecorder({
      readDraft: draft({ draftId: "draft-other-9" }),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "refused" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
    ]);
    expect(recorder.writtenDrafts).toEqual([]);
  });

  it("returns missing for a draft that is already gone", async () => {
    const recorder = createRecorder({
      readError: new DocumentPortError("not_found", "no such draft"),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "missing" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
    ]);
  });

  it("returns error for a failed read without touching the tab state", async () => {
    const readError = new DocumentPortError("io", "store unavailable");
    const recorder = createRecorder({ readError });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "error", error: readError });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
    ]);
  });

  it("returns stale when the lifecycle moved on after the read", async () => {
    const recorder = createRecorder({ current: false });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "stale" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
    ]);
  });

  it("returns stale for a missing draft after the lifecycle moved on", async () => {
    const recorder = createRecorder({
      current: false,
      readError: new DocumentPortError("not_found", "no such draft"),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "stale" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
    ]);
  });

  it("returns stale for a failed read after the lifecycle moved on", async () => {
    const recorder = createRecorder({
      current: false,
      readError: new DocumentPortError("io", "store unavailable"),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "stale" });
    expect(recorder.calls).toEqual([
      "readDraft:draft-document-9",
      "isCurrent:1",
    ]);
  });

  it("ignores a failing leftover discard", async () => {
    const recorder = createRecorder({
      discardError: new Error("already removed"),
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-2"));
    expect(recorder.calls).toContain("discardDraft:draft-document-9");
  });

  it("swallows a synchronous throw from the leftover discard", async () => {
    const discardError = new Error("sync discard failure");
    const recorder = createRecorder();
    recorder.host.discardDraft = (draftId) => {
      recorder.calls.push(`discardDraft:${draftId}`);
      throw discardError;
    };

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-2"));
    expect(recorder.calls).toContain("discardDraft:draft-document-9");
  });

  it("does not await the fire-and-forget leftover discard", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recorder = createRecorder();
    recorder.host.discardDraft = async (draftId) => {
      recorder.calls.push(`discardDraft:${draftId}`);
      await gate;
    };

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual(restored("document-2"));
    expect(recorder.calls).toContain("discardDraft:draft-document-9");
    release();
    await gate;
  });

  it("never rejects when adoption throws", async () => {
    const adoptError = new Error("reducer bug");
    const recorder = createRecorder({
      adopt: () => {
        throw adoptError;
      },
    });

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "error", error: adoptError });
    expect(recorder.writtenDrafts).toEqual([]);
    expect(recorder.calls.some((call) => call.startsWith("discardDraft"))).toBe(false);
  });

  it("never rejects when the owner-ready hook throws", async () => {
    const hookError = new Error("scope acquisition failed");
    const recorder = createRecorder();
    recorder.host.onOwnerReady = () => {
      recorder.calls.push("onOwnerReady:throw");
      throw hookError;
    };

    const outcome = await restoreDraft(draftInfo(), recorder.host);

    expect(outcome).toEqual({ kind: "error", error: hookError });
    expect(recorder.writtenDrafts).toEqual([]);
    expect(recorder.calls.some((call) => call.startsWith("discardDraft"))).toBe(false);
  });
});
