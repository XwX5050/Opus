import { DocumentPortError } from "../document/DocumentPort";
import { normalizePathKey } from "../document/documentReducer";
import type {
  DocumentSnapshot,
  DocumentState,
  PathPlatform,
  RecoveryDraft,
  RecoveryDraftInfo,
} from "../document/types";
import { draftFromSnapshot, draftIdForTab, needsRecoveryDraft } from "./drafts";

/**
 * Result of applying `documentRestored`. `added` must be the exact snapshot
 * appended to `state.tabs` — computed from the before/after tab lists, never a
 * copy or merely whatever tab carries the requested id. A colliding
 * `createTabId` would otherwise masquerade as a tab this adoption created;
 * the transaction ignores an `added` that is not present in `state.tabs`.
 */
export interface RestoreAdoption {
  readonly state: DocumentState;
  /** The tab appended by this adoption; undefined when merged or refused. */
  readonly added: DocumentSnapshot | undefined;
}

/**
 * Adapter contract for the restore transaction. The controller supplies the
 * reducer dispatch, lifecycle token, draft scheduler marks, and the port.
 */
export interface RestoreDraftHost {
  /** Lifecycle token captured before the transaction starts. */
  readonly generation: number;
  readonly pathPlatform: PathPlatform;
  /** False once the tab state was replaced (unmount/reload). */
  isCurrent(generation: number): boolean;
  /** Allocates a tab id that is unique for this session. */
  createTabId(): string;
  /** Reads the full leftover draft; `not_found` maps to the missing outcome. */
  readDraft(draftId: string): Promise<RecoveryDraft>;
  /** Applies `documentRestored` and reports the tab it appended, if any. */
  adoptDraft(id: string, draft: RecoveryDraft): RestoreAdoption;
  /**
   * Reports the tab holding the recovered text before the owner draft is
   * written. Both a fresh tab (`created: true`) and a merge into an open tab
   * (`created: false`) arrive here, which is the point to drop the entry from
   * the recovery list. Only a fresh tab needs asset-scope/watch acquisition.
   */
  onOwnerReady(owner: DocumentSnapshot, created: boolean): void;
  markPersisted(tabId: string): void;
  unmarkPersisted(tabId: string): void;
  writeDraft(draft: RecoveryDraft): Promise<RecoveryDraftInfo>;
  discardDraft(draftId: string): Promise<void>;
}

/**
 * `restored` means the recovered text is in `tabId`. `persisted` is true when
 * the owner needed no draft or its draft write succeeded; `draftWriteFailed`
 * is true when that write failed and the leftover was kept for the next
 * launch, so the caller can surface a warning.
 *
 * `refused` means the recovered text was not adopted: no confirmed owner, or
 * the port returned a draft under a different id. The leftover is left
 * untouched in either case. `missing`/`stale` stop before adoption. `error`
 * may occur before or after adoption — an owner-ready-hook or mark failure
 * happens after the recovered text landed in a tab — so callers must inspect
 * the tab state rather than assume it is unchanged.
 */
export type RestoreDraftOutcome =
  | {
      readonly kind: "restored";
      readonly tabId: string;
      readonly persisted: boolean;
      readonly draftWriteFailed: boolean;
    }
  | { readonly kind: "refused" }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "stale" };

const findMergedOwner = (
  tabs: ReadonlyArray<DocumentSnapshot>,
  draft: RecoveryDraft,
  platform: PathPlatform,
): DocumentSnapshot | undefined => {
  const originalPath = draft.originalPath;
  if (originalPath === null) return undefined;
  const originalKey = normalizePathKey(originalPath, platform);
  return tabs.find(
    (tab) =>
      tab.path !== null &&
      normalizePathKey(tab.path, platform) === originalKey &&
      tab.text === draft.text,
  );
};

/**
 * Fire-and-forget by contract: the leftover discard never delays or fails the
 * restore, so a synchronous throw from a misbehaving port is swallowed too.
 */
const discardLeftover = (host: RestoreDraftHost, draftId: string): void => {
  try {
    void host.discardDraft(draftId).catch(() => {});
  } catch {
    // The restore already succeeded; a failed cleanup is retried next launch.
  }
};

/**
 * Restores one leftover draft:
 *
 * readDraft → generation check → draft-id check → createTabId → adoptDraft →
 * owner (the tab the adoption created, otherwise a same-path tab holding the
 * same text) → onOwnerReady(owner, created) → markPersisted + writeDraft(owner)
 * when the owner still needs a draft → discard the leftover only after a
 * successful owner write, and never when the owner reused the leftover's id.
 *
 * `onOwnerReady` runs for a fresh or merged owner before its draft write; it
 * is the point where the caller drops the recovery list entry, and only a
 * fresh owner needs its asset scope and watch acquired.
 *
 * Draft ids carry a per-launch namespace, so the owner copy always gets a new
 * id. Legacy `draft-document-N` leftovers are still read from the port and
 * only discarded after that namespaced copy is safely written. A port that
 * returns the draft under a different id is refused before adoption, so
 * neither a write nor a discard can target an unknown leftover.
 *
 * A failed read checks the lifecycle first, so a transaction whose tab state
 * was replaced reports `stale` for a missing draft and a store error alike.
 * A failed owner write unmarks it, keeps the leftover as the only disk copy,
 * and reports `draftWriteFailed` in the restored outcome. Without a confirmed
 * owner neither a write nor a delete happens: the leftover holds the only
 * copy of the unsaved text. The function never rejects.
 */
export const restoreDraft = async (
  info: RecoveryDraftInfo,
  host: RestoreDraftHost,
): Promise<RestoreDraftOutcome> => {
  try {
    let draft: RecoveryDraft;
    try {
      draft = await host.readDraft(info.draftId);
    } catch (error) {
      // The lifecycle wins over the error classification: a replaced tab
      // state must neither show a banner nor drop a dialog entry.
      if (!host.isCurrent(host.generation)) return { kind: "stale" };
      if (error instanceof DocumentPortError && error.code === "not_found") {
        return { kind: "missing" };
      }
      return { kind: "error", error };
    }
    if (!host.isCurrent(host.generation)) return { kind: "stale" };
    // A store that answers under another id must not be written or deleted:
    // the caller's leftover entry and the returned copy are not provably the
    // same draft.
    if (draft.draftId !== info.draftId) return { kind: "refused" };

    const id = host.createTabId();
    const adoption = host.adoptDraft(id, draft);
    const added =
      adoption.added !== undefined &&
      adoption.added.id === id &&
      adoption.state.tabs.includes(adoption.added)
        ? adoption.added
        : undefined;
    const owner =
      added ?? findMergedOwner(adoption.state.tabs, draft, host.pathPlatform);
    if (!owner) return { kind: "refused" };

    host.onOwnerReady(owner, added !== undefined);

    if (needsRecoveryDraft(owner)) {
      host.markPersisted(owner.id);
      try {
        await host.writeDraft(draftFromSnapshot(owner));
      } catch {
        host.unmarkPersisted(owner.id);
        return {
          kind: "restored",
          tabId: owner.id,
          persisted: false,
          draftWriteFailed: true,
        };
      }
    }

    // Only the leftover's own id is discarded. When the owner reused it, the
    // successful write above already replaced that draft in place.
    if (draftIdForTab(owner.id) !== info.draftId) {
      discardLeftover(host, info.draftId);
    }
    return {
      kind: "restored",
      tabId: owner.id,
      persisted: true,
      draftWriteFailed: false,
    };
  } catch (error) {
    return { kind: "error", error };
  }
};
