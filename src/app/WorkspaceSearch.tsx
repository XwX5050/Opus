import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type {
  DocumentPort,
  WorkspaceRoot,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
} from "../document/DocumentPort";

const SEARCH_DEBOUNCE_MS = 250;

interface WorkspaceSearchProps {
  readonly port: DocumentPort;
  readonly workspace: WorkspaceRoot | null;
  readonly dedicated?: boolean;
  readonly autoFocus?: boolean;
  onOpenResult(match: WorkspaceSearchMatch): void;
}

type SearchState =
  | { readonly phase: "idle" }
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | { readonly phase: "ready"; readonly result: WorkspaceSearchResult };

const pathLabel = (root: string, path: string): string => {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedPath = path.replaceAll("\\", "/");
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
};

function MatchingLine({ match }: { readonly match: WorkspaceSearchMatch }) {
  const characters = [...match.text];
  const before = characters.slice(0, match.column).join("");
  const highlighted = characters
    .slice(match.column, match.column + match.matchLength)
    .join("");
  const after = characters.slice(match.column + match.matchLength).join("");
  return (
    <span className="workspace-search-line">
      {before}<mark>{highlighted}</mark>{after}
    </span>
  );
}

export default function WorkspaceSearch({
  port,
  workspace,
  dedicated = false,
  autoFocus = false,
  onOpenResult,
}: WorkspaceSearchProps) {
  const root = workspace?.path ?? null;
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const sequenceRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLElement>(null);
  const inputId = useId();
  const resultsId = useId();

  const execute = async (workspaceRoot: string, text: string, sequence: number) => {
    setState({ phase: "loading" });
    setOpen(true);
    try {
      const result = await port.searchWorkspace(workspaceRoot, text);
      if (sequenceRef.current !== sequence) return;
      setState({ phase: "ready", result });
      setActiveIndex(0);
    } catch (error) {
      if (sequenceRef.current !== sequence) return;
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  useEffect(() => {
    const sequence = ++sequenceRef.current;
    const text = query.trim();
    if (!root || !text) {
      setState({ phase: "idle" });
      setOpen(false);
      return;
    }
    timerRef.current = setTimeout(() => {
      void execute(root, text, sequence);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, root]);

  useEffect(() => () => {
    sequenceRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (!open || dedicated) return;
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open, dedicated]);

  const matches = state.phase === "ready" ? state.result.matches : [];
  const groups = useMemo(() => {
    if (!root) return [];
    const grouped = new Map<string, { match: WorkspaceSearchMatch; index: number }[]>();
    matches.forEach((match, index) => {
      const entries = grouped.get(match.path) ?? [];
      entries.push({ match, index });
      grouped.set(match.path, entries);
    });
    return [...grouped].map(([path, entries]) => ({ path, entries }));
  }, [matches, root]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${resultsId}-${activeIndex}`)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [activeIndex, open, resultsId]);

  const openMatch = (match: WorkspaceSearchMatch) => {
    setOpen(false);
    onOpenResult(match);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!root || !text) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    void execute(root, text, ++sequenceRef.current);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) return;
    if (event.key === "Enter" && open && matches.length > 0) {
      event.preventDefault();
      openMatch(matches[activeIndex] ?? matches[0]);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (matches.length === 0) return;
    event.preventDefault();
    setOpen(true);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setActiveIndex((current) => (current + delta + matches.length) % matches.length);
  };

  return (
    <search
      className={`workspace-search${dedicated ? " workspace-search-dedicated" : ""}`}
      ref={containerRef}
    >
      {dedicated && <div className="workspace-search-title"><h2>搜索</h2></div>}
      <form onSubmit={onSubmit} className="workspace-search-form">
        <label className="visually-hidden" htmlFor={inputId}>工作区全文搜索</label>
        <input
          id={inputId}
          name="workspace-query"
          type="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
          autoFocus={autoFocus}
          disabled={!root}
          placeholder={root ? (dedicated ? "搜索 Markdown 文件…" : "搜索文件夹中的 Markdown…") : "打开文件夹后搜索全文"}
          value={query}
          role="combobox"
          aria-expanded={open && Boolean(query.trim())}
          aria-controls={resultsId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches.length > 0 ? `${resultsId}-${activeIndex}` : undefined}
          onFocus={() => {
            if (state.phase !== "idle" && query.trim()) setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="icon-button workspace-search-submit" aria-label="搜索" disabled={!root || !query.trim()}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
        </button>
      </form>
      {open && query.trim() && (
        <div id={resultsId} className="workspace-search-results">
          {state.phase === "loading" && <div className="workspace-search-state">正在搜索已保存的文档…</div>}
          {state.phase === "error" && <div role="alert" className="workspace-search-state">搜索失败：{state.message}</div>}
          {state.phase === "ready" && (
            <>
              <div role="status" className="workspace-search-summary">
                {matches.length === 0 ? "没有找到匹配内容" : `${matches.length} 处匹配`}
                {state.result.truncated && "，仅显示前 200 处"}
              </div>
              {matches.length > 0 && (
                <div role="listbox" aria-label="全文搜索结果" className="workspace-search-list">
                  {groups.map((group) => (
                    <div role="group" aria-label={root ? pathLabel(root, group.path) : group.path} key={group.path}>
                      <div className="workspace-search-file">{root ? pathLabel(root, group.path) : group.path}</div>
                      {group.entries.map(({ match, index }) => (
                        <div
                          id={`${resultsId}-${index}`}
                          role="option"
                          aria-selected={index === activeIndex}
                          className="workspace-search-match"
                          key={`${match.path}:${match.line}:${match.column}:${index}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => openMatch(match)}
                          onMouseMove={() => setActiveIndex(index)}
                        >
                          <span className="workspace-search-line-number">{match.line}</span>
                          <MatchingLine match={match} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </search>
  );
}
