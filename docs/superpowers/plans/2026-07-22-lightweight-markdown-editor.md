# Lightweight Markdown Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight macOS Markdown editor that opens arbitrary files, supports multiple tabs and an optional folder drawer, and renders Markdown and LaTeX inline without changing the underlying plain text.

**Architecture:** A React/TypeScript UI hosts a CodeMirror 6 editor and talks through a narrow `DocumentPort` to Tauri commands. Rust owns file I/O, encoding/newline preservation, directory access, watching, and recovery; the web layer owns tabs, editor state, Lezer decorations, KaTeX widgets, and Baseline-inspired presentation. All platform access stays behind ports so the same frontend can run in Vitest/Playwright with an in-memory adapter.

**Tech Stack:** Tauri 2, Rust stable, React, TypeScript, Vite, CodeMirror 6, `@codemirror/lang-markdown`, `@lezer/markdown`, KaTeX, Vitest, Testing Library, Playwright, `cargo test`.

---

## Scope and delivery order

This plan is one vertical MVP rather than separate frontend/backend projects. Each task leaves the application runnable. Tasks 1–5 produce a plain Markdown notepad; Tasks 6–8 add live rendering, LaTeX, search, and images; Tasks 9–10 add the optional folder workflow and reliability; Tasks 11–13 finish visual polish, performance, packaging, and acceptance.

## File map

### Project and quality configuration

- `package.json`: npm scripts and pinned JavaScript dependencies.
- `package-lock.json`: reproducible JavaScript dependency graph.
- `tsconfig.json`, `vite.config.ts`: TypeScript/Vite configuration.
- `vitest.setup.ts`: DOM test setup and browser API shims.
- `playwright.config.ts`: web-shell end-to-end configuration.
- `.github/workflows/ci.yml`: frontend and Rust checks.

### Frontend

- `src/main.tsx`: React entry point.
- `src/app/App.tsx`: composition root; no file-system logic.
- `src/app/AppShell.tsx`: titlebar, tab strip, sidebar slot, editor slot, dialogs.
- `src/app/useAppController.ts`: coordinates document port events with the document store.
- `src/document/types.ts`: document, encoding, newline, conflict, and recovery types.
- `src/document/documentReducer.ts`: pure tab/session state transitions.
- `src/document/DocumentPort.ts`: platform boundary used by the UI.
- `src/document/tauriDocumentPort.ts`: production adapter using Tauri `invoke`/events.
- `src/document/memoryDocumentPort.ts`: deterministic test adapter.
- `src/editor/MarkdownEditor.tsx`: CodeMirror lifecycle and document synchronization.
- `src/editor/editorExtensions.ts`: base keymaps, history, wrapping, search, and language configuration.
- `src/editor/livePreview.ts`: selection-aware Markdown decorations.
- `src/editor/mathExtension.ts`: Lezer `$...$`/`$$...$$` nodes.
- `src/editor/mathWidgets.ts`: KaTeX widgets and error fallback.
- `src/editor/imagePaste.ts`: clipboard bitmap and dropped-image behavior.
- `src/editor/imageWidgets.ts`: safe local/network image preview widgets.
- `src/workspace/FileSidebar.tsx`: lazy tree and filename filter.
- `src/workspace/treeReducer.ts`: pure lazy-tree state.
- `src/recovery/RecoveryDialog.tsx`: recovered-draft choice.
- `src/conflict/ConflictDialog.tsx`: disk/local conflict choice.
- `src/theme/tokens.css`: Baseline-inspired color, type, radius, and motion tokens.
- `src/theme/app.css`: shell/editor layout.
- `src/theme/useTheme.ts`: system/light/dark selection.
- `src/theme/preferences.ts`: persisted body font, size, line height, and width.

### Tauri/Rust

- `src-tauri/src/lib.rs`: plugin registration, command registration, app events.
- `src-tauri/src/main.rs`: desktop entry point only.
- `src-tauri/src/document_io.rs`: read, atomic write, BOM/newline handling.
- `src-tauri/src/document_commands.rs`: validated Tauri command DTOs.
- `src-tauri/src/open_events.rs`: Finder/file-association and drag/drop path normalization.
- `src-tauri/src/workspace.rs`: lazy directory listing and file operations.
- `src-tauri/src/watch.rs`: per-open-document file watcher and normalized events.
- `src-tauri/src/recovery.rs`: draft persistence and cleanup.
- `src-tauri/capabilities/default.json`: minimal Tauri permissions.
- `src-tauri/tauri.conf.json`: window and bundle configuration.

### Tests and fixtures

- `src/**/*.test.ts(x)`: colocated unit/component tests.
- `src-tauri/tests/document_io.rs`: black-box file behavior.
- `src-tauri/tests/workspace.rs`: directory boundaries and lazy listing.
- `tests/e2e/notepad.spec.ts`: browser-shell user flows with the memory port.
- `tests/fixtures/markdown/*.md`: Chinese/English, GFM, LaTeX, CRLF/BOM fixtures.
- `scripts/generate-perf-fixtures.mjs`: deterministic 1/2/10 MiB documents.
- `scripts/measure-editor.mjs`: Playwright performance measurements.
- `docs/testing.md`: exact automated and macOS manual acceptance procedure.

### Boundary rules

- React components never import `@tauri-apps/api/core` directly; only `tauriDocumentPort.ts` may invoke Tauri.
- Rust command handlers contain validation and DTO conversion only; reusable behavior lives in plain Rust modules with unit/integration tests.
- CodeMirror owns the canonical text while a tab is mounted. The reducer stores snapshots for inactive tabs and persistence, never rendered HTML.
- `livePreview.ts` reads the `@lezer/markdown` tree used by CodeMirror; no second Markdown parser is added.

---

### Task 1: Bootstrap the Tauri/React project and test gates

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.setup.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/App.test.tsx`
- Create via Tauri CLI, then modify: `src-tauri/**`
- Create: `.github/workflows/ci.yml`
- Modify: `.gitignore`

- [ ] **Step 1: Create the package manifest and install the locked toolchain**

Create `package.json` with these scripts before installing:

```json
{
  "name": "markdown-edit",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 1420",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "tauri": "tauri",
    "check": "npm run test && npm run build && cargo test --manifest-path src-tauri/Cargo.toml"
  }
}
```

Run:

```bash
npm install react react-dom @tauri-apps/api @tauri-apps/plugin-dialog @tauri-apps/plugin-fs @tauri-apps/plugin-opener @tauri-apps/plugin-store @codemirror/state @codemirror/view @codemirror/commands @codemirror/search @codemirror/language @codemirror/lang-markdown @codemirror/language-data @lezer/common @lezer/markdown katex
npm install -D typescript vite @vitejs/plugin-react @tauri-apps/cli vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @types/react @types/react-dom @types/katex playwright @playwright/test
```

Expected: `package-lock.json` is created and `npm ls --depth=0` exits 0. Do not hand-edit resolved versions; commit the lockfile.

- [ ] **Step 2: Initialize Tauri 2 with fixed application identifiers**

Run:

```bash
npx tauri init --ci --app-name "Markdown Edit" --window-title "Markdown Edit" --frontend-dist ../dist --dev-url http://localhost:1420 --before-dev-command "npm run dev" --before-build-command "npm run build"
```

Set in `src-tauri/tauri.conf.json`:

```json
{
  "productName": "Markdown Edit",
  "version": "0.1.0",
  "identifier": "com.xiongweini.markdown-edit",
  "app": {
    "windows": [{ "title": "Markdown Edit", "width": 1080, "height": 760, "minWidth": 680, "minHeight": 480 }],
    "security": { "csp": "default-src 'self'; img-src 'self' asset: http: https: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:" }
  },
  "bundle": { "active": true, "targets": ["app", "dmg"], "macOS": { "minimumSystemVersion": "12.0" } }
}
```

Expected: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, and `src-tauri/src/main.rs` exist.

Add the supported Tauri plugins through the CLI so JavaScript packages, Rust crates, initialization, and permissions remain version-synchronized:

```bash
npm run tauri add dialog
npm run tauri add fs
npm run tauri add opener
npm run tauri add store
```

Extend `.gitignore` with `/node_modules/`, `/dist/`, `/src-tauri/target/`, `/tests/perf/generated/`, and Playwright output directories.

- [ ] **Step 3: Write the failing shell smoke test**

Create `src/app/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("offers file and folder entry points", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "打开文件" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开文件夹" })).toBeVisible();
  });
});
```

- [ ] **Step 4: Run the test and verify the red state**

Run: `npm test -- src/app/App.test.tsx`

Expected: FAIL because `App` or its buttons do not exist.

- [ ] **Step 5: Add the minimal React/Vite shell and test configuration**

Create `src/app/App.tsx`:

```tsx
export function App() {
  return <main><button>打开文件</button><button>打开文件夹</button></main>;
}
```

Configure Vitest in `vite.config.ts` with `environment: "jsdom"`, `setupFiles: "./vitest.setup.ts"`, and `restoreMocks: true`. Import `@testing-library/jest-dom/vitest` from `vitest.setup.ts`.

- [ ] **Step 6: Run all bootstrap gates**

Run:

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all three commands exit 0.

- [ ] **Step 7: Add CI and commit**

Create `.github/workflows/ci.yml` with macOS jobs that run `npm ci`, `npm test`, `npm run build`, `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test`.

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.setup.ts index.html src src-tauri .github/workflows/ci.yml .gitignore
git commit -m "build: bootstrap Tauri markdown editor"
```

---

### Task 2: Implement lossless document I/O in Rust

**Files:**
- Create: `src-tauri/src/document_io.rs`
- Create: `src-tauri/tests/document_io.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing tests for BOM, newline detection, and writes**

Create black-box tests covering these exact cases:

```rust
#[test]
fn reads_utf8_bom_and_crlf_without_normalizing_text() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    std::fs::write(&path, b"\xEF\xBB\xBF# A\r\nB\r\n").unwrap();
    let opened = markdown_edit_lib::document_io::read_document(&path).unwrap();
    assert_eq!(opened.text, "# A\r\nB\r\n");
    assert!(opened.has_utf8_bom);
    assert_eq!(opened.newline, Newline::CrLf);
}

#[test]
fn write_preserves_requested_bom_and_newlines() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.md");
    write_document(&path, "a\nb\n", true, Newline::CrLf).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), b"\xEF\xBB\xBFa\r\nb\r\n");
}
```

Add `tempfile` as a dev dependency.

- [ ] **Step 2: Run the Rust test and verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --test document_io`

Expected: FAIL because `document_io` and its types are missing.

- [ ] **Step 3: Implement the focused I/O API**

Define:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Newline { Lf, CrLf }

#[derive(Debug, PartialEq, Eq)]
pub struct OpenedDocument {
    pub text: String,
    pub has_utf8_bom: bool,
    pub newline: Newline,
    pub modified_unix_ms: u128,
}

pub fn read_document(path: &Path) -> Result<OpenedDocument, DocumentIoError>;
pub fn write_document(path: &Path, text: &str, bom: bool, newline: Newline) -> Result<u128, DocumentIoError>;
```

Reject invalid UTF-8 without writing. Normalize the editor's `\n` text to the requested newline only during write. Write to a sibling temporary file, `sync_all`, preserve existing permissions, then rename over the destination.

- [ ] **Step 4: Add failure and symlink tests**

Add cases for invalid UTF-8, missing parent, read-only target, and a symlink path. The symlink case must write through to the target rather than replace the symlink.

**Deferred cross-platform and release hardening:** a later release-quality task must define and test preservation/handling of ACLs, extended attributes (including Finder tags), owner/group metadata, and platform-specific file semantics. It must run the relevant document-I/O tests on Windows and Linux as well as macOS. These are intentionally not added to Task 2's focused portable core.

- [ ] **Step 5: Run checks and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml document_io`

Expected: PASS.

```bash
git add src-tauri/src/document_io.rs src-tauri/tests/document_io.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat: add lossless markdown file IO"
```

---

### Task 3: Define the platform port and pure multi-tab document state

**Files:**
- Create: `src/document/types.ts`
- Create: `src/document/DocumentPort.ts`
- Create: `src/document/documentReducer.ts`
- Create: `src/document/documentReducer.test.ts`
- Create: `src/document/memoryDocumentPort.ts`

- [ ] **Step 1: Define stable cross-boundary types**

```ts
export type Newline = "lf" | "cr_lf";
export interface DocumentSnapshot {
  id: string; path: string | null; title: string; text: string;
  savedText: string; hasUtf8Bom: boolean; newline: Newline;
  modifiedUnixMs: number | null; version: string | null;
  status: "clean" | "dirty" | "conflict" | "missing";
  pendingSave?: {
    requestId: string; targetPath: string; writtenText: string;
    previousVersion: string | null;
  };
}
export interface ClosedTab {
  document: DocumentSnapshot;
  closedIndex: number;
}
export interface DocumentState {
  tabs: DocumentSnapshot[];
  activeId: string | null;
  recentlyClosed: ClosedTab[];
}
export interface OpenedFile {
  path: string; text: string; hasUtf8Bom: boolean;
  newline: Newline; modifiedUnixMs: number; version: string;
}
export class DocumentPortError extends Error {
  constructor(public readonly code: "invalid_utf8" | "permission_denied" | "not_found" | "conflict" | "io", message: string) {
    super(message);
  }
}
export interface DocumentPort {
  chooseAndOpenFiles(): Promise<OpenedFile[]>;
  openPath(path: string): Promise<OpenedFile>;
  chooseSavePath(suggestedName: string): Promise<string | null>;
  save(doc: DocumentSnapshot): Promise<{ path: string; modifiedUnixMs: number; version: string }>;
  saveToPath(path: string, doc: DocumentSnapshot, expectedVersion: string | null): Promise<{ path: string; modifiedUnixMs: number; version: string }>;
}
```

`modifiedUnixMs` is display/prompt metadata only; it is not a collision-free document version and must not be used to suppress watcher events or prove that a save is current. Reserve the opaque `version: string` field now so later native implementations can change its representation without changing the frontend contract.

- [ ] **Step 2: Write reducer tests before implementation**

Tests must prove: new untitled tab, open file, global ID and path de-duplication, edit marks dirty, successful save marks clean, close selects neighbor, external conflict never discards local text, closing records a de-duplicated maximum-20-entry recently-closed stack, and reopening restores the most recently closed tab at its previous index. Add save-race coverage proving the reducer records the exact text and previous opaque version captured by `saveStarted`, ignores stale request IDs, and remains dirty when edits happen while a write is in flight. Add root-aware lexical path tests for POSIX, Windows drive-absolute/drive-relative/rooted/UNC/device forms, and empty relative paths.

```ts
it("focuses an existing path instead of duplicating it", () => {
  const once = documentReducer(initialDocumentState, { type: "opened", file });
  const twice = documentReducer(once, { type: "opened", file });
  expect(twice.tabs).toHaveLength(1);
  expect(twice.activeId).toBe(twice.tabs[0].id);
});

it("reopens the most recently closed tab", () => {
  const closed = documentReducer(twoTabState, { type: "closeConfirmed", id: "b", disposition: "saved" });
  const reopened = documentReducer(closed, { type: "reopenLastClosed" });
  expect(reopened.tabs.map(tab => tab.id)).toEqual(["a", "b"]);
  expect(reopened.activeId).toBe("b");
  expect(reopened.recentlyClosed).toHaveLength(0);
});
```

- [ ] **Step 3: Run the reducer tests red**

Run: `npm test -- src/document/documentReducer.test.ts`

Expected: FAIL because `documentReducer` is missing.

- [ ] **Step 4: Implement a discriminated-union reducer**

Export `DocumentState`, `DocumentAction`, `initialDocumentState`, and `documentReducer`. `DocumentAction` includes `saveStarted` with `requestId`, `targetPath`, `writtenText`, and `previousVersion`; `saveSucceeded` repeats the request ID and is accepted only for the latest pending request. It also includes `{ type: "closeConfirmed"; id; disposition: "saved" | "discarded" }` and `{ type: "reopenLastClosed" }`. A successful save records the pending request's `writtenText`, not the buffer at callback time; edits made in flight remain dirty. A result path differing from the request target or colliding with another tab fails closed. A discarded dirty tab records `savedText` rather than the discarded edits; a discarded untitled tab records an empty clean snapshot. Cap `recentlyClosed` at 20, de-duplicate it by normalized path (or ID for pathless tabs), keep IDs globally stable, clone snapshots when moving between collections, and compare normalized paths before adding or reopening a tab. If the path or ID is already open, reopening focuses the existing tab and removes the stack entry. No Tauri or React imports are allowed in this file.

- [ ] **Step 5: Add an in-memory port for tests and Storybook-free demos**

`MemoryDocumentPort` accepts a `Map<string, OpenedFile>`, records writes, and implements cancelable `chooseSavePath` separately from `saveToPath`. `save` compares the document's opaque version with the current same-path version. `saveToPath` requires `expectedVersion: null` for a missing target and the exact target version for overwrite; mismatch throws `DocumentPortError("conflict", ...)` without recording or replacing bytes. It must clone inputs, records, and returned values so tests cannot mutate its backing store accidentally.

- [ ] **Step 6: Run tests and commit**

Run: `npm test -- src/document`

Expected: PASS.

```bash
git add src/document
git commit -m "feat: model multi-tab document state"
```

---

### Task 4: Expose validated Tauri document commands

**Files:**
- Create: `src-tauri/src/document_commands.rs`
- Create: `src-tauri/src/open_events.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/document/tauriDocumentPort.ts`
- Create: `src/document/tauriDocumentPort.test.ts`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Write adapter contract tests with mocked `invoke`**

Verify that `openPath` invokes `open_document` with `{ path }`, maps Rust snake_case fields, and converts structured `invalid_utf8` and `conflict` errors into typed `DocumentPortError` values. Verify that `chooseSavePath` only selects or cancels a path and performs no write; `saveToPath` invokes the save command only after the caller has checked normalized open-tab collisions and supplies the expected target version.

- [ ] **Step 2: Run the adapter test red**

Run: `npm test -- src/document/tauriDocumentPort.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement Rust DTO commands**

Expose only:

```rust
#[tauri::command]
pub fn open_document(path: PathBuf) -> Result<OpenedDocumentDto, CommandError>;

#[tauri::command]
pub fn save_document(request: SaveDocumentRequest) -> Result<SavedDocumentDto, CommandError>;
```

`OpenedDocumentDto` and `SavedDocumentDto` must return both `modified_unix_ms` for display and an opaque `version` for concurrency/watch matching. `SaveDocumentRequest` carries the version observed by the caller so the command can reject a stale save before replacing bytes.

Validate that the path is absolute and the opened target is a regular file or symlink to one. Register commands with `tauri::generate_handler!` and keep shell execution unavailable.

Add `.md` and `.markdown` file associations in `tauri.conf.json`. In `open_events.rs`, normalize the initial process arguments and macOS `RunEvent::Opened` URLs into absolute paths and emit one `open-paths` event to the frontend. Unit-test percent-encoded spaces, duplicate paths, unsupported schemes, and non-Markdown paths.

- [ ] **Step 4: Implement the production port**

Use `@tauri-apps/plugin-dialog` only for `chooseAndOpenFiles`/`chooseSavePath`; use the Rust commands for bytes and metadata. `chooseSavePath` must not write. Normalize cancel to an empty array or `null`, never an exception. Implement `saveToPath` as a separate version-checked command call.

Subscribe once to `open-paths` and Tauri window drag/drop events. File drops call `openPath`; directory drops call the workspace chooser path added in Task 9. Queue early events until the React controller reports ready so Finder launches cannot lose their first file.

- [ ] **Step 5: Verify both sides and commit**

Run:

```bash
npm test -- src/document/tauriDocumentPort.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

```bash
git add src/document src-tauri
git commit -m "feat: connect document IO to Tauri"
```

---

### Task 5: Build the notepad shell, tabs, open, save, and close prompts

**Files:**
- Create: `src/app/AppShell.tsx`
- Create: `src/app/useAppController.ts`
- Create: `src/app/AppShell.test.tsx`
- Modify: `src/app/App.tsx`
- Create: `src/editor/MarkdownEditor.tsx`
- Create: `src/editor/editorExtensions.ts`
- Create: `src/editor/MarkdownEditor.test.tsx`

- [ ] **Step 1: Write component tests for the basic notepad workflow**

Use `MemoryDocumentPort` to test: empty state buttons; opening two files creates two tabs; editing adds the dirty dot; `⌘S` dispatches `saveStarted` with an immutable write snapshot before calling `save`; closing dirty tab shows 保存/放弃/取消; opening the same path focuses its tab; closing a clean tab then pressing `⌘⇧T` restores and focuses it; `⌘⇧T` with an empty stack is a no-op. For untitled/Save As flows, call `chooseSavePath`, normalize-check the selected path against open tabs before any write, obtain the expected target version when overwrite was explicitly confirmed, then call `saveToPath`. Keep the reducer's result-path collision guard as defense in depth.

- [ ] **Step 2: Run tests red**

Run: `npm test -- src/app src/editor`

Expected: FAIL because shell/controller/editor are absent.

- [ ] **Step 3: Implement `MarkdownEditor` as a controlled CodeMirror host**

The component API is fixed:

```ts
export interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  onSave(): void;
  onReopenClosed(): void;
  sourceMode: boolean;
  documentPath: string | null;
}
```

Create one `EditorView` on mount, dispatch external changes without adding them to history, and destroy the view on unmount. Configure the language with `markdown({ codeLanguages: languages, extensions: [GFM] })`, so fenced code blocks use CodeMirror language descriptions without adding another Markdown parser. Add history, default/highlight/special-char keymaps, line wrapping, `markdownKeymap`, and custom `Mod-s` plus `Mod-Shift-t` bindings.

Use this keymap order so Markdown structural commands receive Enter before the generic newline command:

```ts
keymap.of([
  { key: "Mod-s", preventDefault: true, run: () => { onSave(); return true; } },
  { key: "Mod-Shift-t", preventDefault: true, run: () => { onReopenClosed(); return true; } },
  ...markdownKeymap,
  ...defaultKeymap,
  ...historyKeymap,
  ...searchKeymap,
]);
```

Add editor tests that place the cursor after `- item` and `> quote`, press Enter, and assert the raw document becomes `- item\n- ` and `> quote\n> `. Also verify Enter on an empty list item exits the list according to `markdownKeymap` behavior.

- [ ] **Step 4: Implement the controller and shell**

`useAppController(port)` owns the reducer, async open/save operations, close-confirm state, and `reopenClosed()`. `AppShell` renders titlebar, tab strip, active editor, empty state, and accessible modal dialogs. Bind `⌘⇧T` at the shell when focus is outside CodeMirror and through the editor keymap when focus is inside it, with one event handled only once. Keep the sidebar slot collapsed.

- [ ] **Step 5: Run tests and a local desktop smoke test**

Run:

```bash
npm test -- src/app src/editor
npm run tauri dev
```

Expected: tests PASS; the desktop app opens a real Markdown file, edits it, saves it, and warns before discarding changes.

- [ ] **Step 6: Commit**

```bash
git add src/app src/editor src/main.tsx
git commit -m "feat: add lightweight tabbed notepad shell"
```

---

### Task 6: Add selection-aware Markdown live preview

**Files:**
- Create: `src/editor/livePreview.ts`
- Create: `src/editor/livePreview.test.ts`
- Modify: `src/editor/editorExtensions.ts`
- Modify: `src/editor/MarkdownEditor.tsx`

- [ ] **Step 1: Write decoration-range tests against real syntax trees**

Test headings, emphasis, strong, strike, blockquote, list markers, fenced code, links, horizontal rules, and a selection crossing two nodes. Assert marker replacement only occurs when neither cursor nor selection intersects the syntax node.

```ts
function createMarkdownState(doc: string, selection: EditorSelection) {
  return EditorState.create({
    doc,
    selection,
    extensions: [markdown({ extensions: [GFM] })],
  });
}

it("reveals emphasis marks when the cursor enters the node", () => {
  const hidden = planLivePreview(createMarkdownState("hello **world**", EditorSelection.cursor(0)));
  expect(hidden).toContainEqual(expect.objectContaining({ from: 6, to: 8, kind: "hide" }));
  const revealed = planLivePreview(createMarkdownState("hello **world**", EditorSelection.cursor(10)));
  expect(revealed.some(r => r.from === 6 && r.kind === "hide")).toBe(false);
});
```

- [ ] **Step 2: Run tests red**

Run: `npm test -- src/editor/livePreview.test.ts`

Expected: FAIL because `rangesFor` is missing.

- [ ] **Step 3: Implement pure range planning, then the ViewPlugin**

Split logic into `planLivePreview(state): PlannedDecoration[]` and `livePreviewExtension(): Extension`. Iterate `syntaxTree(state)`; use mark decorations for headings/code and replace decorations only for syntax delimiters. Recompute on `docChanged`, `selectionSet`, `viewportChanged`, or `syntaxTree(update.startState) !== syntaxTree(update.state)`.

- [ ] **Step 4: Add source-mode compensation**

Use a `Compartment` so source mode removes live-preview decorations without recreating the editor or losing undo history.

- [ ] **Step 5: Verify behavior and commit**

Run: `npm test -- src/editor`

Manually verify mouse selection, IME composition with Chinese text, copy/paste, undo, and switching source mode.

```bash
git add src/editor
git commit -m "feat: render Markdown syntax inline"
```

---

### Task 7: Parse and render inline/block LaTeX with KaTeX

**Files:**
- Create: `src/editor/mathExtension.ts`
- Create: `src/editor/mathExtension.test.ts`
- Create: `src/editor/mathWidgets.ts`
- Create: `src/editor/mathWidgets.test.tsx`
- Modify: `src/editor/editorExtensions.ts`
- Modify: `src/theme/app.css`

- [ ] **Step 1: Write parser tests for math boundaries**

Cover `$x^2$`, `$$\nE=mc^2\n$$`, escaped `\$`, empty delimiters, unclosed delimiters, code spans containing `$`, and adjacent currency text. Unclosed math must remain ordinary text.

- [ ] **Step 2: Run parser tests red**

Run: `npm test -- src/editor/mathExtension.test.ts`

Expected: FAIL because the extension is missing.

- [ ] **Step 3: Implement Lezer Markdown extensions**

Export `InlineMath`, `BlockMath`, and `mathMarkdownExtension`. Inline math starts and ends on unescaped `$` without newline; block math uses a line containing only optional whitespace plus `$$`. Configure the same extension through `markdown({ extensions: [GFM, mathMarkdownExtension] })`.

- [ ] **Step 4: Write failing widget tests**

Assert valid KaTeX creates `.md-math`, invalid KaTeX creates `.md-math-error` containing the source, and selecting a math node reveals `$`/`$$` source instead of mounting a widget.

- [ ] **Step 5: Implement widgets and test**

Use `katex.renderToString(source, { throwOnError: true, displayMode })`; set output with a tightly scoped widget DOM node. Never render user-provided HTML outside KaTeX's output.

Run: `npm test -- src/editor/mathExtension.test.ts src/editor/mathWidgets.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/editor src/theme/app.css
git commit -m "feat: render LaTeX formulas inline"
```

---

### Task 8: Add current-document search and explicit image insertion

**Files:**
- Modify: `src/editor/editorExtensions.ts`
- Create: `src/editor/search.test.tsx`
- Create: `src/editor/imagePaste.ts`
- Create: `src/editor/imagePaste.test.ts`
- Create: `src/editor/imageWidgets.ts`
- Create: `src/editor/imageWidgets.test.ts`
- Modify: `src/document/DocumentPort.ts`
- Modify: `src/document/tauriDocumentPort.ts`
- Modify: `src/document/memoryDocumentPort.ts`
- Modify: `src-tauri/src/document_commands.rs`
- Create: `src-tauri/src/asset_scope.rs`
- Create: `src-tauri/tests/asset_scope.rs`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add failing search-panel tests**

Test `Mod-f`, `Mod-Alt-f`, case-sensitive, whole-word, regexp, replace-one, and replace-all against hidden Markdown markers. Verify switching tabs gives the search panel the new active document only.

- [ ] **Step 2: Configure and skin CodeMirror search**

Use `search({ top: true })` and `searchKeymap`; add a custom `Mod-Alt-f` binding that opens the panel and focuses its replace field. Do not create cross-document indexes.

- [ ] **Step 3: Extend the port for clipboard bitmap saving**

Add:

```ts
saveClipboardImage(input: {
  bytes: Uint8Array; mimeType: "image/png" | "image/jpeg";
  documentPath: string | null;
}): Promise<string | null>;
```

The production adapter opens a save dialog for every paste, defaults to the document directory and `image-YYYYMMDD-HHmmss.ext`, writes only after confirmation, and returns the inserted relative/absolute path. Cancel returns `null`.

- [ ] **Step 4: Write image tests red, implement the transaction filter, then rerun**

Tests cover PNG clipboard paste, cancel, unsaved document, and dropping an existing image file without copying it. Insert Markdown as `![image](escaped-path)` in one undoable transaction.

Add image-widget tests for relative, absolute, `https:`, missing, and non-image URLs. Resolve relative paths from the active document directory; use Tauri `convertFileSrc` for local previews and ordinary `https:` URLs for network images. Mount widgets only near the visible ranges, reveal Markdown source when selected, show alt text plus a broken-image indicator on load failure, and never execute `javascript:` or arbitrary HTML URLs.

Extract a reference-counted `AssetScopeRegistry` in Rust. Before wiring it to Tauri, add integration tests with temporary directories proving: opening a document allows only its parent directory; two tabs in the same parent require two releases before removal; closing the last consumer removes access; a workspace grants recursive access only inside its root; `..` and symlink escapes are rejected; no static home-directory or whole-filesystem glob exists in `default.json`. Then wire registry acquire/release calls to Tauri's asset-protocol scope and the tab/workspace lifecycle.

```rust
#[test]
fn shared_parent_scope_is_removed_only_after_last_tab_closes() {
    let mut scopes = AssetScopeRegistry::default();
    scopes.acquire_document("tab-a", "/notes/a.md").unwrap();
    scopes.acquire_document("tab-b", "/notes/b.md").unwrap();
    scopes.release_consumer("tab-a").unwrap();
    assert!(scopes.allows(Path::new("/notes/image.png")));
    scopes.release_consumer("tab-b").unwrap();
    assert!(!scopes.allows(Path::new("/notes/image.png")));
}
```

Add `acquire_document_scope(consumer_id, path)`, `acquire_workspace_scope(consumer_id, root)`, and `release_asset_scope(consumer_id)` Tauri commands. The controller acquires only after the reducer accepts a genuinely new tab/workspace, so duplicate-path focus cannot leak a reference; it releases that stable consumer ID on close. Adapter tests assert acquire/release calls are issued exactly once and that releasing one of two consumers sharing a parent does not remove the other consumer's access.

Run: `npm test -- src/editor/search.test.tsx src/editor/imagePaste.test.ts src/editor/imageWidgets.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/editor src/document src-tauri/src/asset_scope.rs src-tauri/tests/asset_scope.rs src-tauri/src/document_commands.rs src-tauri/capabilities/default.json
git commit -m "feat: add search replace and image insertion"
```

---

### Task 9: Add the optional lazy folder sidebar

**Files:**
- Create: `src-tauri/src/workspace.rs`
- Create: `src-tauri/tests/workspace.rs`
- Create: `src/workspace/treeReducer.ts`
- Create: `src/workspace/treeReducer.test.ts`
- Create: `src/workspace/FileSidebar.tsx`
- Create: `src/workspace/FileSidebar.test.tsx`
- Modify: `src/document/DocumentPort.ts`
- Modify: `src/app/AppShell.tsx`

- [ ] **Step 1: Write Rust directory-boundary tests**

Test top-level lazy listing, directories-before-files sorting, `.md`/`.markdown` filtering, hidden-file behavior, symlink loops, create, rename, and delete. Reject operations whose canonical target escapes the opened root.

- [ ] **Step 2: Implement workspace commands**

Expose `choose_workspace`, `list_directory(root, relative)`, `create_markdown_file`, `rename_entry`, and `trash_entry`. Deletion must use a recoverable system-trash implementation, never recursive permanent deletion.

Extend `DocumentPort` with the exact workspace entry points used by the empty state and recent list:

```ts
export interface WorkspaceRoot { path: string; title: string; }
chooseWorkspace(): Promise<WorkspaceRoot | null>;
openWorkspacePath(path: string): Promise<WorkspaceRoot>;
```

Run `cargo add trash --manifest-path src-tauri/Cargo.toml` and implement `trash_entry` with that crate. The UI labels the action “移到废纸篓”, and a failed trash operation leaves the tree unchanged.

- [ ] **Step 3: Write the pure tree reducer and component tests**

Tree state stores only loaded nodes. Tests prove expanding one directory requests only that directory, collapsing retains cached children, filtering matches filenames, and clicking a file calls `openPath`.

- [ ] **Step 4: Implement the drawer UI**

The sidebar is hidden for loose files, opens automatically after “打开文件夹”, and remains manually collapsible. Use accessible tree roles and keyboard navigation. Keep width between 220–320 px and do not add outline, Git, or plugin panes.

- [ ] **Step 5: Run checks and commit**

Run:

```bash
npm test -- src/workspace src/app
cargo test --manifest-path src-tauri/Cargo.toml workspace
```

Expected: PASS.

```bash
git add src/workspace src/app src/document src-tauri
git commit -m "feat: add optional folder drawer"
```

---

### Task 10: Handle external changes, recovery, and restored sessions

**Files:**
- Create: `src-tauri/src/watch.rs`
- Create: `src-tauri/src/recovery.rs`
- Create: `src-tauri/tests/recovery.rs`
- Create: `src/conflict/ConflictDialog.tsx`
- Create: `src/conflict/ConflictDialog.test.tsx`
- Create: `src/recovery/RecoveryDialog.tsx`
- Create: `src/recovery/RecoveryDialog.test.tsx`
- Modify: `src/app/useAppController.ts`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/app/AppShell.test.tsx`
- Modify: `src/document/types.ts`

- [ ] **Step 1: Write state-transition tests for disk events**

Cover: clean + changed → reload; dirty + changed → conflict without overwriting text; deleted → missing with buffer retained; own-save events matching the saved opaque version or save token → ignore; moved/renamed inside an opened root → update path. A matching millisecond timestamp alone must never suppress a disk event.

- [ ] **Step 2: Implement normalized watcher events**

Use one debounced watcher service and emit:

```ts
type DiskEvent =
  | { kind: "changed"; path: string; modifiedUnixMs: number; version: string }
  | { kind: "missing"; path: string }
  | { kind: "moved"; from: string; to: string };
```

The controller compares the event version with the last successful save version (or a save token held for that write) before dispatching reducer actions. `modifiedUnixMs` remains display metadata only.

Add the watcher dependency with `cargo add notify --manifest-path src-tauri/Cargo.toml`. Start watching only open document paths and the active workspace; stop each watch when its last consumer closes.

- [ ] **Step 3: Write Rust recovery tests**

Prove that dirty snapshots are stored under the app data directory, written atomically, listed on restart, removed after successful save+close, and never overwrite original documents.

- [ ] **Step 4: Implement recovery and session persistence**

Persist tab metadata separately from dirty draft content. Recovery records include original path, title, text, BOM, newline, saved-text hash, and the last observed opaque version. On launch, show restore/discard; do not silently open dirty drafts as clean documents. Parent-directory durability synchronization for recovery/session records belongs to this recovery/persistence phase, not Task 2's document write scope.

Persist the last window size/position, recent file/folder paths, open-tab order, active tab, theme, and editor preferences. Debounce dirty draft writes by 2 seconds and flush on window close. Cap recent items at 10 and silently remove paths that no longer exist only after the user attempts to open them.

Render the persisted recent list in `AppShell` only when no tabs are open. Show at most 10 entries with file/folder icons and full paths as accessible descriptions; clicking a file calls `openPath`, clicking a folder opens the sidebar, and a failed missing-path open removes that item after showing a non-blocking message.

- [ ] **Step 5: Implement conflict/recovery dialogs and verify**

Conflict actions are “载入磁盘版本”, “保留当前版本”, and “另存为”. Recovery actions are “恢复”, “查看源码”, and “丢弃”. All destructive choices require explicit clicks.

Add controller/component tests for a `DocumentPortError` during save: the active tab remains dirty with its text unchanged; the error dialog exposes “重试” and “另存为”; “重试” starts a fresh request and calls `save` again for the same tab; “另存为” calls `chooseSavePath`, checks normalized path/ID collisions before writing, then calls `saveToPath` with the expected target version; canceling path selection returns to the still-dirty tab. Add overlapping-save tests proving stale request completions cannot replace newer metadata and edits made during a save remain dirty. Add a pre-save version-conflict test proving a stale caller cannot replace newer disk bytes. Add watcher acceptance tests proving a changed event's text is read together with its version and that the controller does not apply content from one version while recording another. Add empty-state tests proving persisted recent files and folders render, open through the correct port method, and disappear only after a confirmed `not_found` result.

Run: `npm test && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/conflict src/recovery src/app src/document src-tauri
git commit -m "feat: protect edits with conflict and recovery flows"
```

---

### Task 11: Apply the Baseline-inspired light/dark visual system

**Files:**
- Create: `src/theme/tokens.css`
- Create: `src/theme/app.css`
- Create: `src/theme/useTheme.ts`
- Create: `src/theme/useTheme.test.ts`
- Create: `src/theme/preferences.ts`
- Create: `src/theme/preferences.test.ts`
- Modify: `src/main.tsx`
- Modify: `src/app/AppShell.tsx`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Write theme-state tests**

Test `system`, `light`, and `dark`; default `dark`; system media-query changes; persisted preference; and reduced-motion class changes.

Also test persisted editor preferences with these validated ranges: body size 13–24 px, line height 1.3–2.2, content width 560–1100 px, and a font-family string chosen from system, serif, monospace, or a user-entered installed font name. Invalid stored values fall back to defaults.

- [ ] **Step 2: Implement semantic tokens, not copied Obsidian selectors**

Define tokens for canvas, elevated surface, hover surface, primary/secondary/muted text, divider, accent, danger, shadow, radius, density, editor width, body size, and line height. Use Baseline's principles—Inter UI font, low-contrast borders, restrained rounded surfaces, and subtle transitions—without importing Obsidian class names.

- [ ] **Step 3: Style the complete shell**

Match the approved minimal layout: native traffic-light space, compact tabs, central reading column, hidden-by-default sidebar, top search panel, subtle dirty/conflict states, and clear keyboard focus. Add `@media (prefers-reduced-motion: reduce)` to disable nonessential transitions.

Persist theme and editor preferences through the Tauri store plugin. Apply values as root CSS custom properties; preferences must never be written into Markdown documents.

- [ ] **Step 4: Add accessibility component tests**

Run axe-compatible role/name assertions for empty state, tabs, tree, dialogs, and search. Verify keyboard-only open/save/tab/sidebar flows and visible focus.

- [ ] **Step 5: Run tests, capture screenshots, and commit**

Run:

```bash
npm test
npm run build
```

Capture light and dark screenshots at 1080×760 for `docs/screenshots/`.

```bash
git add src/theme src/app src/main.tsx src-tauri/tauri.conf.json docs/screenshots
git commit -m "feat: apply minimal Baseline visual system"
```

---

### Task 12: Enforce large-document degradation and performance budgets

**Files:**
- Create: `src/editor/performanceMode.ts`
- Create: `src/editor/performanceMode.test.ts`
- Create: `scripts/generate-perf-fixtures.mjs`
- Create: `scripts/measure-editor.mjs`
- Modify: `package.json`
- Create: `docs/performance.md`

- [ ] **Step 1: Write threshold tests**

```ts
expect(modeFor({ bytes: 1_048_576, lines: 20_000 })).toBe("full");
expect(modeFor({ bytes: 2_097_153, lines: 10 })).toBe("light");
expect(modeFor({ bytes: 10, lines: 50_001 })).toBe("light");
```

Also test that the user can temporarily force full mode and that reopening a large document returns to automatic light mode.

- [ ] **Step 2: Implement light mode using CodeMirror compartments**

Light mode keeps Markdown parsing, selection, search, and visible-range text styling; it disables offscreen image creation and nonessential block widgets. Show a dismissible banner with “继续完整渲染”. Never change document text.

- [ ] **Step 3: Generate deterministic fixtures**

`generate-perf-fixtures.mjs` writes seeded UTF-8 Markdown at 1 MiB, just over 2 MiB, and 10 MiB/100,000 lines into an ignored `tests/perf/generated/` directory. Do not commit large generated fixtures.

- [ ] **Step 4: Add measurement script and budgets**

Measure process-to-editable separately in a shell timing harness; use Playwright performance marks for open-to-editor, input-to-paint p95, and sidebar-interactive timing. Fail the release benchmark when the M1/8 GB baseline exceeds the spec: 1 s hot start, 2 s cold start, 1 s regular open, 3 s pressure open, 32/50 ms p95 input, 1 s pressure save.

Add these exact scripts to `package.json`:

```json
{
  "scripts": {
    "perf:fixtures": "node scripts/generate-perf-fixtures.mjs",
    "perf": "node scripts/measure-editor.mjs"
  }
}
```

- [ ] **Step 5: Run and document results**

Run:

```bash
npm run perf:fixtures
npm run perf
```

Expected: JSON report includes hardware, macOS, build SHA, five samples, medians, p95 values, and pass/fail per budget.

In `docs/performance.md`, define Gatekeeper handling exactly: install the same signed/notarized build and launch it once to complete quarantine/Gatekeeper verification; record that first launch separately as informational `gatekeeper_first_launch_ms`; quit and confirm no process remains. A cold-start sample is the first launch after reboot of that already-approved build, so five cold samples require five reboot cycles. A hot-start sample begins immediately after a normal quit of the already-approved build. The 2-second cold budget excludes only the separately recorded first-verification launch, not ordinary process or WebView startup.

- [ ] **Step 6: Commit**

```bash
git add src/editor/performanceMode.ts src/editor/performanceMode.test.ts scripts package.json package-lock.json docs/performance.md .gitignore
git commit -m "perf: enforce large document budgets"
```

---

### Task 13: Package, smoke-test, and document the macOS release

**Files:**
- Create: `tests/e2e/notepad.spec.ts`
- Create: `playwright.config.ts`
- Create: `docs/testing.md`
- Create: `docs/releasing.md`
- Create: `scripts/verify-macos-bundle.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add browser-shell end-to-end flows**

With `MemoryDocumentPort`, automate: open two files, edit/save, dirty close cancel, source/live switch, LaTeX success/error, search/replace, folder drawer, external conflict, and recovery. Use real CodeMirror interactions, not reducer calls.

- [ ] **Step 2: Run E2E red, wire the injectable composition root, rerun green**

Run: `npm run test:e2e`

Expected before injection: FAIL because the web shell cannot select a port. Add `createApp(port: DocumentPort)` and use the memory port only when `VITE_E2E=1`; production always uses `tauriDocumentPort`. Rerun and expect PASS.

- [ ] **Step 3: Add the complete macOS manual acceptance checklist**

`docs/testing.md` must list exact steps for Finder “打开方式”, file/folder drag, Chinese IME, new/save/save-as, CRLF/BOM preservation, image paste cancel/save, external edit/delete/move, crash recovery, light/dark/system, reduced motion, and the 1/2/10 MiB performance cases.

- [ ] **Step 4: Configure Developer ID release without App Sandbox**

Document required environment variables and commands in `docs/releasing.md`. Enable Hardened Runtime, omit App Sandbox entitlements, build with `npm run tauri build -- --bundles app,dmg`, sign every executable with Developer ID Application, submit with `xcrun notarytool`, staple the ticket, and verify with `codesign --verify --deep --strict` plus `spctl --assess --type execute`.

- [ ] **Step 5: Implement the verification script**

`scripts/verify-macos-bundle.sh APP_PATH` checks that the path ends in `.app`, runs deep/strict code-sign verification, prints entitlements, fails if `com.apple.security.app-sandbox` is true, runs Gatekeeper assessment for release builds, and never launches the app automatically.

- [ ] **Step 6: Run the full release candidate gate**

Run:

```bash
npm ci
npm run check
npm run test:e2e
npm run perf
npm run tauri build -- --bundles app,dmg
./scripts/verify-macos-bundle.sh "src-tauri/target/release/bundle/macos/Markdown Edit.app"
```

Expected: automated tests and budgets PASS; `.app` and `.dmg` exist; verification reports valid Developer ID signature/notarization when credentials are configured. Local ad-hoc builds may skip Gatekeeper assessment but must be labeled non-release.

- [ ] **Step 7: Final spec coverage audit and commit**

Check every numbered requirement in the design spec against a test, manual checklist item, or release verification command. Record any intentional environment-only limitation in `docs/testing.md`; do not weaken the spec silently.

```bash
git add tests playwright.config.ts docs/testing.md docs/releasing.md scripts/verify-macos-bundle.sh .github/workflows/ci.yml src-tauri/tauri.conf.json
git commit -m "release: add macOS acceptance and packaging"
```

---

## Final verification

After Task 13, run from a clean checkout:

```bash
npm ci
npm run check
npm run test:e2e
npm run perf:fixtures
npm run perf
npm run tauri build -- --bundles app,dmg
```

Then follow `docs/testing.md` on an Apple Silicon Mac and verify the built bundle without auto-launching it. The MVP is complete only when the spec's nine completion criteria have corresponding passing evidence.

## Spec coverage matrix

| Design requirement | Implemented and verified by |
|---|---|
| Tauri/React/CodeMirror/Lezer architecture | Tasks 1, 3, 4, 6 |
| Arbitrary files, tabs, save/save-as, close protection | Tasks 2–5, 13 |
| Recently closed stack and `⌘⇧T` reopening | Tasks 3, 5, 13 |
| Finder/file association and drag/drop | Tasks 4, 13 |
| Optional lazy folder drawer and file operations | Task 9 |
| Markdown/GFM live preview and source mode | Tasks 5–6 |
| Markdown list/quote continuation keymap | Task 5 |
| KaTeX inline/block math and error fallback | Task 7 |
| Current-document search/replace | Task 8 |
| Local/network image display and explicit paste saving | Task 8 |
| External changes, missing files, recovery, recent session | Task 10 |
| Baseline-inspired light/dark/system UI and preferences | Task 11 |
| Quantified 1/2/10 MiB performance behavior | Task 12 |
| Developer ID, notarization, non-sandbox release | Task 13 |
| Automated plus macOS manual acceptance | Tasks 1, 5–13 |

Self-review result: every design-spec section has an implementation task and verification evidence; no requirement is deferred outside this plan.
