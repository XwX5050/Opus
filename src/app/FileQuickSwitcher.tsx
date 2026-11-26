import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { detectPathPlatform } from "../document/platform";
import type {
  DocumentPort,
  WorkspaceRoot,
} from "../document/DocumentPort";
import {
  collectWorkspaceFiles,
  highlightSegments,
  normalizeNewMarkdownPath,
  quickSwitcherShortcuts,
  splitDisplayPath,
} from "./fileSwitcher";
import "./searchViews.css";

interface FileQuickSwitcherProps {
  readonly open: boolean;
  readonly port: DocumentPort;
  readonly workspace: WorkspaceRoot | null;
  readonly additionalPaths: ReadonlyArray<string>;
  onOpenFile(path: string): Promise<unknown>;
  onClose(): void;
}

type SwitcherOption =
  | {
      readonly kind: "open";
      readonly path: string;
      readonly relative: string;
      readonly label: string;
    }
  | { readonly kind: "create"; readonly relative: string; readonly label: string };

export default function FileQuickSwitcher({
  open,
  port,
  workspace,
  additionalPaths,
  onOpenFile,
  onClose,
}: FileQuickSwitcherProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outsidePressRef = useRef(false);
  const additionalPathsRef = useRef(additionalPaths);
  const sequenceRef = useRef(0);
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const titleId = useId();
  const inputId = useId();
  const listId = useId();
  additionalPathsRef.current = additionalPaths;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const sequence = ++sequenceRef.current;
    setQuery("");
    setError(null);
    setActiveIndex(0);
    setMoreOpen(false);
    setLoading(true);
    const root = workspace?.path ?? null;
    void (async () => {
      try {
        const workspacePaths = root ? await collectWorkspaceFiles(port, root) : [];
        if (sequenceRef.current !== sequence) return;
        setPaths([...new Set([...additionalPathsRef.current, ...workspacePaths])]);
      } catch (caught) {
        if (sequenceRef.current !== sequence) return;
        setPaths([...additionalPathsRef.current]);
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (sequenceRef.current === sequence) setLoading(false);
      }
    })();
  }, [open, port, workspace?.path]);

  const relativeOf = (path: string): string => {
    if (!workspace) return path;
    const root = workspace.path.replaceAll("\\", "/").replace(/\/$/, "");
    const normalized = path.replaceAll("\\", "/");
    return normalized.startsWith(`${root}/`)
      ? normalized.slice(root.length + 1)
      : path;
  };

  const shortcuts = useMemo(
    () => quickSwitcherShortcuts(detectPathPlatform() === "macos"),
    [],
  );

  const options = useMemo<SwitcherOption[]>(() => {
    const folded = query.trim().toLocaleLowerCase();
    const filtered = paths
      .filter((path) => relativeOf(path).toLocaleLowerCase().includes(folded))
      .slice(0, 50)
      .map((path): SwitcherOption => {
        const relative = relativeOf(path);
        return {
          kind: "open",
          path,
          relative,
          label: workspace ? `${workspace.title}/${relative}` : path,
        };
      });
    const relative = normalizeNewMarkdownPath(query);
    if (!workspace || !relative) return filtered;
    const exists = paths.some(
      (path) => relativeOf(path).toLocaleLowerCase() === relative.toLocaleLowerCase(),
    );
    if (!exists) {
      filtered.push({
        kind: "create",
        relative,
        label: `创建 ${workspace.title}/${relative}`,
      });
    }
    return filtered;
  }, [paths, query, workspace]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, options.length - 1)));
  }, [options.length]);

  useEffect(() => {
    if (activeIndex >= 6) setMoreOpen(true);
    if (options.length === 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [activeIndex, listId, moreOpen, options.length]);

  const activate = async (option: SwitcherOption | undefined) => {
    if (!option || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (option.kind === "create") {
        if (!workspace) return;
        const entry = await port.createMarkdownFile(workspace.path, option.relative);
        await onOpenFile(entry.path);
      } else {
        await onOpenFile(option.path);
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + delta + options.length) % options.length);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.shiftKey) {
      void activate(options.find((option) => option.kind === "create"));
    } else {
      void activate(options[activeIndex] ?? options[0]);
    }
  };

  const isOutsideDialog = (event: ReactPointerEvent<HTMLDialogElement>): boolean => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };

  const renderHighlighted = (text: string) =>
    highlightSegments(text, query).map((segment, segmentIndex) =>
      segment.match ? (
        <mark key={segmentIndex}>{segment.text}</mark>
      ) : (
        <Fragment key={segmentIndex}>{segment.text}</Fragment>
      ),
    );

  const renderOption = (option: SwitcherOption, index: number) => {
    const { dir, name } = splitDisplayPath(option.relative);
    return (
      <div
        id={`${listId}-${index}`}
        key={option.kind === "open" ? option.path : option.relative}
        role="option"
        aria-selected={index === activeIndex}
        aria-label={option.label}
        title={option.label}
        className="file-switcher-option"
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActiveIndex(index)}
        onClick={() => void activate(option)}
      >
        {option.kind === "create" && (
          <span className="file-switcher-option-badge">创建</span>
        )}
        <span className="file-switcher-option-name">{renderHighlighted(name)}</span>
        {dir && (
          <span className="file-switcher-option-dir">{renderHighlighted(dir)}</span>
        )}
      </div>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className="file-switcher-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      onClose={onClose}
      onPointerDown={(event) => {
        outsidePressRef.current = isOutsideDialog(event);
      }}
      onPointerUp={(event) => {
        if (outsidePressRef.current && isOutsideDialog(event) && !busy) onClose();
        outsidePressRef.current = false;
      }}
      onPointerCancel={() => {
        outsidePressRef.current = false;
      }}
      {...({ closedby: "any" } as Record<string, string>)}
    >
      <h2 id={titleId} className="visually-hidden">文件</h2>
      <div className="file-switcher-input-row">
        <label className="visually-hidden" htmlFor={inputId}>切换或创建文件</label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          placeholder="输入以切换或创建文件…"
          value={query}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={options.length > 0 ? `${listId}-${activeIndex}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setMoreOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="file-switcher-body">
        {loading && <div className="file-switcher-state">正在读取文件列表…</div>}
        {error && <div role="alert" className="file-switcher-state">{error}</div>}
        {!loading && options.length === 0 && (
          <div className="file-switcher-state">没有匹配的文件</div>
        )}
        {options.length > 0 && (
          <div id={listId} role="listbox" aria-label="文件列表" className="file-switcher-list">
            {options.slice(0, 6).map(renderOption)}
            {options.length > 6 && (
              <details
                className="file-switcher-more"
                open={moreOpen}
                onToggle={(event) => setMoreOpen(event.currentTarget.open)}
              >
                <summary>更多…</summary>
                {/* Keep option indices global so ids, aria-selected and
                    aria-activedescendant agree across the disclosure. */}
                {options.slice(6).map((option, index) => renderOption(option, index + 6))}
              </details>
            )}
          </div>
        )}
      </div>
      <div className="file-switcher-footer" aria-hidden="true">
        {shortcuts.map((shortcut) => (
          <span
            key={`${shortcut.key}:${shortcut.label}`}
            className="file-switcher-shortcut"
          >
            <kbd>{shortcut.key}</kbd>
            {shortcut.label}
          </span>
        ))}
      </div>
    </dialog>
  );
}
