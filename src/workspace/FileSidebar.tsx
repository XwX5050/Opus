import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  DirectoryEntry,
  DocumentPort,
  WorkspaceRoot,
} from "../document/DocumentPort";
import {
  initialTreeState,
  pendingLoads,
  treeReducer,
  visibleRows,
  type VisibleTreeRow,
} from "./treeReducer";

export interface FileSidebarProps {
  root: WorkspaceRoot;
  port: DocumentPort;
  onOpenFile: (path: string) => void;
  onCloseWorkspace: () => void;
}

type Editing =
  | { readonly kind: "create" }
  | { readonly kind: "rename"; readonly path: string };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Path math assumes POSIX separators — deliberate: this is a macOS-only app.
const parentPathOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

function NameInput({
  defaultValue = "",
  onCommit,
  onCancel,
}: {
  defaultValue?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus and select once on mount only. A ref callback would get a new
  // identity every render, so a background tree update would re-select the
  // text and the user's next keystroke would wipe it.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      type="text"
      aria-label="文件名"
      defaultValue={defaultValue}
      ref={inputRef}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

/**
 * Lazy folder drawer for the opened workspace. The tree stores only loaded
 * nodes (see treeReducer); expanding a directory requests exactly that
 * directory's listing, and collapsing keeps the cached children.
 */
export default function FileSidebar({
  root,
  port,
  onOpenFile,
  onCloseWorkspace,
}: FileSidebarProps) {
  const [state, dispatch] = useReducer(treeReducer, initialTreeState);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(new Set<string>());
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const rootPathRef = useRef(root.path);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset the tree whenever a different workspace opens.
  useEffect(() => {
    rootPathRef.current = root.path;
    inFlightRef.current.clear();
    rowRefs.current.clear();
    dispatch({ type: "workspaceOpened", root });
    setActivePath(null);
    setEditing(null);
    setError(null);
  }, [root]);

  // Request listings for the root and expanded-but-unloaded directories.
  useEffect(() => {
    if (!state.root) return;
    const rootPath = root.path;
    for (const path of pendingLoads(state)) {
      if (inFlightRef.current.has(path)) continue;
      inFlightRef.current.add(path);
      dispatch({ type: "loadRequested", path });
      const relative = path === rootPath ? "" : path.slice(rootPath.length + 1);
      const settled = () => {
        inFlightRef.current.delete(path);
        return mountedRef.current && rootPathRef.current === rootPath;
      };
      port.listDirectory(rootPath, relative).then(
        (children) => {
          if (settled()) dispatch({ type: "loadSucceeded", path, children });
        },
        () => {
          if (settled()) dispatch({ type: "loadFailed", path });
        },
      );
    }
  }, [state, port, root.path]);

  const rows = visibleRows(state);
  const activeRow =
    rows.find((row) => row.entry.path === activePath) ?? rows[0] ?? null;

  const focusRow = (row: VisibleTreeRow) => {
    setActivePath(row.entry.path);
    rowRefs.current.get(row.entry.path)?.focus();
  };

  const activate = (entry: DirectoryEntry) => {
    setActivePath(entry.path);
    if (entry.isDirectory) dispatch({ type: "directoryToggled", path: entry.path });
    else onOpenFile(entry.path);
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.closest("button")) return;
    if (!activeRow) return;
    const index = rows.findIndex((row) => row.entry.path === activeRow.entry.path);
    const move = (next: VisibleTreeRow | undefined) => {
      if (next) {
        event.preventDefault();
        focusRow(next);
      }
    };
    switch (event.key) {
      case "ArrowDown":
        move(rows[index + 1]);
        break;
      case "ArrowUp":
        move(rows[index - 1]);
        break;
      case "Home":
        move(rows[0]);
        break;
      case "End":
        move(rows.at(-1));
        break;
      case "ArrowRight":
        event.preventDefault();
        if (activeRow.entry.isDirectory) {
          if (!activeRow.isExpanded) {
            dispatch({ type: "directoryToggled", path: activeRow.entry.path });
          } else {
            move(rows[index + 1]);
          }
        }
        break;
      case "ArrowLeft": {
        event.preventDefault();
        if (activeRow.entry.isDirectory && activeRow.isExpanded) {
          dispatch({ type: "directoryToggled", path: activeRow.entry.path });
          break;
        }
        const parent = parentPathOf(activeRow.entry.path);
        move(rows.find((row) => row.entry.path === parent));
        break;
      }
      case "Enter":
        event.preventDefault();
        activate(activeRow.entry);
        break;
    }
  };

  const relativeOf = (path: string): string => path.slice(root.path.length + 1);

  const commitCreate = async (name: string) => {
    // Create next to the active row, but only inside a directory whose
    // listing is already loaded — otherwise the new file would be invisible.
    const parent =
      activeRow?.entry.isDirectory && state.children[activeRow.entry.path]
        ? activeRow.entry.path
        : activeRow
          ? parentPathOf(activeRow.entry.path)
          : root.path;
    const parentRelative = parent === root.path ? "" : relativeOf(parent);
    const relative = parentRelative ? `${parentRelative}/${name}` : name;
    try {
      const entry = await port.createMarkdownFile(root.path, relative);
      dispatch({ type: "entryCreated", parentPath: parent, entry });
      setEditing(null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const commitRename = async (from: string, name: string) => {
    try {
      const entry = await port.renameEntry(root.path, relativeOf(from), name);
      dispatch({
        type: "entryRenamed",
        parentPath: parentPathOf(from),
        from,
        entry,
      });
      setEditing(null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const trash = async (entry: DirectoryEntry) => {
    try {
      // A failed trash leaves the tree unchanged: only a resolved call
      // removes the entry.
      await port.trashEntry(root.path, relativeOf(entry.path));
      dispatch({
        type: "entryRemoved",
        parentPath: parentPathOf(entry.path),
        path: entry.path,
      });
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <div className="sidebar-panel">
      <div className="sidebar-header">
        <strong className="sidebar-title">{root.title}</strong>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setEditing({ kind: "create" });
          }}
        >
          新建文件
        </button>
        <button type="button" onClick={onCloseWorkspace}>
          关闭文件夹
        </button>
      </div>
      <input
        type="text"
        aria-label="筛选文件"
        className="sidebar-filter"
        value={state.filter}
        onChange={(event) =>
          dispatch({ type: "filterChanged", filter: event.target.value })
        }
      />
      {error && <div role="alert">{error}</div>}
      {[...state.failed]
        .filter((path) => path === root.path || state.expanded.has(path))
        .map((path) => (
          <div key={path} className="sidebar-failure">
            <span className="sidebar-failure-text">
              加载失败：{path === root.path ? root.title : relativeOf(path)}
            </span>
            <button
              type="button"
              onClick={() => dispatch({ type: "loadRetried", path })}
            >
              重试
            </button>
          </div>
        ))}
      {editing?.kind === "create" && (
        <NameInput onCommit={(name) => void commitCreate(name)} onCancel={() => setEditing(null)} />
      )}
      <ul
        role="tree"
        aria-label="工作区文件"
        className="file-tree"
        data-motion-list="files"
        onKeyDown={onTreeKeyDown}
      >
        {rows.map((row) => {
          const { entry, depth } = row;
          const isActive = row === activeRow;
          const renaming = editing?.kind === "rename" && editing.path === entry.path;
          return (
            <li
              key={entry.path}
              role="treeitem"
              aria-label={entry.name}
              aria-level={depth}
              aria-expanded={entry.isDirectory ? row.isExpanded : undefined}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className="file-tree-row"
              data-motion-item="file"
              ref={(element) => {
                if (element) rowRefs.current.set(entry.path, element);
                else rowRefs.current.delete(entry.path);
              }}
              onClick={() => {
                if (!renaming) activate(entry);
              }}
              style={{ paddingLeft: depth * 12 }}
            >
              {entry.isDirectory && (
                <span aria-hidden="true">{row.isExpanded ? "▾" : "▸"}</span>
              )}
              {renaming ? (
                <NameInput
                  defaultValue={entry.name}
                  onCommit={(name) => void commitRename(entry.path, name)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <span className="file-tree-name">{entry.name}</span>
              )}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setError(null);
                  setEditing({ kind: "rename", path: entry.path });
                }}
              >
                重命名
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void trash(entry);
                }}
              >
                移到废纸篓
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
