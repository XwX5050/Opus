import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSnapshot, RecoveryDraft } from "../document/types";
import {
  createDraftScheduler,
  DRAFT_DEBOUNCE_MS,
  DRAFT_MAX_PENDING_MS,
  type DraftSchedulerHost,
} from "./draftScheduler";
import { draftIdForTab } from "./drafts";

/** A dirty tab whose buffer differs from its saved text; override per case. */
const snapshot = (overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({
  id: "document-1",
  path: "/notes/a.md",
  title: "a.md",
  text: "未保存内容\n",
  savedText: "已保存内容\n",
  hasUtf8Bom: false,
  newline: "lf",
  modifiedUnixMs: 1,
  version: "v1",
  status: "dirty",
  ...overrides,
});

const dirtyTab = (id: string, text: string): DocumentSnapshot =>
  snapshot({ id, text });

const cleanTab = (id = "document-1"): DocumentSnapshot =>
  snapshot({ id, text: "已保存内容\n", status: "clean" });

const createHarness = (initialTabs: ReadonlyArray<DocumentSnapshot>) => {
  let tabs = initialTabs;
  const writes: RecoveryDraft[] = [];
  const discarded: string[] = [];
  const writeDraft = vi.fn(
    async (draft: RecoveryDraft): Promise<unknown> => {
      writes.push(draft);
      return undefined;
    },
  );
  const discardDraft = vi.fn(async (draftId: string): Promise<void> => {
    discarded.push(draftId);
  });
  const host: DraftSchedulerHost = {
    getTabs: () => tabs,
    writeDraft,
    discardDraft,
  };
  return {
    host,
    writes,
    discarded,
    writeDraft,
    discardDraft,
    setTabs: (next: ReadonlyArray<DocumentSnapshot>) => {
      tabs = next;
    },
  };
};

const createClock = () => {
  let clock = 0;
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
  };
};

const setup = (initialTabs: ReadonlyArray<DocumentSnapshot>) => {
  const harness = createHarness(initialTabs);
  const clock = createClock();
  const scheduler = createDraftScheduler(harness.host, { now: clock.now });
  /** Mirrors the controller: the tabs passed to sync are the host's tabs. */
  const sync = (tabs: ReadonlyArray<DocumentSnapshot>) => {
    harness.setTabs(tabs);
    scheduler.sync(tabs);
  };
  return { ...harness, scheduler, sync, advance: clock.advance };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createDraftScheduler debounce", () => {
  it("writes a dirty tab two seconds after the last change", () => {
    const { scheduler, advance, writes, writeDraft } = setup([
      dirtyTab("document-1", "unsaved"),
    ]);

    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    advance(DRAFT_DEBOUNCE_MS - 1);
    expect(writeDraft).not.toHaveBeenCalled();

    advance(1);
    expect(writeDraft).toHaveBeenCalledTimes(1);
    expect(writes[0]).toMatchObject({
      draftId: draftIdForTab("document-1"),
      originalPath: "/notes/a.md",
      title: "a.md",
      text: "unsaved",
      savedVersion: "v1",
    });
    expect(writes[0].savedTextHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("re-arms the debounce on a change and writes the latest text", () => {
    const { sync, advance, writes, writeDraft } = setup([
      dirtyTab("document-1", "v1"),
    ]);

    sync([dirtyTab("document-1", "v1")]);
    advance(1500);
    sync([dirtyTab("document-1", "v2")]);
    advance(DRAFT_DEBOUNCE_MS - 1);
    expect(writeDraft).not.toHaveBeenCalled();

    advance(1);
    expect(writes.map((draft) => draft.text)).toEqual(["v2"]);
  });

  it("re-arms for a changed text of the same or different length", () => {
    const sameLength = setup([dirtyTab("document-1", "v1")]);
    sameLength.sync([dirtyTab("document-1", "v1")]);
    sameLength.advance(1500);
    sameLength.sync([dirtyTab("document-1", "v2")]);
    sameLength.advance(DRAFT_DEBOUNCE_MS);
    expect(sameLength.writes.map((draft) => draft.text)).toEqual(["v2"]);

    const differentLength = setup([dirtyTab("document-1", "v1")]);
    differentLength.sync([dirtyTab("document-1", "v1")]);
    differentLength.advance(1500);
    differentLength.sync([dirtyTab("document-1", "v1-long")]);
    differentLength.advance(DRAFT_DEBOUNCE_MS);
    expect(differentLength.writes.map((draft) => draft.text)).toEqual([
      "v1-long",
    ]);
  });

  it("keeps each tab's debounce independent", () => {
    const { sync, advance, writes, writeDraft } = setup([
      dirtyTab("document-1", "a-1"),
      dirtyTab("document-2", "b-1"),
    ]);

    sync([dirtyTab("document-1", "a-1"), dirtyTab("document-2", "b-1")]);
    advance(1000);
    sync([dirtyTab("document-1", "a-2"), dirtyTab("document-2", "b-1")]);

    advance(999);
    expect(writeDraft).not.toHaveBeenCalled();

    advance(1);
    expect(writes.map((draft) => draft.draftId)).toEqual([
      draftIdForTab("document-2"),
    ]);

    advance(1000);
    expect(writes.map((draft) => draft.draftId)).toEqual([
      draftIdForTab("document-2"),
      draftIdForTab("document-1"),
    ]);
    expect(writes[1].text).toBe("a-2");
  });

  it("re-reads the latest tab when the timer fires", () => {
    const { scheduler, advance, writes, setTabs } = setup([
      dirtyTab("document-1", "v1"),
    ]);

    scheduler.sync([dirtyTab("document-1", "v1")]);
    setTabs([dirtyTab("document-1", "v2")]);

    advance(DRAFT_DEBOUNCE_MS);
    expect(writes.map((draft) => draft.text)).toEqual(["v2"]);
  });

  it("skips a tab that became clean before the timer fires", () => {
    const { scheduler, advance, setTabs, writeDraft, discarded } = setup([
      dirtyTab("document-1", "unsaved"),
    ]);

    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    setTabs([cleanTab()]);

    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).not.toHaveBeenCalled();
    expect(discarded).toHaveLength(0);
  });

  it("skips a tab that closed before the timer fires", () => {
    const { scheduler, advance, setTabs, writeDraft, discarded } = setup([
      dirtyTab("document-1", "unsaved"),
    ]);

    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    setTabs([]);

    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).not.toHaveBeenCalled();
    expect(discarded).toHaveLength(0);
  });

  it("cancels a pending debounce when the tab closes", () => {
    const { sync, advance, writeDraft, discarded } = setup([
      dirtyTab("document-1", "unsaved"),
    ]);

    sync([dirtyTab("document-1", "unsaved")]);
    sync([]);

    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).not.toHaveBeenCalled();
    expect(discarded).toHaveLength(0);
  });

  it("keeps the draft signature until content or metadata changes", () => {
    const dirty = dirtyTab("document-1", "unsaved");
    const { sync, advance, writeDraft } = setup([dirty]);

    sync([dirty]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // Same references (and same values) must not arm another write.
    sync([dirty]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // A fresh snapshot with the same values is still the same signature.
    sync([{ ...dirty }]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // A status change alone is a new signature.
    sync([{ ...dirty, status: "conflict" }]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(2);
  });

  it("rewrites the draft when only metadata changes (rename or external move)", () => {
    const original = dirtyTab("document-1", "unsaved");
    const { sync, advance, writes, writeDraft } = setup([original]);

    sync([original]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // The text did not change, but the draft's path/title/version and
    // formatting metadata did; leaving the old draft would restore it under
    // the old location.
    const moved: DocumentSnapshot = {
      ...original,
      path: "/notes/moved.md",
      title: "moved.md",
      version: "v2",
      hasUtf8Bom: true,
      newline: "cr_lf",
    };
    sync([moved]);
    advance(DRAFT_DEBOUNCE_MS - 1);
    expect(writeDraft).toHaveBeenCalledTimes(1);

    advance(1);
    expect(writeDraft).toHaveBeenCalledTimes(2);
    expect(writes[1]).toMatchObject({
      originalPath: "/notes/moved.md",
      title: "moved.md",
      savedVersion: "v2",
      hasUtf8Bom: true,
      newline: "cr_lf",
    });
  });

  it("forces a write once continuous changes pass the maximum pending window", () => {
    const { sync, advance, writes, writeDraft } = setup([
      dirtyTab("document-1", "typing-1"),
    ]);

    sync([dirtyTab("document-1", "typing-1")]);
    advance(1500);
    sync([dirtyTab("document-1", "typing-2")]);
    advance(1500);
    sync([dirtyTab("document-1", "typing-3")]);
    advance(1500);
    expect(writeDraft).not.toHaveBeenCalled();

    // t=4.5s: the next change still falls inside the window.
    sync([dirtyTab("document-1", "typing-4")]);
    advance(600);

    // t=5.1s: the 2s idle timer has not fired, but the window is exhausted.
    sync([dirtyTab("document-1", "typing-5")]);
    expect(writeDraft).toHaveBeenCalledTimes(1);
    expect(writes[0].text).toBe("typing-5");

    advance(10_000);
    expect(writeDraft).toHaveBeenCalledTimes(1);
  });
});

describe("createDraftScheduler persisted bookkeeping", () => {
  it("discards a cleaned tab while its write is still in flight", async () => {
    const harness = createHarness([dirtyTab("document-1", "unsaved")]);
    let resolveWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    harness.writeDraft.mockImplementation(async (draft) => {
      harness.writes.push(draft);
      await writeGate;
      return undefined;
    });
    let resolveDiscard: () => void = () => {};
    const discardGate = new Promise<void>((resolve) => {
      resolveDiscard = resolve;
    });
    harness.discardDraft.mockImplementation(async (draftId) => {
      harness.discarded.push(draftId);
      await discardGate;
    });
    const scheduler = createDraftScheduler(harness.host, { now: () => 0 });

    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    expect(harness.writes).toHaveLength(1);

    // The write is still in flight, so its draft may exist. The discard is
    // issued now and relies on the backend's FIFO command order.
    scheduler.sync([cleanTab()]);
    expect(harness.discarded).toEqual([draftIdForTab("document-1")]);

    resolveWrite();
    resolveDiscard();
    await writeGate;
    await discardGate;
  });

  it("does not discard a clean tab whose draft was never persisted", () => {
    const { scheduler, advance, setTabs, writeDraft, discarded } = setup([
      dirtyTab("document-1", "unsaved"),
    ]);

    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    setTabs([cleanTab()]);
    advance(DRAFT_DEBOUNCE_MS);
    scheduler.sync([cleanTab()]);

    expect(writeDraft).not.toHaveBeenCalled();
    expect(discarded).toHaveLength(0);
  });

  it("discards a persisted draft when its tab closes", () => {
    const { scheduler, discarded } = setup([]);

    scheduler.markPersisted("document-1");
    scheduler.sync([]);

    expect(discarded).toEqual([draftIdForTab("document-1")]);
  });

  it("issues a discard only after the write was actually called", async () => {
    const harness = createHarness([dirtyTab("document-1", "unsaved")]);
    const calls: string[] = [];
    let resolveWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    harness.writeDraft.mockImplementation(async (draft) => {
      calls.push(`write:${draft.draftId}`);
      await writeGate;
    });
    harness.discardDraft.mockImplementation(async (draftId) => {
      calls.push(`discard:${draftId}`);
    });
    const scheduler = createDraftScheduler(harness.host, { now: () => 0 });

    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    // The write is still in flight; FIFO backend ordering requires the
    // discard to be issued after the write command, not after it settles.
    scheduler.sync([cleanTab()]);

    expect(calls).toEqual([
      `write:${draftIdForTab("document-1")}`,
      `discard:${draftIdForTab("document-1")}`,
    ]);

    resolveWrite();
    await writeGate;
  });

  it("drops a failed write's signature so a later sync re-arms", async () => {
    const dirty = dirtyTab("document-1", "unsaved");
    const { scheduler, advance, writeDraft, discarded } = setup([dirty]);
    writeDraft.mockRejectedValueOnce(new Error("disk full"));

    scheduler.sync([dirty]);
    advance(DRAFT_DEBOUNCE_MS);
    await Promise.resolve();
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // The failed write never confirmed a draft, so a clean tab has none.
    scheduler.sync([cleanTab()]);
    expect(discarded).toHaveLength(0);

    // The signature was dropped, so even an unchanged tab re-arms.
    scheduler.sync([dirty]);
    advance(DRAFT_DEBOUNCE_MS - 1);
    expect(writeDraft).toHaveBeenCalledTimes(1);
    advance(1);
    expect(writeDraft).toHaveBeenCalledTimes(2);
  });

  it("still discards an earlier confirmed draft when a later rewrite fails", async () => {
    const first = dirtyTab("document-1", "v1");
    const { sync, advance, writeDraft, discarded } = setup([first]);

    sync([first]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // The rewrite fails after v1 was confirmed. The v1 draft is still on disk
    // and must not become unreachable when the tab turns clean.
    writeDraft.mockRejectedValueOnce(new Error("disk full"));
    sync([dirtyTab("document-1", "v2")]);
    advance(DRAFT_DEBOUNCE_MS);
    await Promise.resolve();
    expect(writeDraft).toHaveBeenCalledTimes(2);

    sync([cleanTab()]);
    expect(discarded).toEqual([draftIdForTab("document-1")]);
  });

  it("does not revive persisted state when an in-flight write succeeds after cleanup", async () => {
    const harness = createHarness([dirtyTab("document-1", "unsaved")]);
    let resolveWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    harness.writeDraft.mockImplementation(async (draft) => {
      harness.writes.push(draft);
      await writeGate;
    });
    const scheduler = createDraftScheduler(harness.host, { now: () => 0 });

    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS);
    scheduler.sync([cleanTab()]);
    expect(harness.discarded).toEqual([draftIdForTab("document-1")]);

    resolveWrite();
    await writeGate;
    await Promise.resolve();

    // The settlement belongs to the cleaned lifecycle; it must not mark a
    // draft that a later clean sync would try to discard again.
    scheduler.sync([cleanTab()]);
    expect(harness.discarded).toEqual([draftIdForTab("document-1")]);
  });

  it("starts a fresh draft generation after cleanup", () => {
    const dirty = dirtyTab("document-1", "same");
    const { sync, advance, writeDraft } = setup([dirty]);

    sync([dirty]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // Cleanup must drop the old signature: returning to the same dirty text
    // is a new draft generation and schedules a new write.
    sync([cleanTab()]);
    sync([dirty]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(2);
  });
});

describe("createDraftScheduler flush", () => {
  it("writes every needing tab concurrently and survives one failed write", async () => {
    const { scheduler, writes, writeDraft, discarded } = setup([
      dirtyTab("document-1", "a"),
      dirtyTab("document-2", "b"),
    ]);
    const pending: Array<{
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];
    writeDraft.mockImplementation((draft) => {
      writes.push(draft);
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    });

    const flushed = scheduler.flush();
    expect(pending).toHaveLength(2);

    pending[0].reject(new Error("disk full"));
    pending[1].resolve();
    await expect(flushed).resolves.toBeUndefined();

    // Only the successful tab has a confirmed draft to discard.
    scheduler.sync([cleanTab("document-1"), cleanTab("document-2")]);
    expect(discarded).toEqual([draftIdForTab("document-2")]);
  });

  it("flushes tabs that sync never observed and discards them once clean", async () => {
    const { scheduler, sync, writes, discarded } = setup([
      dirtyTab("document-1", "unsaved"),
    ]);

    await scheduler.flush();
    expect(writes.map((draft) => draft.text)).toEqual(["unsaved"]);

    sync([cleanTab()]);
    expect(discarded).toEqual([draftIdForTab("document-1")]);
  });

  it("writes the latest text immediately and leaves no debounce behind", async () => {
    const { scheduler, advance, setTabs, writes, discarded } = setup([
      dirtyTab("document-1", "old"),
    ]);

    scheduler.sync([dirtyTab("document-1", "old")]);
    setTabs([dirtyTab("document-1", "new")]);
    await scheduler.flush();

    expect(writes.map((draft) => draft.text)).toEqual(["new"]);
    advance(10_000);
    expect(writes).toHaveLength(1);

    // The flushed write is confirmed, so a clean tab discards it later.
    scheduler.sync([cleanTab()]);
    expect(discarded).toEqual([draftIdForTab("document-1")]);
  });

  it("resolves without writing when no tab needs a draft", async () => {
    const { scheduler, writeDraft } = setup([cleanTab()]);

    scheduler.sync([cleanTab()]);
    await expect(scheduler.flush()).resolves.toBeUndefined();
    expect(writeDraft).not.toHaveBeenCalled();
  });

  it("does not rewrite unchanged text after a failed flush", async () => {
    const dirty = dirtyTab("document-1", "unsaved");
    const { scheduler, advance, writeDraft } = setup([dirty]);
    writeDraft.mockRejectedValueOnce(new Error("disk full"));

    scheduler.sync([dirty]);
    await expect(scheduler.flush()).resolves.toBeUndefined();
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // The failure left no confirmed draft; the signature survives, and an
    // unchanged sync must not re-arm the debounce on its own.
    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(1);
  });

  it("still discards an earlier confirmed draft when a later flush rewrite fails", async () => {
    const first = dirtyTab("document-1", "v1");
    const { sync, scheduler, advance, writeDraft, discarded } = setup([first]);

    sync([first]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writeDraft).toHaveBeenCalledTimes(1);

    writeDraft.mockRejectedValueOnce(new Error("disk full"));
    sync([dirtyTab("document-1", "v2")]);
    await expect(scheduler.flush()).resolves.toBeUndefined();

    sync([cleanTab()]);
    expect(discarded).toEqual([draftIdForTab("document-1")]);
  });

  it("does not let a stale flush rejection undo a newer edit's write", async () => {
    const { sync, scheduler, advance, writes, writeDraft, discarded } = setup([
      dirtyTab("document-1", "v1"),
    ]);
    let rejectFlush: (error: Error) => void = () => {};
    const flushGate = new Promise<void>((_resolve, reject) => {
      rejectFlush = reject;
    });
    writeDraft.mockImplementation((draft) => {
      writes.push(draft);
      return draft.text === "v1" ? flushGate : Promise.resolve();
    });

    sync([dirtyTab("document-1", "v1")]);
    const flushed = scheduler.flush();
    expect(writes.map((draft) => draft.text)).toEqual(["v1"]);

    // The user edits while the flush write is still in flight; its debounced
    // write lands and becomes the current persisted draft.
    sync([dirtyTab("document-1", "v2")]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writes.map((draft) => draft.text)).toEqual(["v1", "v2"]);

    rejectFlush(new Error("old flush failed"));
    await expect(flushed).resolves.toBeUndefined();

    // The stale rejection must not unmark the newer write.
    scheduler.sync([cleanTab()]);
    expect(discarded).toEqual([draftIdForTab("document-1")]);
  });
});

describe("createDraftScheduler explicit marking and timer cancellation", () => {
  it("discards exactly the ids marked persisted when they become clean", () => {
    const { scheduler, discarded } = setup([cleanTab("document-1")]);

    scheduler.markPersisted("document-1");
    scheduler.markPersisted("document-2");
    scheduler.unmarkPersisted("document-2");
    scheduler.sync([cleanTab("document-1"), cleanTab("document-2")]);

    expect(discarded).toEqual([draftIdForTab("document-1")]);
  });

  it("ignores a failing discard", async () => {
    const { scheduler, discardDraft } = setup([cleanTab()]);
    discardDraft.mockRejectedValueOnce(new Error("already gone"));

    scheduler.markPersisted("document-1");
    expect(() => scheduler.sync([cleanTab()])).not.toThrow();
    await Promise.resolve();
    expect(discardDraft).toHaveBeenCalledWith(draftIdForTab("document-1"));
  });

  it("cancelTimers prevents a pending write", () => {
    const { scheduler, advance, writeDraft } = setup([
      dirtyTab("document-1", "unsaved"),
    ]);

    scheduler.sync([dirtyTab("document-1", "unsaved")]);
    scheduler.cancelTimers();
    advance(10_000);

    expect(writeDraft).not.toHaveBeenCalled();
  });

  it("allows an unchanged tab to be scheduled again after cancelTimers (StrictMode reuse)", () => {
    const tabs = [dirtyTab("document-1", "unsaved")];
    const { scheduler, advance, writeDraft } = setup(tabs);

    scheduler.sync(tabs);
    scheduler.cancelTimers();
    // StrictMode remounts the effect with the same snapshot references.
    scheduler.sync(tabs);

    advance(DRAFT_DEBOUNCE_MS - 1);
    expect(writeDraft).not.toHaveBeenCalled();
    advance(1);
    expect(writeDraft).toHaveBeenCalledTimes(1);
  });

  it("re-arms every tab whose timer cancelTimers cleared", () => {
    const a1 = dirtyTab("document-1", "a-1");
    const b1 = dirtyTab("document-2", "b-1");
    const a2 = dirtyTab("document-1", "a-2");
    const b2 = dirtyTab("document-2", "b-2");
    const { sync, scheduler, advance, writes } = setup([a1, b1]);

    sync([a1, b1]);
    advance(DRAFT_DEBOUNCE_MS);
    expect(writes.map((draft) => draft.text)).toEqual(["a-1", "b-1"]);

    sync([a2, b2]);
    scheduler.cancelTimers();
    sync([a2, b2]);

    advance(DRAFT_DEBOUNCE_MS - 1);
    expect(writes).toHaveLength(2);
    advance(1);
    expect(writes.map((draft) => draft.text)).toEqual([
      "a-1",
      "b-1",
      "a-2",
      "b-2",
    ]);
  });
});

describe("createDraftScheduler host failures", () => {
  it("contains a synchronous writeDraft throw from a timer and retries the unchanged tab", () => {
    const dirty = dirtyTab("document-1", "unsaved");
    const { scheduler, advance, writeDraft } = setup([dirty]);
    writeDraft.mockImplementation(() => {
      throw new Error("sync boom");
    });

    scheduler.sync([dirty]);
    expect(() => advance(DRAFT_DEBOUNCE_MS)).not.toThrow();
    expect(writeDraft).toHaveBeenCalledTimes(1);

    // The failed write dropped the signature; the same content re-arms.
    scheduler.sync([dirty]);
    expect(() => advance(DRAFT_DEBOUNCE_MS)).not.toThrow();
    expect(writeDraft).toHaveBeenCalledTimes(2);
  });

  it("contains a synchronous writeDraft throw from the max-pending path", () => {
    const dirty = dirtyTab("document-1", "unsaved");
    const { scheduler, advance, writeDraft } = setup([dirty]);
    writeDraft.mockImplementation(() => {
      throw new Error("sync boom");
    });

    scheduler.sync([dirty]);
    scheduler.cancelTimers();
    advance(DRAFT_MAX_PENDING_MS);

    // The cancelled timer re-arms and the exhausted window writes inside sync.
    expect(() => scheduler.sync([dirty])).not.toThrow();
    expect(writeDraft).toHaveBeenCalledTimes(1);
  });

  it("resolves flush when writeDraft throws synchronously and attempts every tab", async () => {
    const harness = createHarness([
      dirtyTab("document-1", "a"),
      dirtyTab("document-2", "b"),
    ]);
    const calls: string[] = [];
    harness.writeDraft.mockImplementation((draft) => {
      calls.push(draft.draftId);
      if (draft.draftId === draftIdForTab("document-1")) {
        throw new Error("sync boom");
      }
      return Promise.resolve();
    });
    const scheduler = createDraftScheduler(harness.host, { now: () => 0 });

    const flushed = scheduler.flush();
    // Invocation order stays synchronous even though one call throws.
    expect(calls).toEqual([
      draftIdForTab("document-1"),
      draftIdForTab("document-2"),
    ]);
    await expect(flushed).resolves.toBeUndefined();

    // Only the tab whose write was invoked successfully is confirmed.
    scheduler.sync([cleanTab("document-1"), cleanTab("document-2")]);
    expect(harness.discarded).toEqual([draftIdForTab("document-2")]);
  });

  it("contains a synchronous discardDraft throw", () => {
    const { scheduler, discardDraft } = setup([cleanTab()]);
    discardDraft.mockImplementation(() => {
      throw new Error("sync boom");
    });

    scheduler.markPersisted("document-1");
    expect(() => scheduler.sync([cleanTab()])).not.toThrow();
    expect(discardDraft).toHaveBeenCalledWith(draftIdForTab("document-1"));
  });
});

describe("createDraftScheduler default clock", () => {
  it("uses performance.now when no clock is injected", () => {
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1000);
    const harness = createHarness([dirtyTab("document-1", "unsaved")]);
    const scheduler = createDraftScheduler(harness.host);

    scheduler.sync(harness.host.getTabs());
    expect(nowSpy).toHaveBeenCalled();
  });
});
