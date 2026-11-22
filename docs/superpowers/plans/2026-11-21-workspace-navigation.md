# Workspace Navigation and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Move Opus to an explorer-plus-horizontal-tabs shell and add bounded workspace full-text search with result navigation.

**Architecture:** Extend `DocumentPort` with a read-only search operation backed by canonical-root-confined Rust filesystem scanning and a matching memory implementation. Add focused shell components for horizontal tabs, search results, and the empty explorer/welcome views; integrate them into `AppShell` without changing document persistence.

**Tech Stack:** React 19, strict TypeScript, CodeMirror 6, Rust/Tauri 2, Vitest, Playwright, existing CSS tokens.

---

### Task 1: Search contract and native backend

**Files:**
- Modify `src-tauri/src/workspace.rs`, `src-tauri/src/document_commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/tests/workspace.rs`, `src-tauri/tests/document_commands.rs`.
- Modify `src/document/DocumentPort.ts`, `src/document/tauriDocumentPort.ts`, `src/document/memoryDocumentPort.ts` and their tests.

- [x] Write failing Rust tests for case-insensitive multi-line matches, hidden/non-Markdown exclusion, invalid UTF-8, root boundaries, and the 200-result cap.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml --test workspace` and confirm the new cases fail.
- [x] Implement the serializable result and bounded scanner.

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorkspaceSearchMatch {
    pub path: PathBuf,
    pub line: usize,
    pub column: usize,
    pub text: String,
    pub match_length: usize,
}
```

Search is called as `workspace::search_markdown(root, query)`. Trim the query, return an empty vector for an empty query, use `chars().count()` for match length, scan only canonical in-root Markdown files, and stop at 200 matches. Add `search_workspace` to `document_commands.rs` behind `assert_workspace_anchored` and register it in `lib.rs`.

- [x] Add the frontend contract.

```ts
export interface WorkspaceSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly matchLength: number;
}

export interface WorkspaceSearchResult {
  readonly matches: ReadonlyArray<WorkspaceSearchMatch>;
  readonly truncated: boolean;
}

searchWorkspace(root: string, query: string): Promise<WorkspaceSearchResult>;
```

Map Rust snake_case DTOs in `tauriDocumentPort.ts`; implement identical case-insensitive line matching in `memoryDocumentPort.ts`, including root-boundary checks.

- [x] Run the port and Rust tests; all must pass.

### Task 2: Horizontal document tabs

**Files:**
- Modify `src/app/TabList.tsx`, `src/app/AppShell.tsx`, `src/theme/app.css`, `src/app/TabList.test.tsx`, `src/app/AppShell.test.tsx`.

- [x] Change TabList tests to require horizontal Left/Right navigation while retaining Home/End, dirty/conflict status, close, and context menus.
- [x] Render tabs in a dedicated `.document-tabs-bar` below the titlebar; remove the vertical tab section from the sidebar without changing session preference compatibility.
- [x] Preserve the existing `document-tab-*` IDs and `document-panel-*` ARIA relationship. Use horizontal ARIA keyboard behavior and a scrollable strip for overflow.

```css
.document-tabs-bar { display: flex; min-height: 42px; border-bottom: 1px solid var(--divider); }
.document-tabs-bar .tab-list { display: flex; min-width: 0; overflow-x: auto; }
```

- [x] Run TabList and AppShell tests.

### Task 3: Search UI and result navigation

**Files:**
- Create `src/app/WorkspaceSearch.tsx`, `src/app/WorkspaceSearch.test.tsx`, `src/editor/searchNavigation.ts`, `src/editor/searchNavigation.test.ts`.
- Modify `src/app/AppShell.tsx`, `src/editor/MarkdownEditor.tsx`, `src/editor/MarkdownEditor.test.tsx`.

- [x] Write failing component tests for disabled/no-workspace state, 250 ms debounce, submit, loading/error/empty/truncated states, stale response rejection, Escape, ArrowUp/ArrowDown, Enter, and click.
- [x] Implement `WorkspaceSearch` with `port`, `workspace`, and `onOpenResult` props. Use a request sequence ref and the port contract; no filesystem access in the component.
- [x] Implement a pure line-target helper.

```ts
export const searchMatchOffset = (
  text: string,
  line: number,
  column: number,
): number | null => {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 0) return null;
  const lines = text.split("\n");
  const target = lines[line - 1];
  if (target === undefined) return null;
  const prefix = lines.slice(0, line - 1).reduce((sum, entry) => sum + entry.length + 1, 0);
  return prefix + Math.min(column, [...target].length);
};
```

- [x] Add an optional `searchNavigation` request prop to MarkdownEditor. On a new sequence, focus the view and dispatch a selection-only transaction with `Transaction.addToHistory.of(false)`; never change text. Re-locate against the current text and clamp a stale column safely.
- [x] Run search/editor/AppShell tests.

### Task 4: Explorer and welcome states

**Files:**
- Modify `src/workspace/FileSidebar.tsx`, `src/app/AppShell.tsx`, `src/theme/app.css`, `src/workspace/FileSidebar.test.tsx`, `src/app/AppShell.test.tsx`.

- [x] Write tests proving the explorer and open-folder action exist with no workspace/no tabs, and that non-Markdown files remain absent.
- [x] Keep the sidebar present in the empty state. Add an empty explorer with 未打开文件夹 and 打开文件夹; retain the existing tree when a workspace exists.
- [x] Replace the editor empty hero with a Markdown-focused welcome area containing 新建文档/打开文件/打开文件夹 and shortcut hints, without a brand mark or recent-item list.
- [x] Use existing tokens, flat surfaces, native controls, reduced-motion behavior, and accessible labels. Do not add Git, repository cloning, Activity Bar, or a status bar.
- [x] Run component tests and `npm run build`.

### Task 5: End-to-end and documentation

**Files:**
- Create `tests/e2e/workspaceSearch.spec.ts`.
- Modify `AGENTS.md`, `docs/testing.md`, `README.md` if the documented shell changes.

- [x] Add a browser E2E using the memory port: open an empty shell, open a fixture workspace, search a phrase, activate a result, verify the open tab/caret, and confirm current-document `Cmd+F` still works.
- [x] Update module/command/testing documentation for search and the new shell.
- [x] Run `npm run check`, both Rust clippy variants, and `npm run test:e2e`.
- [x] Capture empty and populated views in dark/light themes; verify no overlap at minimum window width and no new motion under reduced motion.
- [x] Do not commit unless the user explicitly asks; report any unrelated pre-existing failures separately.
