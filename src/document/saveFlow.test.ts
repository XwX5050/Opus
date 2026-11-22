import { describe, expect, it } from "vitest";
import { DocumentPortError } from "./DocumentPort";
import type { SavedFile } from "./DocumentPort";
import {
  documentReducer,
  initialDocumentState,
  type DocumentAction,
  type DocumentState,
} from "./documentReducer";
import {
  createSaveFlow,
  type SaveFailure,
  type SaveFlow,
  type SaveFlowHost,
} from "./saveFlow";
import type {
  DocumentSnapshot,
  OpenedFile,
  PathPlatform,
  PendingWriteRequest,
  SaveTarget,
} from "./types";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const savedFile = (path: string, version = "v2"): SavedFile => ({
  path,
  modifiedUnixMs: 200,
  version,
});

const fileAt = (
  path: string,
  overrides: Partial<OpenedFile> = {},
): OpenedFile => ({
  path,
  text: `text of ${path}`,
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 100,
  version: `version of ${path}`,
  ...overrides,
});

type ChooseHandler = (suggestedName: string) => Promise<SaveTarget | null>;
type WriteHandler = (
  request: PendingWriteRequest,
) => Promise<SavedFile>;

interface FakePort {
  readonly chooseCalls: ReadonlyArray<string>;
  readonly writeCalls: ReadonlyArray<PendingWriteRequest>;
  setChooseHandler: (handler: ChooseHandler) => void;
  setWriteHandler: (handler: WriteHandler) => void;
  chooseSavePath: ChooseHandler;
  write: WriteHandler;
}

const createFakePort = (): FakePort => {
  const chooseCalls: string[] = [];
  const writeCalls: PendingWriteRequest[] = [];
  let chooseHandler: ChooseHandler = async () => null;
  let writeHandler: WriteHandler = async (request) =>
    savedFile(request.targetPath);

  return {
    chooseCalls,
    writeCalls,
    setChooseHandler(handler) {
      chooseHandler = handler;
    },
    setWriteHandler(handler) {
      writeHandler = handler;
    },
    chooseSavePath: (suggestedName) => {
      chooseCalls.push(suggestedName);
      return chooseHandler(suggestedName);
    },
    write: (request) => {
      writeCalls.push(request);
      return writeHandler(request);
    },
  };
};

interface RetargetCall {
  readonly tabId: string;
  readonly path: string | null;
  readonly previousPath: string | null;
}

type RetargetBehavior = "ok" | "throw" | "reject";

interface Harness {
  readonly flow: SaveFlow;
  readonly port: FakePort;
  readonly visibleTranslations: Set<string>;
  readonly failures: ReadonlyArray<SaveFailure>;
  readonly banners: ReadonlyArray<string>;
  readonly clearCalls: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<DocumentAction>;
  readonly retargets: ReadonlyArray<RetargetCall>;
  state: () => DocumentState;
  tab: (id: string) => DocumentSnapshot | undefined;
  dispatch: (action: DocumentAction) => DocumentState;
  setGeneration: (generation: number) => void;
  setActive: (active: boolean) => void;
  setRetargetBehavior: (behavior: RetargetBehavior) => void;
  open: (
    id: string,
    path: string,
    overrides?: Partial<OpenedFile>,
  ) => void;
  edit: (id: string, text: string) => void;
}

const createHarness = (
  options: { readonly platform?: PathPlatform } = {},
): Harness => {
  const platform = options.platform ?? "linux";
  const port = createFakePort();
  let state = initialDocumentState;
  let generation = 1;
  let active = true;
  let retargetBehavior: RetargetBehavior = "ok";
  const actions: DocumentAction[] = [];
  const failures: SaveFailure[] = [];
  const banners: string[] = [];
  const clearCalls: string[] = [];
  const retargets: RetargetCall[] = [];
  const visibleTranslations = new Set<string>();

  const dispatch = (action: DocumentAction): DocumentState => {
    actions.push(action);
    state = documentReducer(state, action);
    return state;
  };

  const host: SaveFlowHost = {
    getState: () => state,
    dispatch,
    generation: () => generation,
    isCurrent: (candidate) => active && candidate === generation,
    chooseSavePath: port.chooseSavePath,
    write: port.write,
    translationVisible: (tabId) => visibleTranslations.has(tabId),
    pathPlatform: platform,
    clearBanner: () => {
      clearCalls.push("clear");
    },
    showBanner: (message) => banners.push(message),
    reportSaveFailure: (failure) => failures.push(failure),
    onRetarget: (tabId, tab, previousPath) => {
      retargets.push({ tabId, path: tab.path, previousPath });
      if (retargetBehavior === "throw") throw new Error("retarget hook failed");
      if (retargetBehavior === "reject") {
        return Promise.reject(new Error("retarget hook rejected"));
      }
    },
  };

  const flow = createSaveFlow(host);
  const open = (
    id: string,
    path: string,
    overrides: Partial<OpenedFile> = {},
  ): void => {
    dispatch({
      type: "fileOpened",
      id,
      file: fileAt(path, overrides),
      pathPlatform: platform,
    });
  };
  const edit = (id: string, text: string): void => {
    dispatch({ type: "textChanged", id, text });
  };

  return {
    flow,
    port,
    visibleTranslations,
    failures,
    banners,
    clearCalls,
    actions,
    retargets,
    state: () => state,
    tab: (id) => state.tabs.find((tab) => tab.id === id),
    dispatch,
    setGeneration: (next) => {
      generation = next;
    },
    setActive: (next) => {
      active = next;
    },
    setRetargetBehavior: (behavior) => {
      retargetBehavior = behavior;
    },
    open,
    edit,
  };
};

const savedPhaseActions = (harness: Harness): DocumentAction[] =>
  harness.actions.filter(
    (action) =>
      action.type === "saveSucceeded" ||
      action.type === "saveFailed" ||
      action.type === "saveCancelled",
  );

describe("saveFlow", () => {
  it("writes the reducer's frozen pending request at the tab's existing path", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    const write = deferred<SavedFile>();
    harness.port.setWriteHandler(() => write.promise);

    const running = harness.flow.save("doc-1", "save");

    expect(harness.port.chooseCalls).toEqual([]);
    expect(harness.port.writeCalls).toHaveLength(1);
    const request = harness.port.writeCalls[0];
    expect(request).toBe(harness.tab("doc-1")?.pendingSave);
    expect(Object.isFrozen(request)).toBe(true);
    expect(request).toMatchObject({
      documentId: "doc-1",
      targetPath: "/notes/a.md",
      text: "updated",
      expectedVersion: "version of /notes/a.md",
      pathPlatform: "linux",
    });

    write.resolve(savedFile("/notes/a.md"));

    await expect(running).resolves.toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: false,
    });
    expect(harness.tab("doc-1")).toMatchObject({
      path: "/notes/a.md",
      status: "clean",
      savedText: "updated",
      modifiedUnixMs: 200,
      version: "v2",
    });
    expect(harness.tab("doc-1")?.pendingSave).toBeUndefined();
    expect(harness.retargets).toEqual([]);
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual([]);
  });

  it("save-as asks for a target with the tab title and commits the chosen path", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.port.setChooseHandler(async () => ({
      path: "/notes/renamed.md",
      expectedVersion: "version of /notes/a.md",
    }));

    const outcome = await harness.flow.save("doc-1", "save-as");

    expect(outcome).toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: true,
    });
    expect(harness.port.chooseCalls).toEqual(["a.md"]);
    expect(harness.port.writeCalls).toHaveLength(1);
    expect(harness.port.writeCalls[0]).toMatchObject({
      targetPath: "/notes/renamed.md",
      expectedVersion: "version of /notes/a.md",
    });
    expect(harness.tab("doc-1")).toMatchObject({
      path: "/notes/renamed.md",
      title: "renamed.md",
      status: "clean",
    });
    expect(harness.retargets).toEqual([
      {
        tabId: "doc-1",
        path: "/notes/renamed.md",
        previousPath: "/notes/a.md",
      },
    ]);
  });

  it("close saves the buffer at the current path without opening the selector", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");

    const outcome = await harness.flow.save("doc-1", "close");

    expect(outcome).toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: false,
    });
    expect(harness.port.chooseCalls).toEqual([]);
    expect(harness.port.writeCalls).toHaveLength(1);
    expect(harness.actions.some((action) => action.type === "closeConfirmed")).toBe(
      false,
    );
  });

  it("makes a tab busy before its first await and keeps other tabs parallel", async () => {
    const harness = createHarness();
    harness.dispatch({ type: "newDocument", id: "doc-1" });
    harness.edit("doc-1", "draft");
    const chooser = deferred<SaveTarget | null>();
    harness.port.setChooseHandler(() => chooser.promise);

    const first = harness.flow.save("doc-1", "save");
    expect(harness.flow.isSaving("doc-1")).toBe(true);
    expect(harness.clearCalls).toHaveLength(1);

    const second = await harness.flow.save("doc-1", "save");
    expect(second).toEqual({
      kind: "skipped",
      tabId: "doc-1",
      reason: "busy",
    });
    expect(harness.port.chooseCalls).toHaveLength(1);
    expect(harness.clearCalls).toHaveLength(1);

    harness.open("doc-2", "/notes/b.md");
    harness.edit("doc-2", "other");
    const parallel = harness.flow.save("doc-2", "save");
    expect(harness.flow.isSaving("doc-2")).toBe(true);
    expect(harness.port.writeCalls).toHaveLength(1);
    expect(harness.port.writeCalls[0].documentId).toBe("doc-2");

    chooser.resolve({ path: "/notes/new.md", expectedVersion: null });
    await expect(first).resolves.toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: true,
    });
    await expect(parallel).resolves.toMatchObject({
      kind: "saved",
      tabId: "doc-2",
      retargeted: false,
    });
  });

  it("clears the banner only after prechecks pass and the tab is locked", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.visibleTranslations.add("doc-1");

    await harness.flow.save("doc-1", "save");
    expect(harness.clearCalls).toEqual([]);

    await harness.flow.save("missing", "save");
    expect(harness.clearCalls).toEqual([]);

    harness.open("doc-2", "/notes/b.md");
    harness.edit("doc-2", "updated b");
    harness.dispatch({
      type: "saveRequested",
      id: "doc-2",
      pathPlatform: "linux",
    });
    await harness.flow.save("doc-2", "save");
    expect(harness.clearCalls).toEqual([]);

    harness.open("doc-3", "/notes/c.md");
    harness.edit("doc-3", "updated c");
    await harness.flow.save("doc-3", "save");
    expect(harness.clearCalls).toHaveLength(1);
  });

  it("lets two different tabs write concurrently", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated a");
    harness.open("doc-2", "/notes/b.md");
    harness.edit("doc-2", "updated b");
    const writes: Deferred<SavedFile>[] = [];
    harness.port.setWriteHandler(() => {
      const write = deferred<SavedFile>();
      writes.push(write);
      return write.promise;
    });

    const first = harness.flow.save("doc-1", "save");
    const second = harness.flow.save("doc-2", "save");

    expect(harness.port.writeCalls).toHaveLength(2);
    expect(harness.flow.isSaving("doc-1")).toBe(true);
    expect(harness.flow.isSaving("doc-2")).toBe(true);

    writes[0].resolve(savedFile("/notes/a.md"));
    await expect(first).resolves.toMatchObject({
      kind: "saved",
      tabId: "doc-1",
    });
    expect(harness.flow.isSaving("doc-2")).toBe(true);

    writes[1].resolve(savedFile("/notes/b.md"));
    await expect(second).resolves.toMatchObject({
      kind: "saved",
      tabId: "doc-2",
    });
    expect(harness.flow.isSaving("doc-1")).toBe(false);
    expect(harness.flow.isSaving("doc-2")).toBe(false);
  });

  it("refuses a second attempt on the same tab while its write is pending", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    const write = deferred<SavedFile>();
    harness.port.setWriteHandler(() => write.promise);

    const first = harness.flow.save("doc-1", "save");
    expect(harness.port.writeCalls).toHaveLength(1);
    expect(harness.flow.isSaving("doc-1")).toBe(true);

    const second = await harness.flow.save("doc-1", "close");
    expect(second).toEqual({
      kind: "skipped",
      tabId: "doc-1",
      reason: "busy",
    });
    expect(harness.port.writeCalls).toHaveLength(1);
    expect(harness.clearCalls).toHaveLength(1);

    write.resolve(savedFile("/notes/a.md"));
    await expect(first).resolves.toMatchObject({
      kind: "saved",
      tabId: "doc-1",
    });
    expect(harness.flow.isSaving("doc-1")).toBe(false);
  });

  it("releases the per-tab lock in finally so a failed save can retry", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    let calls = 0;
    harness.port.setWriteHandler((request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new DocumentPortError("io", "disk full"));
      }
      return Promise.resolve(savedFile(request.targetPath));
    });

    const failed = await harness.flow.save("doc-1", "save");

    expect(failed).toMatchObject({
      kind: "failed",
      tabId: "doc-1",
      error: { code: "io", message: "disk full" },
    });
    expect(harness.flow.isSaving("doc-1")).toBe(false);
    expect(harness.tab("doc-1")?.pendingSave).toBeUndefined();

    const retried = await harness.flow.save("doc-1", "save");

    expect(retried).toMatchObject({ kind: "saved", tabId: "doc-1" });
    expect(calls).toBe(2);
    expect(harness.tab("doc-1")?.status).toBe("clean");
  });

  it("blocks only the plain save intent while a translation is visible", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.visibleTranslations.add("doc-1");

    const blocked = await harness.flow.save("doc-1", "save");

    expect(blocked).toEqual({
      kind: "blocked",
      tabId: "doc-1",
      reason: "translation-visible",
    });
    expect(harness.port.writeCalls).toEqual([]);
    expect(harness.flow.isSaving("doc-1")).toBe(false);

    harness.port.setChooseHandler(async () => ({
      path: "/notes/a.md",
      expectedVersion: "version of /notes/a.md",
    }));
    const savedAs = await harness.flow.save("doc-1", "save-as");
    expect(savedAs).toMatchObject({ kind: "saved", tabId: "doc-1" });
    expect(harness.port.writeCalls).toHaveLength(1);

    harness.open("doc-2", "/notes/b.md");
    harness.edit("doc-2", "other");
    harness.visibleTranslations.add("doc-2");
    const closed = await harness.flow.save("doc-2", "close");
    expect(closed).toMatchObject({ kind: "saved", tabId: "doc-2" });
    expect(harness.port.writeCalls).toHaveLength(2);
  });

  it("reports chooser cancellation without touching the document and unlocks", async () => {
    const harness = createHarness();
    harness.dispatch({ type: "newDocument", id: "doc-1" });
    harness.edit("doc-1", "draft");

    const cancelled = await harness.flow.save("doc-1", "save");

    expect(cancelled).toEqual({ kind: "cancelled", tabId: "doc-1" });
    expect(
      harness.actions.some((action) => action.type === "saveRequested"),
    ).toBe(false);
    expect(harness.port.writeCalls).toEqual([]);
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual([]);
    expect(harness.clearCalls).toHaveLength(1);
    expect(harness.flow.isSaving("doc-1")).toBe(false);

    harness.port.setChooseHandler(async () => ({
      path: "/notes/new.md",
      expectedVersion: null,
    }));
    const retried = await harness.flow.save("doc-1", "save");

    expect(retried).toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: true,
    });
    expect(harness.tab("doc-1")?.path).toBe("/notes/new.md");
    expect(harness.clearCalls).toHaveLength(2);
  });

  it("defaults to the active tab and skips when no tab is active", async () => {
    const harness = createHarness();

    await expect(harness.flow.save(undefined, "save")).resolves.toEqual({
      kind: "skipped",
      tabId: null,
      reason: "missing",
    });

    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");

    await expect(harness.flow.save(undefined, "save")).resolves.toMatchObject({
      kind: "saved",
      tabId: "doc-1",
    });
  });

  it("wraps a selector failure as io and releases the lock for a retry", async () => {
    const harness = createHarness();
    harness.dispatch({ type: "newDocument", id: "doc-1" });
    harness.edit("doc-1", "draft");
    const cause = new Error("picker failed");
    harness.port.setChooseHandler(() => Promise.reject(cause));

    const outcome = await harness.flow.save("doc-1", "save");

    expect(outcome).toMatchObject({
      kind: "failed",
      tabId: "doc-1",
      error: { code: "io", message: "picker failed" },
    });
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual(["picker failed"]);
    expect(harness.clearCalls).toHaveLength(1);
    expect(harness.flow.isSaving("doc-1")).toBe(false);
    expect(harness.port.writeCalls).toEqual([]);

    harness.port.setChooseHandler(async () => ({
      path: "/notes/new.md",
      expectedVersion: null,
    }));
    await expect(harness.flow.save("doc-1", "save")).resolves.toMatchObject({
      kind: "saved",
      tabId: "doc-1",
    });
  });

  it("skips a missing tab and a tab that already has a pending write", async () => {
    const harness = createHarness();

    await expect(harness.flow.save("missing", "save")).resolves.toEqual({
      kind: "skipped",
      tabId: "missing",
      reason: "missing",
    });

    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.dispatch({
      type: "saveRequested",
      id: "doc-1",
      pathPlatform: "linux",
    });

    await expect(harness.flow.save("doc-1", "save")).resolves.toEqual({
      kind: "skipped",
      tabId: "doc-1",
      reason: "busy",
    });
    expect(harness.port.writeCalls).toEqual([]);
  });

  it("skips when a pending write appears while the target selector is open", async () => {
    const harness = createHarness();
    harness.dispatch({ type: "newDocument", id: "doc-1" });
    harness.edit("doc-1", "draft");
    harness.port.setChooseHandler(async () => {
      harness.dispatch({
        type: "saveRequested",
        id: "doc-1",
        pathPlatform: "linux",
        target: { path: "/notes/other.md", expectedVersion: null },
      });
      return { path: "/notes/new.md", expectedVersion: null };
    });

    const outcome = await harness.flow.save("doc-1", "save");

    expect(outcome).toEqual({
      kind: "skipped",
      tabId: "doc-1",
      reason: "busy",
    });
    expect(harness.port.writeCalls).toEqual([]);
    expect(harness.clearCalls).toHaveLength(1);
    expect(harness.tab("doc-1")?.path).toBeNull();
    expect(harness.tab("doc-1")?.pendingSave).toBeDefined();
  });

  it("classifies a target opened in another tab without issuing a write", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.open("doc-2", "/notes/b.md");
    harness.edit("doc-2", "updated");
    harness.port.setChooseHandler(async () => ({
      path: "/notes/a.md",
      expectedVersion: "version of /notes/b.md",
    }));

    const outcome = await harness.flow.save("doc-2", "save-as");

    expect(outcome).toMatchObject({
      kind: "target-conflict",
      tabId: "doc-2",
      error: { code: "conflict" },
    });
    expect(harness.port.writeCalls).toEqual([]);
    expect(harness.tab("doc-2")?.pendingSave).toBeUndefined();
    expect(harness.tab("doc-2")?.status).toBe("dirty");
    expect(harness.banners).toHaveLength(1);
    expect(harness.failures).toEqual([]);
  });

  it("classifies a target collision with a third tab", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.open("doc-2", "/notes/b.md");
    harness.open("doc-3", "/notes/c.md");
    harness.edit("doc-1", "updated");
    harness.port.setChooseHandler(async () => ({
      path: "/notes/c.md",
      expectedVersion: "version of /notes/a.md",
    }));

    const outcome = await harness.flow.save("doc-1", "save-as");

    expect(outcome).toMatchObject({
      kind: "target-conflict",
      tabId: "doc-1",
      error: { code: "conflict" },
    });
    expect(harness.port.writeCalls).toEqual([]);
    expect(harness.tab("doc-1")?.pendingSave).toBeUndefined();
    expect(harness.tab("doc-2")?.path).toBe("/notes/b.md");
    expect(harness.tab("doc-3")?.path).toBe("/notes/c.md");
    expect(harness.tab("doc-3")?.status).toBe("clean");
    expect(harness.banners).toHaveLength(1);
    expect(harness.failures).toEqual([]);
  });

  it("classifies a write result that disagrees with the target as a conflict", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.port.setWriteHandler(async () => savedFile("/notes/other.md"));

    const outcome = await harness.flow.save("doc-1", "save");

    expect(outcome).toMatchObject({
      kind: "write-conflict",
      tabId: "doc-1",
      error: { code: "conflict" },
    });
    expect(harness.tab("doc-1")?.status).toBe("conflict");
    expect(harness.tab("doc-1")?.pendingSave).toBeUndefined();
    expect(harness.banners).toHaveLength(1);
    expect(harness.failures).toEqual([]);
  });

  it("routes a close-save failure to the banner and a standalone failure to SaveFailure", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.port.setWriteHandler(() =>
      Promise.reject(new DocumentPortError("permission_denied", "denied")),
    );

    const standalone = await harness.flow.save("doc-1", "save");

    expect(standalone).toMatchObject({
      kind: "failed",
      tabId: "doc-1",
      error: { code: "permission_denied" },
    });
    expect(harness.failures).toEqual([
      { id: "doc-1", message: "denied" },
    ]);
    expect(harness.banners).toEqual([]);

    const close = await harness.flow.save("doc-1", "close");

    expect(close).toMatchObject({ kind: "failed", tabId: "doc-1" });
    expect(harness.banners).toEqual(["denied"]);
    expect(harness.failures).toHaveLength(1);
    expect(harness.tab("doc-1")?.pendingSave).toBeUndefined();
  });

  it("wraps a non-DocumentPortError write failure as io", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    const cause = new Error("disk exploded");
    harness.port.setWriteHandler(() => Promise.reject(cause));

    const outcome = await harness.flow.save("doc-1", "save");

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.error).toBeInstanceOf(DocumentPortError);
    expect(outcome.error.code).toBe("io");
    expect(outcome.error.message).toBe("disk exploded");
    expect(outcome.error.cause).toBe(cause);
    expect(harness.failures).toEqual([
      { id: "doc-1", message: "disk exploded" },
    ]);
    expect(savedPhaseActions(harness)).toEqual([
      expect.objectContaining({ type: "saveFailed" }),
    ]);
  });

  it("returns stale at entry when the lifecycle is no longer current", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.setActive(false);
    const actionsBefore = harness.actions.length;

    const outcome = await harness.flow.save("doc-1", "save");

    expect(outcome).toEqual({ kind: "stale", tabId: "doc-1" });
    expect(harness.actions).toHaveLength(actionsBefore);
    expect(harness.port.writeCalls).toEqual([]);
    expect(harness.clearCalls).toEqual([]);
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual([]);
    expect(harness.flow.isSaving("doc-1")).toBe(false);
  });

  it("does not commit or report a completion from a stale generation", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    const write = deferred<SavedFile>();
    harness.port.setWriteHandler(() => write.promise);

    const running = harness.flow.save("doc-1", "save");
    const actionsBefore = harness.actions.length;
    harness.setGeneration(2);
    write.resolve(savedFile("/notes/a.md"));

    await expect(running).resolves.toEqual({
      kind: "stale",
      tabId: "doc-1",
    });
    expect(harness.actions).toHaveLength(actionsBefore);
    expect(savedPhaseActions(harness)).toEqual([]);
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual([]);
    expect(harness.retargets).toEqual([]);
    expect(harness.tab("doc-1")?.pendingSave).toBeDefined();
    expect(harness.flow.isSaving("doc-1")).toBe(false);
  });

  it("returns stale when the write rejects after the lifecycle changed", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    const write = deferred<SavedFile>();
    harness.port.setWriteHandler(() => write.promise);

    const running = harness.flow.save("doc-1", "save");
    harness.setGeneration(2);
    write.reject(new Error("disk gone"));

    await expect(running).resolves.toEqual({
      kind: "stale",
      tabId: "doc-1",
    });
    expect(savedPhaseActions(harness)).toEqual([]);
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual([]);
    expect(harness.retargets).toEqual([]);
    expect(harness.tab("doc-1")?.pendingSave).toBeDefined();
    expect(harness.flow.isSaving("doc-1")).toBe(false);
  });

  it("does not request a write when the generation goes stale during target selection", async () => {
    const harness = createHarness();
    harness.dispatch({ type: "newDocument", id: "doc-1" });
    harness.edit("doc-1", "draft");
    const chooser = deferred<SaveTarget | null>();
    harness.port.setChooseHandler(() => chooser.promise);

    const running = harness.flow.save("doc-1", "save");
    harness.setGeneration(2);
    chooser.resolve({ path: "/notes/new.md", expectedVersion: null });

    await expect(running).resolves.toEqual({
      kind: "stale",
      tabId: "doc-1",
    });
    expect(
      harness.actions.some((action) => action.type === "saveRequested"),
    ).toBe(false);
    expect(harness.port.writeCalls).toEqual([]);
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual([]);
  });

  it("does not notify retarget when the written path is already the same path", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");

    await harness.flow.save("doc-1", "save");

    expect(harness.retargets).toEqual([]);
  });

  it("does not notify retarget when only the spelling of the path changes", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.port.setChooseHandler(async () => ({
      path: "/notes/./a.md",
      expectedVersion: "version of /notes/a.md",
    }));

    const outcome = await harness.flow.save("doc-1", "save-as");

    expect(outcome).toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: false,
    });
    expect(harness.tab("doc-1")?.path).toBe("/notes/./a.md");
    expect(harness.retargets).toEqual([]);
  });

  it("does not notify retarget for a case-only change on macOS", async () => {
    const harness = createHarness({ platform: "macos" });
    harness.open("doc-1", "/Notes/A.md");
    harness.edit("doc-1", "updated");
    harness.port.setChooseHandler(async () => ({
      path: "/notes/a.md",
      expectedVersion: "version of /Notes/A.md",
    }));

    const outcome = await harness.flow.save("doc-1", "save-as");

    expect(outcome).toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: false,
    });
    expect(harness.retargets).toEqual([]);
  });

  it("keeps a successful save when the retarget hook throws", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.port.setChooseHandler(async () => ({
      path: "/notes/renamed.md",
      expectedVersion: "version of /notes/a.md",
    }));
    harness.setRetargetBehavior("throw");

    const outcome = await harness.flow.save("doc-1", "save-as");

    expect(outcome).toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: true,
    });
    expect(harness.tab("doc-1")).toMatchObject({
      path: "/notes/renamed.md",
      status: "clean",
    });
    expect(harness.retargets).toHaveLength(1);
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual([]);
    expect(harness.flow.isSaving("doc-1")).toBe(false);
  });

  it("keeps a successful save when the retarget hook rejects asynchronously", async () => {
    const harness = createHarness();
    harness.open("doc-1", "/notes/a.md");
    harness.edit("doc-1", "updated");
    harness.port.setChooseHandler(async () => ({
      path: "/notes/renamed.md",
      expectedVersion: "version of /notes/a.md",
    }));
    harness.setRetargetBehavior("reject");

    const outcome = await harness.flow.save("doc-1", "save-as");
    await Promise.resolve();

    expect(outcome).toMatchObject({
      kind: "saved",
      tabId: "doc-1",
      retargeted: true,
    });
    expect(harness.tab("doc-1")?.status).toBe("clean");
    expect(harness.failures).toEqual([]);
    expect(harness.banners).toEqual([]);
    expect(harness.flow.isSaving("doc-1")).toBe(false);
  });
});
