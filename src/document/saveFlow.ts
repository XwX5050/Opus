import { DocumentPortError } from "./DocumentPort";
import type { SavedFile } from "./DocumentPort";
import { normalizePathKey } from "./documentReducer";
import type { DocumentAction } from "./documentReducer";
import type {
  DocumentSnapshot,
  DocumentState,
  PathPlatform,
  PendingWriteRequest,
  SaveTarget,
} from "./types";

/**
 * Adapter convention for the controller's `closeSavingRef`: while that ref is
 * true, the adapter passes `"close"` for the close-confirmation save. The ref
 * is the existing signal that the user explicitly chose to leave, so that
 * attempt bypasses a visible translation overlay and reports write failures
 * through the banner; the flow itself never reads the controller ref.
 */
export type SaveIntent = "save" | "save-as" | "close";

export type SaveSkipReason = "busy" | "missing";

export type SaveBlockedReason = "translation-visible";

/**
 * Failure payload for the controller's retry surface. `saveFlow` owns the
 * definition; the controller re-exports it instead of declaring a duplicate.
 */
export interface SaveFailure {
  readonly id: string;
  readonly message: string;
}

/**
 * Result of one save attempt. `saved` means the reducer committed the write
 * result; a tab may still be dirty afterwards if the buffer changed during
 * the write. `stale` means the lifecycle generation changed and the flow
 * deliberately neither committed nor reported anything. Conflict outcomes
 * surface through the banner (the conflict UI owns them). A failure before the
 * write is issued always uses the banner; only a `write` failure routes by
 * intent: close through the banner, standalone through `SaveFailure`. Host
 * contract violations after a successful write reject the returned promise;
 * they are never converted into `failed`.
 */
export type SaveOutcome =
  | { readonly kind: "saved"; readonly tabId: string; readonly retargeted: boolean }
  | { readonly kind: "skipped"; readonly tabId: string | null; readonly reason: SaveSkipReason }
  | { readonly kind: "cancelled"; readonly tabId: string }
  | { readonly kind: "blocked"; readonly tabId: string; readonly reason: SaveBlockedReason }
  | { readonly kind: "stale"; readonly tabId: string }
  | {
      readonly kind: "target-conflict" | "write-conflict";
      readonly tabId: string;
      readonly error: DocumentPortError;
    }
  | { readonly kind: "failed"; readonly tabId: string; readonly error: DocumentPortError };

/**
 * Controlled host for one flow instance. Every member except `chooseSavePath`,
 * `write` and `onRetarget` is synchronous and must not throw on the normal
 * path. After a successful write, host programming errors
 * (dispatch/getState/reporting) are allowed to reject the save promise as
 * developer defects; they are never reclassified as disk-write failures or
 * surfaced through the retry dialog.
 */
export interface SaveFlowHost {
  readonly getState: () => DocumentState;
  /** Must apply the action and update `getState` before returning. */
  readonly dispatch: (action: DocumentAction) => DocumentState;
  /** Bumped whenever an async completion must no longer touch the document. */
  readonly generation: () => number;
  readonly isCurrent: (generation: number) => boolean;
  readonly chooseSavePath: (suggestedName: string) => Promise<SaveTarget | null>;
  readonly write: (request: PendingWriteRequest) => Promise<SavedFile>;
  readonly translationVisible: (tabId: string) => boolean;
  readonly pathPlatform: PathPlatform;
  /**
   * Clears a banner left by an earlier attempt. Called exactly once after the
   * prechecks pass and the per-tab lock is taken; blocked/busy/missing
   * attempts never reach it.
   */
  readonly clearBanner: () => void;
  /** Transient alert banner, used for failures that must keep a dialog open. */
  readonly showBanner: (message: string) => void;
  /** Retry/save-as surface for a failed standalone save. */
  readonly reportSaveFailure: (failure: SaveFailure) => void;
  /**
   * Called after a committed save only when the normalized tab path actually
   * changed, so scope/watch consumers can retarget without churn for alias
   * spellings of the same file. Synchronous and promise-returning adapters
   * are both supported; exceptions and rejections are ignored because the
   * disk write has already succeeded.
   */
  readonly onRetarget: (
    tabId: string,
    tab: DocumentSnapshot,
    previousPath: string | null,
  ) => void | Promise<void>;
}

/**
 * `save` is the only intent blocked by a visible translation overlay;
 * `save-as` and `close` bypass it deliberately. `isSaving` is true from the
 * moment an attempt holds the per-tab lock, including while the save target
 * selector is open.
 */
export interface SaveFlow {
  save(id: string | undefined, intent: SaveIntent): Promise<SaveOutcome>;
  isSaving(id: string): boolean;
}

const TARGET_CONFLICT_MESSAGE = "保存目标与已打开的文档冲突";
const WRITE_CONFLICT_MESSAGE =
  "保存完成时检测到目标路径冲突，文件仍处于未保存状态";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const asPortError = (error: unknown): DocumentPortError =>
  error instanceof DocumentPortError
    ? error
    : new DocumentPortError("io", errorMessage(error), { cause: error });

/**
 * Serializes saves per tab, not globally: every tab may save concurrently,
 * while a second attempt on the same tab is refused synchronously before any
 * await. The reducer remains the only source of pending requests and CAS
 * outcomes; this flow only sequences target selection, write, and reporting.
 *
 * Create exactly one flow per controller and keep it stable across renders
 * (the controller integration stores it in a `useRef`). The per-tab lock is
 * instance-private, so a fresh instance per render would defeat reentrancy
 * protection.
 */
export const createSaveFlow = (host: SaveFlowHost): SaveFlow => {
  const saving = new Set<string>();

  const reportFailure = (intent: SaveIntent, failure: SaveFailure): void => {
    if (intent === "close") host.showBanner(failure.message);
    else host.reportSaveFailure(failure);
  };

  /**
   * The write failure is already classified. Normal adapters do not throw,
   * but a reporting callback must not be able to replace that classification.
   */
  const reportWriteFailure = (intent: SaveIntent, failure: SaveFailure): void => {
    try {
      reportFailure(intent, failure);
    } catch {
      // Preserve the write classification even if a reporting callback fails.
    }
  };

  const conflict = (
    kind: "target-conflict" | "write-conflict",
    tabId: string,
    message: string,
  ): SaveOutcome => {
    const error = new DocumentPortError("conflict", message);
    // A conflict is not retryable in place: a target collision needs another
    // destination and a mismatched write result is owned by the conflict UI,
    // so both surface as a transient banner instead of the retry dialog.
    host.showBanner(message);
    return { kind, tabId, error };
  };

  const save = async (
    requestedId: string | undefined,
    intent: SaveIntent,
  ): Promise<SaveOutcome> => {
    const id = requestedId ?? host.getState().activeId;
    if (id === null) {
      return { kind: "skipped", tabId: null, reason: "missing" };
    }
    const generation = host.generation();

    // A visible translation is a read-only overlay over the original buffer;
    // only the plain save intent is blocked. Save As picks a new destination
    // and close is the user's explicit decision to leave, so both bypass it.
    if (intent === "save" && host.translationVisible(id)) {
      return { kind: "blocked", tabId: id, reason: "translation-visible" };
    }
    if (saving.has(id)) {
      return { kind: "skipped", tabId: id, reason: "busy" };
    }
    const before = host.getState().tabs.find((tab) => tab.id === id);
    if (!before) {
      return { kind: "skipped", tabId: id, reason: "missing" };
    }
    if (before.pendingSave) {
      return { kind: "skipped", tabId: id, reason: "busy" };
    }
    if (!host.isCurrent(generation)) {
      return { kind: "stale", tabId: id };
    }

    saving.add(id);
    try {
      host.clearBanner();

      let target: SaveTarget | null = null;
      if (intent === "save-as" || before.path === null) {
        try {
          target = await host.chooseSavePath(before.title);
        } catch (caught) {
          // Target selection is a user-facing step: its failure keeps the
          // controller's existing banner route rather than the retry dialog.
          const error = asPortError(caught);
          if (!host.isCurrent(generation)) return { kind: "stale", tabId: id };
          host.showBanner(error.message);
          return { kind: "failed", tabId: id, error };
        }
        if (!host.isCurrent(generation)) return { kind: "stale", tabId: id };
        if (target === null) return { kind: "cancelled", tabId: id };
      }

      const latest = host.getState().tabs.find((tab) => tab.id === id);
      if (!latest) return { kind: "skipped", tabId: id, reason: "missing" };
      if (latest.pendingSave) return { kind: "skipped", tabId: id, reason: "busy" };

      let requested: DocumentState;
      try {
        requested = host.dispatch({
          type: "saveRequested",
          id,
          pathPlatform: host.pathPlatform,
          ...(target ? { target } : {}),
        });
      } catch (caught) {
        const error = asPortError(caught);
        if (!host.isCurrent(generation)) return { kind: "stale", tabId: id };
        host.showBanner(error.message);
        return { kind: "failed", tabId: id, error };
      }
      const pending = requested.tabs.find((tab) => tab.id === id)?.pendingSave;
      if (!pending) {
        if (!requested.tabs.some((tab) => tab.id === id)) {
          return { kind: "skipped", tabId: id, reason: "missing" };
        }
        return conflict("target-conflict", id, TARGET_CONFLICT_MESSAGE);
      }

      let result: SavedFile;
      try {
        // Reference identity matters: the reducer freezes its request, and
        // the write must observe exactly the text/version it was built from.
        result = await host.write(pending);
      } catch (caught) {
        const error = asPortError(caught);
        if (!host.isCurrent(generation)) return { kind: "stale", tabId: id };
        host.dispatch({
          type: "saveFailed",
          requestId: pending.requestId,
          error,
        });
        reportWriteFailure(intent, { id, message: error.message });
        return { kind: "failed", tabId: id, error };
      }

      if (!host.isCurrent(generation)) return { kind: "stale", tabId: id };

      // The write succeeded. From here on, host contract violations are
      // developer defects: they propagate instead of being classified as a
      // disk-write failure or opening the retry dialog.
      const completed = host.dispatch({
        type: "saveSucceeded",
        requestId: pending.requestId,
        result,
      });
      const savedTab = completed.tabs.find((tab) => tab.id === id);
      if (
        savedTab === undefined ||
        savedTab.pendingSave !== undefined ||
        savedTab.status === "conflict"
      ) {
        return conflict("write-conflict", id, WRITE_CONFLICT_MESSAGE);
      }

      const retargeted =
        savedTab.path !== null &&
        (latest.path === null ||
          normalizePathKey(latest.path, pending.pathPlatform) !==
            normalizePathKey(savedTab.path, pending.pathPlatform));
      if (retargeted) {
        try {
          void Promise.resolve(
            host.onRetarget(id, savedTab, latest.path),
          ).catch(() => {
            // Retarget bookkeeping must never downgrade a committed save.
          });
        } catch {
          // Synchronous adapter exception, same rule.
        }
      }
      return { kind: "saved", tabId: id, retargeted };
    } finally {
      saving.delete(id);
    }
  };

  return {
    save,
    isSaving: (id) => saving.has(id),
  };
};
