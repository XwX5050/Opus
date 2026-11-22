import type { DocumentSnapshot, RecoveryDraft } from "../document/types";
import { draftFromSnapshot, draftIdForTab, needsRecoveryDraft } from "./drafts";

/** Fired 2s after a tab's last change; re-armed by every new signature. */
export const DRAFT_DEBOUNCE_MS = 2000;
/** Continuous typing forces a write at worst once per this window. */
export const DRAFT_MAX_PENDING_MS = 5000;

/** The persistence surface the scheduler drives; supplied by the controller. */
export interface DraftSchedulerHost {
  /** Current tabs; timer callbacks re-read here instead of closing over state. */
  readonly getTabs: () => ReadonlyArray<DocumentSnapshot>;
  readonly writeDraft: (draft: RecoveryDraft) => Promise<unknown>;
  readonly discardDraft: (draftId: string) => Promise<void>;
}

export interface DraftSchedulerOptions {
  /**
   * Monotonic clock for the maximum-pending window. Tests inject a controllable
   * clock; production defaults to `performance.now`.
   */
  readonly now?: () => number;
}

export interface DraftScheduler {
  /** Reconciles the per-tab timers with the given tab snapshots. */
  sync(tabs: ReadonlyArray<DocumentSnapshot>): void;
  /** Writes every tab that currently needs a draft, concurrently. */
  flush(): Promise<void>;
  /** Records that the tab's draft was persisted by the caller. */
  markPersisted(tabId: string): void;
  /** Clears that record when the caller knows the draft does not exist. */
  unmarkPersisted(tabId: string): void;
  /**
   * Clears pending debounce timers (unmount / StrictMode cleanup). The next
   * sync re-arms exactly the tabs whose timers were cleared here.
   */
  cancelTimers(): void;
}

/**
 * The draft-relevant part of a snapshot: content by reference plus the scalar
 * metadata that `draftFromSnapshot` copies into the draft. A rename or external
 * move changes path/title/version without touching the text, and must rewrite
 * the draft so its metadata does not go stale. The saved-text hash stays in the
 * drafts domain and is intentionally not part of this signature.
 */
interface DraftSignature {
  readonly status: DocumentSnapshot["status"];
  readonly text: string;
  readonly path: string | null;
  readonly title: string;
  readonly hasUtf8Bom: boolean;
  readonly newline: DocumentSnapshot["newline"];
  readonly version: string | null;
}

const signatureOf = (tab: DocumentSnapshot): DraftSignature => ({
  status: tab.status,
  text: tab.text,
  path: tab.path,
  title: tab.title,
  hasUtf8Bom: tab.hasUtf8Bom,
  newline: tab.newline,
  version: tab.version,
});

const sameSignature = (a: DraftSignature, b: DraftSignature): boolean =>
  a.status === b.status &&
  a.text === b.text &&
  a.path === b.path &&
  a.title === b.title &&
  a.hasUtf8Bom === b.hasUtf8Bom &&
  a.newline === b.newline &&
  a.version === b.version;

/**
 * Per-tab recovery-draft scheduling, extracted from the controller effect.
 *
 * A dirty tab is written 2s after its last change, but a tab that keeps
 * changing is forced out once its pending window reaches 5s. Timers only
 * capture the tab id; the snapshot is read again from the host when the timer
 * fires, so a closed or saved tab never writes stale text.
 *
 * Draft bookkeeping separates *issued* writes from *confirmed* drafts. A
 * confirmed draft survives a later failed rewrite so a clean or closed tab
 * still discards the older draft; the in-flight map keeps a write's FIFO
 * position ahead of a discard issued while it has not settled. Cleanup
 * invalidates the tab's lifecycle, so a settlement from before the cleanup
 * can never mark or unmark the current draft.
 *
 * `cancelTimers` records the debounce timers it cleared, so a StrictMode
 * remount can schedule those tabs again even though their signatures are
 * unchanged.
 */
export const createDraftScheduler = (
  host: DraftSchedulerHost,
  options: DraftSchedulerOptions = {},
): DraftScheduler => {
  const now = options.now ?? (() => performance.now());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const signatures = new Map<string, DraftSignature>();
  const pendingSince = new Map<string, number>();
  // Tab ids whose debounce timer was removed by cancelTimers before it fired.
  const cancelledIds = new Set<string>();
  // Drafts confirmed on disk (a write succeeded, or the caller marked one).
  // A later failed rewrite leaves this set alone: the older draft still needs
  // to be discarded once the tab is clean or closed.
  const confirmedIds = new Set<string>();
  // Writes whose command was issued but whose promise has not settled. Keeping
  // the tab here makes a clean/closed sync queue its discard after the write
  // command (the backend is FIFO per client).
  const inFlightWrites = new Map<string, number>();
  // Per-tab lifecycle; deleted on clean/close so late settlements from the
  // previous draft generation cannot mark or unmark anything.
  const lifecycles = new Map<string, number>();
  let sequence = 0;

  const nextSequence = (): number => {
    sequence += 1;
    return sequence;
  };

  const lifecycleOf = (tabId: string): number => {
    const existing = lifecycles.get(tabId);
    if (existing !== undefined) return existing;
    const created = nextSequence();
    lifecycles.set(tabId, created);
    return created;
  };

  const discard = (tabId: string): void => {
    // Fire-and-forget: the backend processes draft commands in issue order,
    // so this discard cannot overtake the last write issued for the same
    // draft id. A rejection means the draft is already gone.
    try {
      void Promise.resolve(host.discardDraft(draftIdForTab(tabId))).catch(() => {});
    } catch {
      // A synchronous throw means nothing was queued; there is no draft to
      // clean up and the component must keep running.
    }
  };

  const forget = (tabId: string): boolean => {
    const hadDraft = confirmedIds.has(tabId) || inFlightWrites.has(tabId);
    confirmedIds.delete(tabId);
    inFlightWrites.delete(tabId);
    lifecycles.delete(tabId);
    signatures.delete(tabId);
    pendingSince.delete(tabId);
    cancelledIds.delete(tabId);
    const timer = timers.get(tabId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(tabId);
    }
    return hadDraft;
  };

  const startWrite = (
    tab: DocumentSnapshot,
    onFailure: () => void,
  ): Promise<void> => {
    const tabId = tab.id;
    const lifecycle = lifecycleOf(tabId);
    const token = nextSequence();
    inFlightWrites.set(tabId, token);

    const fail = (): void => {
      const wasCurrent = inFlightWrites.get(tabId) === token;
      if (wasCurrent) inFlightWrites.delete(tabId);
      // A superseded write, or one from a tab that was cleaned/closed since,
      // must not touch the current signature or draft bookkeeping.
      if (!wasCurrent || lifecycles.get(tabId) !== lifecycle) return;
      onFailure();
    };

    let pending: Promise<unknown>;
    try {
      pending = host.writeDraft(draftFromSnapshot(tab));
    } catch {
      fail();
      return Promise.resolve();
    }
    return Promise.resolve(pending).then(
      () => {
        if (lifecycles.get(tabId) !== lifecycle) return;
        confirmedIds.add(tabId);
        if (inFlightWrites.get(tabId) === token) inFlightWrites.delete(tabId);
      },
      () => {
        fail();
      },
    );
  };

  const write = (tabId: string): void => {
    timers.delete(tabId);
    pendingSince.delete(tabId);
    const tab = host.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab || !needsRecoveryDraft(tab)) return;
    const writtenSignature = signatures.get(tabId);
    void startWrite(tab, () => {
      // Keep a newer signature that arrived while this write was in flight:
      // its own timer is already scheduled. Otherwise drop this signature so
      // the next state change re-arms after a transient failure.
      if (signatures.get(tabId) === writtenSignature) signatures.delete(tabId);
    });
  };

  const schedule = (tabId: string): void => {
    cancelledIds.delete(tabId);
    const existing = timers.get(tabId);
    if (existing !== undefined) clearTimeout(existing);
    const current = now();
    const since = pendingSince.get(tabId) ?? current;
    // Every change re-arms the 2s idle timer, so continuous typing must be
    // forced once the window is exhausted; otherwise the crash-loss window
    // would grow without bound.
    if (current - since >= DRAFT_MAX_PENDING_MS) {
      write(tabId);
      return;
    }
    pendingSince.set(tabId, since);
    timers.set(tabId, setTimeout(() => write(tabId), DRAFT_DEBOUNCE_MS));
  };

  const sync = (tabs: ReadonlyArray<DocumentSnapshot>): void => {
    const needing = new Map<string, DraftSignature>();
    for (const tab of tabs) {
      if (needsRecoveryDraft(tab)) needing.set(tab.id, signatureOf(tab));
    }

    // Every per-tab record is cleaned when its tab no longer needs a draft.
    // A confirmed draft or an issued write means a draft may exist on disk and
    // must be discarded; the discard is queued after the write command.
    const known = new Set<string>();
    for (const id of signatures.keys()) known.add(id);
    for (const id of confirmedIds) known.add(id);
    for (const id of inFlightWrites.keys()) known.add(id);
    for (const id of lifecycles.keys()) known.add(id);
    for (const id of timers.keys()) known.add(id);
    for (const id of pendingSince.keys()) known.add(id);
    for (const id of cancelledIds) known.add(id);
    for (const id of known) {
      if (needing.has(id)) continue;
      if (forget(id)) discard(id);
    }

    for (const [id, signature] of needing) {
      const previous = signatures.get(id);
      if (previous && sameSignature(previous, signature)) {
        // Only a timer removed by cancelTimers before it fired is re-armed
        // here (StrictMode remount). Completed writes, failed rewrites, and
        // flush failures leave unchanged content alone.
        if (cancelledIds.delete(id)) schedule(id);
        continue;
      }
      signatures.set(id, signature);
      schedule(id);
    }
  };

  const flush = async (): Promise<void> => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pendingSince.clear();
    cancelledIds.clear();
    const writes = host
      .getTabs()
      .filter(needsRecoveryDraft)
      .map((tab) =>
        // Flush failures only clear the in-flight mark; signatures are kept,
        // so unchanged content is not rewritten automatically.
        startWrite(tab, () => {}),
      );
    await Promise.all(writes);
  };

  const markPersisted = (tabId: string): void => {
    confirmedIds.add(tabId);
  };

  const unmarkPersisted = (tabId: string): void => {
    confirmedIds.delete(tabId);
  };

  const cancelTimers = (): void => {
    for (const [id, timer] of timers) {
      clearTimeout(timer);
      cancelledIds.add(id);
    }
    timers.clear();
  };

  return { sync, flush, markPersisted, unmarkPersisted, cancelTimers };
};
