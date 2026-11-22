import { DocumentPortError } from "./DocumentPort";
import { normalizePathKey } from "./documentReducer";
import type {
  DiskEvent,
  DocumentSnapshot,
  DocumentState,
  OpenedFile,
  PathPlatform,
} from "./types";

/**
 * Why a disk event is not actionable. Each reason is a policy decision, not
 * an error: unknown paths may belong to another window, pending saves and
 * version echoes would race the writer, and dirty/missing tabs must not be
 * retargeted behind the user's buffer.
 */
export type DiskEventIgnoreReason =
  | "unknown-path"
  | "pending-save"
  | "self-save-echo"
  | "not-clean"
  | "same-path";

/**
 * The action the controller should take for one normalized disk event. The
 * module only decides; dispatching reducer actions, moving scopes and
 * retargeting watches stay in the controller.
 */
export type DiskEventDecision =
  | { readonly kind: "ignore"; readonly reason: DiskEventIgnoreReason }
  | { readonly kind: "missing"; readonly tabId: string }
  | {
      readonly kind: "reload";
      readonly tabId: string;
      readonly path: string;
      readonly expectedVersion: string | null;
    }
  | {
      readonly kind: "moved";
      readonly tabId: string;
      /** The tab's own path before the move, not the event's alias spelling. */
      readonly previousPath: string;
      readonly from: string;
      readonly to: string;
      readonly scopeChanged: boolean;
    };

export interface DiskReadRequest {
  readonly tabId: string;
  readonly path: string;
  readonly expectedVersion: string | null;
  /** Lifecycle generation captured before the read started. */
  readonly generation: number;
  /**
   * Why the read runs. `watch` is the event-driven reload path: a disk
   * version equal to the expected version is a self-save echo and returns
   * `unchanged`. `explicit` is a user-requested load (for example the
   * conflict dialog's "load disk version"): even an equal version must
   * return `loaded` so the caller can replace the buffer.
   */
  readonly purpose: "watch" | "explicit";
}

/**
 * Host callbacks for a guarded read. `openPath` is the port's reader; the
 * getters expose the live tab state and lifecycle generation so a read that
 * outlives a Save As, rename, save, close, or unmount is detected as stale.
 */
export interface DiskReadHost {
  readonly openPath: (path: string) => Promise<OpenedFile>;
  readonly getState: () => DocumentState;
  readonly getGeneration: () => number;
  readonly pathPlatform: PathPlatform;
}

/**
 * Outcome of a guarded disk read. This module never dispatches, reports, or
 * logs; the caller owns policy:
 * - `unchanged`: a watch read found the disk version it started from (a
 *   self-save echo). Callers ignore it; committing it would turn a dirty tab
 *   into a fake conflict after the user resumed typing post-save. Explicit
 *   reads never return this.
 * - `loaded`: the disk version differs, or the read was explicit; commit
 *   through the reducer.
 * - `missing`: mark the tab missing.
 * - `error`: watcher-driven reloads keep this silent, while an explicit
 *   user action such as `loadDiskVersion` reports it to the user.
 * - `stale`: discard silently because the tab moved past the read.
 */
export type DiskReadOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "loaded"; readonly file: OpenedFile }
  | { readonly kind: "missing" }
  | { readonly kind: "stale" }
  | { readonly kind: "error"; readonly error: unknown };

/**
 * Disk-event paths are canonical; tab paths are user-supplied. Both sides go
 * through the same lexical normalization before comparison.
 */
export const findTabByPath = (
  state: DocumentState,
  path: string,
  pathPlatform: PathPlatform,
): DocumentSnapshot | undefined => {
  const key = normalizePathKey(path, pathPlatform);
  return state.tabs.find(
    (tab) =>
      tab.path !== null && normalizePathKey(tab.path, pathPlatform) === key,
  );
};

/**
 * Canonical parent key used to compare asset-scope coverage. A move only
 * needs a scope release/re-acquire when this key changes; a same-directory
 * rename keeps the existing grant.
 */
export const parentPathKey = (
  path: string,
  pathPlatform: PathPlatform,
): string => {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return normalizePathKey(
    index <= 0 ? "/" : normalized.slice(0, index),
    pathPlatform,
  );
};

/**
 * The commit precondition for an asynchronous disk read: the tab must still
 * hold the same normalized path and saved version, and the lifecycle
 * generation must not have changed, since the read started. Save As, an
 * in-app rename, a disk move, a completed save, a close, or an unmount all
 * invalidate the read.
 */
export const isReadCommitCurrent = (
  state: DocumentState,
  request: DiskReadRequest,
  currentGeneration: number,
  pathPlatform: PathPlatform,
): boolean => {
  if (request.generation !== currentGeneration) return false;
  const tab = state.tabs.find((candidate) => candidate.id === request.tabId);
  return (
    tab !== undefined &&
    tab.path !== null &&
    normalizePathKey(tab.path, pathPlatform) ===
      normalizePathKey(request.path, pathPlatform) &&
    tab.version === request.expectedVersion
  );
};

/**
 * Decides whether a disk event warrants a reducer action. Changed events
 * reload any tab that is not writing; the reducer then atomically reloads a
 * clean tab or surfaces a conflict for a dirty one. Missing events mark the
 * tab missing. A clean source tab follows a move. A pending save or a
 * same-path move stops entirely. A non-clean source keeps its original path
 * and buffer, but the destination is still checked: a sibling temp file
 * renamed over another open tab produces `moved { from: temp, to: open }`,
 * so that destination reloads and the reducer decides between a clean
 * reload and a dirty conflict. This also covers moves whose source is not an
 * open tab at all. Reducer invariants (such as target-path collisions)
 * remain in the reducer.
 */
export const decideDiskEvent = (
  state: DocumentState,
  event: DiskEvent,
  pathPlatform: PathPlatform,
): DiskEventDecision => {
  if (event.kind === "moved") {
    const source = findTabByPath(state, event.from, pathPlatform);
    if (source && source.path !== null) {
      const previousPath = source.path;
      if (source.pendingSave) {
        return { kind: "ignore", reason: "pending-save" };
      }
      if (
        normalizePathKey(previousPath, pathPlatform) ===
        normalizePathKey(event.to, pathPlatform)
      ) {
        return { kind: "ignore", reason: "same-path" };
      }
      if (source.status === "clean") {
        return {
          kind: "moved",
          tabId: source.id,
          previousPath,
          from: event.from,
          to: event.to,
          // The asset scope was granted for the tab's own path, so compare
          // its parent with the move target rather than trusting the event's
          // alias.
          scopeChanged:
            parentPathKey(previousPath, pathPlatform) !==
            parentPathKey(event.to, pathPlatform),
        };
      }
      // A non-clean source keeps its path and buffer. Fall through: the move
      // target may be another open tab that still must reload.
    }

    // Atomic replace: a sibling temp file was renamed over a file that is
    // open here, or over the target of a move whose source buffer did not
    // follow. The destination must still follow the rewritten file.
    // Reloading lets the reducer apply its own clean-reload/dirty-conflict
    // rule without duplicating it here.
    const target = findTabByPath(state, event.to, pathPlatform);
    if (!target || target.path === null) {
      return {
        kind: "ignore",
        reason: source ? "not-clean" : "unknown-path",
      };
    }
    if (target.pendingSave) {
      return { kind: "ignore", reason: "pending-save" };
    }
    return {
      kind: "reload",
      tabId: target.id,
      path: target.path,
      expectedVersion: target.version,
    };
  }

  const tab = findTabByPath(state, event.path, pathPlatform);
  if (!tab || tab.path === null) {
    return { kind: "ignore", reason: "unknown-path" };
  }
  // Events during a write are suppressed: the write itself is version
  // checked, and a reload here could clobber the pending snapshot.
  if (tab.pendingSave) return { kind: "ignore", reason: "pending-save" };
  if (event.kind === "missing") {
    return { kind: "missing", tabId: tab.id };
  }
  // Echoes of our own completed saves carry the version we just wrote.
  if (tab.version !== null && tab.version === event.version) {
    return { kind: "ignore", reason: "self-save-echo" };
  }
  return {
    kind: "reload",
    tabId: tab.id,
    path: tab.path,
    expectedVersion: tab.version,
  };
};

/**
 * Reads the current disk version through `openPath` and validates the result
 * against the guard captured at read start. A stale result is returned as
 * `stale` regardless of the read result and takes precedence over every
 * other outcome. Once the lifecycle/path/version guard passes, a `watch`
 * read whose file version equals the expected version is `unchanged` (a
 * self-save echo the caller must ignore), while an `explicit` read always
 * returns `loaded` even for an equal version so the caller can replace the
 * buffer. A genuinely different version is always `loaded`. `not_found` is
 * classified as missing only while the guard is still current; every other
 * failure is returned as `error` for the caller to handle: watcher-driven
 * reloads keep it silent, while an explicit `loadDiskVersion` action reports
 * it to the user.
 */
export const readCurrentDiskVersion = async (
  request: DiskReadRequest,
  host: DiskReadHost,
): Promise<DiskReadOutcome> => {
  const pathPlatform = host.pathPlatform;
  try {
    const file = await host.openPath(request.path);
    if (
      !isReadCommitCurrent(
        host.getState(),
        request,
        host.getGeneration(),
        pathPlatform,
      )
    ) {
      return { kind: "stale" };
    }
    return request.purpose === "watch" &&
      file.version === request.expectedVersion
      ? { kind: "unchanged" }
      : { kind: "loaded", file };
  } catch (error) {
    if (
      !isReadCommitCurrent(
        host.getState(),
        request,
        host.getGeneration(),
        pathPlatform,
      )
    ) {
      return { kind: "stale" };
    }
    if (error instanceof DocumentPortError && error.code === "not_found") {
      return { kind: "missing" };
    }
    return { kind: "error", error };
  }
};
