import type { DirectoryEntry, WorkspaceRoot } from "../document/DocumentPort";

export interface TreeState {
  readonly root: WorkspaceRoot | null;
  /** Directory paths whose children are visible. */
  readonly expanded: ReadonlySet<string>;
  /** Directory paths with an in-flight listing request. */
  readonly loading: ReadonlySet<string>;
  /** Directory paths whose last listing request failed; not auto-retried. */
  readonly failed: ReadonlySet<string>;
  /** Loaded listings keyed by directory path; only loaded nodes are stored. */
  readonly children: Readonly<Record<string, ReadonlyArray<DirectoryEntry>>>;
  /**
   * Listing generation per directory path. Listing results
   * (`loadSucceeded`/`loadFailed`) capture the generation they were issued
   * under; a disk invalidation or a rename bumps the generation so in-flight
   * results for stale paths are discarded instead of landing as ghosts (or
   * leaving `loading` stuck).
   */
  readonly epochs: Readonly<Record<string, number>>;
  readonly filter: string;
}

export type TreeAction =
  | { type: "workspaceOpened"; root: WorkspaceRoot }
  | { type: "loadRequested"; path: string }
  | {
      type: "loadSucceeded";
      path: string;
      children: ReadonlyArray<DirectoryEntry>;
      /** Generation captured when the listing request was issued. */
      epoch: number;
    }
  | { type: "loadFailed"; path: string; epoch: number }
  | { type: "loadRetried"; path: string }
  /**
   * A disk event changed this directory's contents: drop its cached listing
   * (and any failure/loading mark) so `pendingLoads` re-requests it. Expansion
   * is untouched, so the user's open folders stay expanded.
   */
  | { type: "directoryInvalidated"; path: string }
  | { type: "directoryToggled"; path: string }
  | { type: "filterChanged"; filter: string }
  | { type: "entryCreated"; parentPath: string; entry: DirectoryEntry }
  | { type: "entryRenamed"; parentPath: string; from: string; entry: DirectoryEntry }
  | { type: "entryRemoved"; parentPath: string; path: string };

export const initialTreeState: TreeState = {
  root: null,
  expanded: new Set(),
  loading: new Set(),
  failed: new Set(),
  children: {},
  epochs: {},
  filter: "",
};

const withSet = (
  set: ReadonlySet<string>,
  path: string,
  present: boolean,
): ReadonlySet<string> => {
  if (set.has(path) === present) return set;
  const next = new Set(set);
  if (present) next.add(path);
  else next.delete(path);
  return next;
};

const byName = (left: DirectoryEntry, right: DirectoryEntry): number => {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  return (
    left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
    left.name.localeCompare(right.name)
  );
};

/** Re-keys every cached listing below a renamed directory. */
const moveSubtree = (
  state: TreeState,
  from: string,
  to: string,
): Pick<TreeState, "children" | "expanded" | "loading" | "failed"> => {
  const children: Record<string, ReadonlyArray<DirectoryEntry>> = {};
  for (const [key, entries] of Object.entries(state.children)) {
    if (key === from || key.startsWith(`${from}/`)) {
      const movedKey = to + key.slice(from.length);
      children[movedKey] = entries.map((entry) =>
        entry.path.startsWith(`${from}/`)
          ? { ...entry, path: to + entry.path.slice(from.length) }
          : entry,
      );
    } else {
      children[key] = entries;
    }
  }
  const remap = (set: ReadonlySet<string>): ReadonlySet<string> => {
    const next = new Set<string>();
    for (const path of set) {
      next.add(path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    }
    return next;
  };
  return {
    children,
    expanded: remap(state.expanded),
    // In-flight requests for the old subtree are dropped, not remapped: their
    // results are stale and would land as ghosts under the old keys. The
    // `pendingLoads` pass re-requests the renamed path under a fresh epoch.
    loading: dropSubtreeKeys(state.loading, from),
    failed: remap(state.failed),
  };
};

/** Bumps the listing generation of every path under `from` so in-flight
 * results issued for the old subtree are discarded by the epoch guard. */
const bumpEpochs = (
  epochs: Readonly<Record<string, number>>,
  from: string,
): Readonly<Record<string, number>> => {
  const next: Record<string, number> = {};
  let bumped = false;
  for (const [key, epoch] of Object.entries(epochs)) {
    if (key === from || key.startsWith(`${from}/`)) {
      next[key] = epoch + 1;
      bumped = true;
    } else {
      next[key] = epoch;
    }
  }
  // Ensure even a path with no tracked generation rejects a stale result.
  if (!bumped) next[from] = 1;
  return next;
};

/** Drops `path` and every descendant from a path set. */
const dropSubtreeKeys = (
  set: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> => {
  const next = new Set<string>();
  for (const candidate of set) {
    if (candidate !== path && !candidate.startsWith(`${path}/`)) next.add(candidate);
  }
  return next;
};

/** Drops one key from a record, reusing the input when it was absent. */
const dropKey = <T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> => {
  if (!(key in record)) return record;
  const next: Record<string, T> = { ...record };
  delete next[key];
  return next;
};

/** Drops every cached listing below a removed entry. */
const dropSubtree = (
  state: TreeState,
  path: string,
): Pick<TreeState, "children" | "expanded" | "loading" | "failed"> => {
  const children: Record<string, ReadonlyArray<DirectoryEntry>> = {};
  for (const [key, entries] of Object.entries(state.children)) {
    if (key !== path && !key.startsWith(`${path}/`)) children[key] = entries;
  }
  return {
    children,
    expanded: dropSubtreeKeys(state.expanded, path),
    loading: dropSubtreeKeys(state.loading, path),
    failed: dropSubtreeKeys(state.failed, path),
  };
};

export function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case "workspaceOpened":
      return { ...initialTreeState, root: action.root };
    case "loadRequested":
      return { ...state, loading: withSet(state.loading, action.path, true) };
    case "loadSucceeded": {
      // A rename or disk invalidation may have superseded this request; its
      // result describes an older generation and must not land.
      if ((state.epochs[action.path] ?? 0) !== action.epoch) return state;
      return {
        ...state,
        loading: withSet(state.loading, action.path, false),
        failed: withSet(state.failed, action.path, false),
        children: { ...state.children, [action.path]: [...action.children].sort(byName) },
      };
    }
    case "loadFailed": {
      if ((state.epochs[action.path] ?? 0) !== action.epoch) return state;
      return {
        ...state,
        loading: withSet(state.loading, action.path, false),
        failed: withSet(state.failed, action.path, true),
      };
    }
    case "loadRetried":
      // Clearing the failure flag makes the directory eligible for
      // `pendingLoads` again, so the next render re-requests it.
      return { ...state, failed: withSet(state.failed, action.path, false) };
    case "directoryToggled": {
      if (state.expanded.has(action.path)) {
        // Collapsing keeps cached children so re-expanding is free.
        return { ...state, expanded: withSet(state.expanded, action.path, false) };
      }
      return {
        ...state,
        expanded: withSet(state.expanded, action.path, true),
        failed: withSet(state.failed, action.path, false),
      };
    }
    case "filterChanged":
      return { ...state, filter: action.filter };
    case "entryCreated": {
      const cached = state.children[action.parentPath];
      if (!cached) return state;
      return {
        ...state,
        children: {
          ...state.children,
          [action.parentPath]: [...cached, action.entry].sort(byName),
        },
      };
    }
    case "entryRenamed": {
      const cached = state.children[action.parentPath];
      const subtree = moveSubtree(state, action.from, action.entry.path);
      return {
        ...state,
        ...subtree,
        epochs: bumpEpochs(state.epochs, action.from),
        children: cached
          ? {
              ...subtree.children,
              [action.parentPath]: cached
                .filter((entry) => entry.path !== action.from)
                .concat(action.entry)
                .sort(byName),
            }
          : subtree.children,
      };
    }
    case "entryRemoved": {
      const cached = state.children[action.parentPath];
      const subtree = dropSubtree(state, action.path);
      return {
        ...state,
        ...subtree,
        children: cached
          ? {
              ...subtree.children,
              [action.parentPath]: cached.filter((entry) => entry.path !== action.path),
            }
          : subtree.children,
      };
    }
    case "directoryInvalidated": {
      // Bumping the generation discards any in-flight result for this path;
      // clearing `loading` lets `pendingLoads` schedule a fresh listing
      // immediately instead of waiting for the stale request to settle.
      return {
        ...state,
        epochs: {
          ...state.epochs,
          [action.path]: (state.epochs[action.path] ?? 0) + 1,
        },
        children: dropKey(state.children, action.path),
        loading: withSet(state.loading, action.path, false),
        failed: withSet(state.failed, action.path, false),
      };
    }
  }
}

/**
 * Directory paths that need a listing request: the root plus every expanded
 * directory that is neither cached, in flight, nor previously failed.
 */
export function pendingLoads(state: TreeState): ReadonlyArray<string> {
  if (!state.root) return [];
  const candidates = [state.root.path, ...state.expanded];
  return candidates.filter(
    (path) =>
      state.children[path] === undefined &&
      !state.loading.has(path) &&
      !state.failed.has(path),
  );
}

export interface VisibleTreeRow {
  readonly entry: DirectoryEntry;
  readonly depth: number;
  readonly isExpanded: boolean;
}

/**
 * Flattens the loaded tree for rendering. Without a filter, only expanded
 * directories contribute their children; with a filter, every loaded node
 * whose name matches is listed regardless of expansion.
 */
export function visibleRows(state: TreeState): ReadonlyArray<VisibleTreeRow> {
  if (!state.root) return [];
  const rows: VisibleTreeRow[] = [];
  const filter = state.filter.trim().toLowerCase();
  const visit = (path: string, depth: number, descendAll: boolean) => {
    for (const entry of state.children[path] ?? []) {
      const isExpanded = state.expanded.has(entry.path);
      if (!filter || entry.name.toLowerCase().includes(filter)) {
        rows.push({ entry, depth, isExpanded });
      }
      if (entry.isDirectory && (descendAll || isExpanded)) {
        visit(entry.path, depth + 1, descendAll);
      }
    }
  };
  visit(state.root.path, 1, filter.length > 0);
  return rows;
}
