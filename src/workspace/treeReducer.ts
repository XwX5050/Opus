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
  readonly filter: string;
}

export type TreeAction =
  | { type: "workspaceOpened"; root: WorkspaceRoot }
  | { type: "loadRequested"; path: string }
  | { type: "loadSucceeded"; path: string; children: ReadonlyArray<DirectoryEntry> }
  | { type: "loadFailed"; path: string }
  | { type: "loadRetried"; path: string }
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
    loading: remap(state.loading),
    failed: remap(state.failed),
  };
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
  const keep = (set: ReadonlySet<string>): ReadonlySet<string> => {
    const next = new Set<string>();
    for (const candidate of set) {
      if (candidate !== path && !candidate.startsWith(`${path}/`)) next.add(candidate);
    }
    return next;
  };
  return {
    children,
    expanded: keep(state.expanded),
    loading: keep(state.loading),
    failed: keep(state.failed),
  };
};

export function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case "workspaceOpened":
      return { ...initialTreeState, root: action.root };
    case "loadRequested":
      return { ...state, loading: withSet(state.loading, action.path, true) };
    case "loadSucceeded":
      return {
        ...state,
        loading: withSet(state.loading, action.path, false),
        failed: withSet(state.failed, action.path, false),
        children: { ...state.children, [action.path]: [...action.children].sort(byName) },
      };
    case "loadFailed":
      return {
        ...state,
        loading: withSet(state.loading, action.path, false),
        failed: withSet(state.failed, action.path, true),
      };
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
