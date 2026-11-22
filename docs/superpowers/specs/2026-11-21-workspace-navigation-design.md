# Workspace Navigation and Search Design

Date: 2026-11-21

## Scope

Rework Opus's shell around a document-workspace model inspired by VS Code while
keeping the product focused on Markdown rather than developer tooling:

- A persistent left explorer shows the workspace tree or an open-folder entry.
- Open documents move from the vertical sidebar into horizontal tabs above the
  editor.
- The follow-up unified top bar removes the global search entry; the bounded
  search backend remains available through `DocumentPort`.
- The empty editor becomes a Markdown-focused welcome page with new/open actions,
  shortcuts, and recent items.

## Decisions

### Layout

The titlebar retains native window controls, the file menu, sidebar toggle, and
document actions, with the workspace search field centered inside it. A separate
editor-column tab strip appears only when documents are open; there is no extra
empty row on the welcome page. It never spans the activity rail or explorer. The
selected file tab shares the editor canvas and connects through inverse radial
shoulders on both sides, without an accent underline or hover wash. Hover/focus
reveals the close button; only the last tab has a spring-loaded create action
that pops out to its right. Blank top-bar regions invoke native window dragging. The
left sidebar no longer contains the vertical tab list. It
keeps its existing width, collapse, keyboard resizing, file tree, and a
left-aligned settings entry. With no workspace, it explains that no folder is
open and offers 打开文件夹; it does not invent developer-oriented repository or
Git UI.

The existing right outline remains unchanged. The welcome page centers 新建文档,
打开文件, and 打开文件夹 with keyboard hints and additional space above the
command group. It has no brand mark or recent-file/folder list. Opening content
replaces the welcome page without resetting the workspace.

### Workspace search

Search is available when a workspace is open. The input is disabled with an
explanatory placeholder otherwise. Queries are trimmed, case-insensitive, and
matched line-by-line against `.md`/`.markdown` files under the canonical opened
workspace. Hidden entries and symlinks escaping the workspace are excluded.

The backend returns bounded matches with path, 1-based line number, column, line
text, and match length. A query can scan at most a bounded number of files/bytes
and return at most 200 matches; the response reports truncation. Searching is
triggered on submit and after a short debounce. A monotonically increasing query
sequence prevents stale responses from replacing newer results. Closing or
changing the workspace invalidates pending results.

Results appear in a keyboard-accessible popover grouped by file. Each result shows
the relative file path, line number, and matching line. Enter/click opens the file
and moves the editor caret to the match without modifying text or undo history.
Escape closes the popover and returns focus to the search field. Loading, empty,
error, and truncated states are explicit.

This iteration searches saved on-disk content, not unsaved editor buffers. The
current-document `Cmd+F` search remains independent and unchanged.

### Compatibility and safety

All filesystem access remains behind `DocumentPort`; the memory port implements
the same search contract for tests/demo/E2E. The Rust command requires the current
workspace anchor. Search does not write files, create an index, or persist query
history. File opening, conflict handling, recovery, and saving retain their
current behavior.

The implementation uses existing design tokens and motion rules. It adds no
Activity Bar, Git/repository controls, developer-project actions, cloud account,
or status bar. No new dependency is introduced.

## Assumptions

- 全文搜索 means saved Markdown content in the currently opened folder, not a
  cross-workspace global index.
- Both `.md` and `.markdown` remain supported because the existing product opens
  both; other file formats stay hidden.
- The top search is for workspace content; current-document search stays on
  `Cmd+F`.
- The redesign applies to both empty and populated states, on all supported
  desktop platforms, with Chinese UI text.

## Verification

- Rust unit/integration tests cover matching, hidden/non-Markdown exclusion,
  root boundaries, invalid UTF-8, and result limits.
- Port tests cover DTO mapping and memory-port behavior.
- Frontend tests cover horizontal tab keyboard behavior, search debounce/stale
  responses, loading/error/empty states, keyboard navigation, and line targeting.
- Browser E2E covers opening the empty shell, opening a workspace, searching
  content, opening a result, and preserving the current-document search.
- Run `npm run check`, Rust fmt/clippy (including native-e2e), `npm run test:e2e`,
  and capture the empty/populated UI in both themes. The already-documented
  reading-mode mouse-selection E2E race is not part of this redesign.
