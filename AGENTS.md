# Repository Guidelines

This document is the single source of truth for AI agents working on Opus, a
cross-platform Markdown editor. Read it before making changes.

## Project overview

Opus is a lightweight native Markdown editor. It opens ordinary `.md` files in
place—there is no import step, proprietary format, or cloud account. The UI is
a React/TypeScript frontend; native file I/O, watching, recovery, workspace
operations, menus, font enumeration, and the updater are provided by a
Rust/Tauri backend.

- Product name: **Opus**
- Bundle identifier: `com.xiongweini.markdown-edit`
- Version: `0.2.8` (kept in sync across `package.json`,
  `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and
  `src-tauri/tauri.conf.json`)
- Target platform: macOS 12+ (Apple Silicon first), Windows 10/11 (WebView2),
  and Linux (WebKitGTK)
- UI language: Chinese (`zh-CN`); code, comments, and docs are in English
- License: MIT

## Technology stack

- **Frontend**: React 19, TypeScript (strict), Vite 8, CodeMirror 6, KaTeX,
  GSAP (with `@gsap/react`).
- **Native shell**: Tauri 2 with a Rust backend (edition 2021).
- **Node toolchain**: Node.js 22 + npm.
- **Rust toolchain**: Stable Rust (minimum `1.77.2`).
- **Test runners**: Vitest 4 (jsdom) for unit/component tests, Playwright for
  browser-shell E2E, Node's built-in `node --test` for the perf/native
  script harnesses, and Cargo for Rust unit and integration tests (including
  the feature-gated native-test support).
- **Key npm packages**: `@codemirror/*`, `@tauri-apps/api`,
  `@tauri-apps/plugin-dialog/fs/opener/store/process/updater`, `katex`,
  `gsap`, `@gsap/react`, `react`, `react-dom`.
- **Key Rust crates**: `tauri` 2.11 (with `protocol-asset`),
  `tauri-plugin-dialog/fs/opener/process/store/updater/log`, `notify` 8.2,
  `trash` 5.2, `sha2`, `serde`, `tempfile`, `reqwest` 0.13 (rustls with the
  ring provider pinned), `keyring` 3.6 (per-target credential backends:
  `apple-native` / `windows-native` / `async-secret-service` — translation API
  keys live in the OS credential store, see `api_keys.rs`); Windows-only `tauri-plugin-single-instance`
  (second-launch argv → open-with), `winreg` (installed-font registry
  enumeration), and `windows-sys` (file identity — volume serial + file index
  — via `BY_HANDLE_FILE_INFORMATION`, see `document_io.rs`); macOS-only
  `objc2-app-kit`/`objc2-foundation`/`objc2-web-kit`/`objc2-core-foundation`/
  `objc2-core-text` 0.3 (pinned to wry's locked versions so the types line up
  with the webview handles from `with_webview`).

## Project structure

```
.
├── src/                    # React/TypeScript frontend
│   ├── app/                # Application orchestration
│   ├── document/           # Document state and storage ports
│   ├── editor/             # CodeMirror editor and extensions
│   ├── motion/             # GSAP animation runtime and editor motion
│   ├── perf/               # Production perf entry (perf.html → dist-perf/)
│   ├── present/            # Presentation (slideshow) mode
│   ├── workspace/          # Folder sidebar
│   ├── theme/              # Design tokens, CSS, preferences
│   ├── translate/          # Document translation pipeline and settings
│   ├── conflict/           # External-change conflict dialog
│   └── recovery/           # Crash-recovery drafts and UI
├── src-tauri/src/          # Rust backend
│   ├── lib.rs              # Tauri builder: plugins, commands, macOS menu, open/drop events; Windows single-instance (tauri-plugin-single-instance) forwards second-launch argv as open-with
│   ├── document_io.rs      # Lossless atomic file reads/writes
│   ├── document_commands.rs# Tauri commands for documents/images/scopes
│   ├── workspace.rs        # Directory listing and workspace mutations
│   ├── watch.rs            # Debounced filesystem watcher
│   ├── recovery.rs         # Recovery draft storage
│   ├── native_e2e.rs       # Feature-gated native test marker/report commands
│   ├── translate.rs        # OpenAI-compatible translation + disk cache (keys resolved per slot from the credential store)
│   ├── api_keys.rs         # Translation API key store: OS keychain w/ 0600 file fallback
│   ├── asset_scope.rs      # Webview asset-scope registry
│   ├── open_events.rs      # Deep-link / drag-drop / argv normalization
│   ├── menu.rs             # Native macOS menu bar
│   ├── fonts.rs            # Installed-font enumeration (Core Text on macOS, registry on Windows)
│   ├── linux_env.rs        # Linux-only pre-init env (Wayland backend, DMA-BUF)
│   ├── perf_mark.rs        # Startup instrumentation hook
│   └── window_background.rs# Native window/webview background sync
├── src-tauri/tests/        # Rust integration tests
├── tests/e2e/              # Playwright browser-shell workflows
├── tests/perf/             # Performance fixtures, reports, samples
├── scripts/                # Performance, native-E2E, screenshot, and bundle scripts
├── docs/                   # Testing, releasing, performance docs
│   └── superpowers/        # Design specs and implementation plans
├── perf.html               # Production perf entry (built to dist-perf/)
├── vite.perf.config.ts     # Perf build/preview config (mode perf, port 1422)
├── package.json            # Frontend scripts and dependencies
├── src-tauri/Cargo.toml    # Rust package manifest
├── src-tauri/tauri.native-e2e.conf.json # Dedicated native-test identifier/build
└── src-tauri/tauri.conf.json # Tauri bundle/window/security/updater config
```

## Module divisions

- `src/app/`: composition root (`App.tsx`, `createApp.tsx`), top-level shell
  (`AppShell.tsx`), state controller hook (`useAppController.ts`), settings
  dialog (`SettingsDialog.tsx` — a dual-pane dialog with a minimal top header,
  a borderless left navigation rail with vertical 外观/编辑器/翻译/关于 pill
  tabs, a unified dialog surface (`--surface` dark / `--canvas` white light),
  a 3-card visual theme selector (`浅色`/`深色`/`跟随系统`), and soft 10 px
  rounded-rectangle 36 px controls (compact centered numeric fields with
  adjacent px/倍/个 units, soft-filled selects, full-width stacked API
  endpoint), roving-tabindex ArrowUp/ArrowDown/Home/End navigation, a compact
  icon rail below 700 px, field+action rows stacked below 900 px and every
  row below 560 px; its API Key field is write-only: it never echoes a stored
  key, shows an 已保存 placeholder when the addressed slot has one, commits on
  blur/Enter straight to the credential store, and offers a 清除 button plus a
  warning when the store fell back to the weakly-protected file), tab bar (`TabList.tsx`), automatic
  performance-mode hook (`usePerformanceMode.ts`), in-app update checks
  (`updates.ts`), and the E2E fixture bridge (`e2e.ts`). A persistent 36 px
  activity rail sits at the far left of the shell body: its top actions are
  文件 (return to the explorer when search is active, otherwise open the
  native-Dialog quick switcher) and 搜索 (a dedicated full-text search view;
  activating it again returns to the file tree). Settings live at the bottom
  of every expanded sidebar view and disappear with a collapsed sidebar. The
  explorer toggle lives in the titlebar's leading group and remains clickable
  below the macOS traffic-light inset. The rail never collapses with the
  explorer, and its buttons never scale on hover or use an accent pressed
  background. When the explorer collapses, an inverse radial corner joins the
  rail's upper edge to the canvas; neither the activity rail nor the
  sidebar/outline connectors have drop shadows. Titlebar controls share one
  vertical centerline, tabs remain flush with its bottom edge, and both
  panel-toggle icons are 16 px inside 32 px targets. `WelcomeScreen.tsx` (styles in
  `welcome.css`) renders the empty editor area as a single-column welcome page:
  a script `Opus` wordmark on macOS and a plain UI-font wordmark elsewhere (no
  subtitle), quiet 启动/最近 headings, launch actions with the real
  platform shortcuts (⌘N/⌘O/⇧⌘O on macOS, Ctrl+N/Ctrl+O/Ctrl+Shift+O
  elsewhere), and the first five recent files/folders plus a native
  `<details>` 更多… disclosure. Recent activation goes through the controller's
  `openRecent`; opening a recent folder sets the existing reveal-sidebar flag,
  while session restores keep their persisted collapse state. Each recent row
  is a native button without a file icon; its accessible name (打开文件/打开文件夹
  + name + full path) and native tooltip carry the full path. The visible name is
  primary-colored with a muted 文件/文件夹 type tag, followed by
  a right-aligned compact parent directory separated by 24 px (`~` replaces
  the usual macOS/Linux/Windows home prefix, and files do not repeat their
  basename),
  with CSS-only overflow
  ellipsis. Rows bleed their hover surface with negative inline margins so
  the wordmark, section headings, row icons, and recent names share one left
  edge. The header is platform-specific:
  macOS keeps the native menu bar (so the header stays minimal) while Linux
  and Windows native builds get a file-icon dropdown in the header plus
  frontend keybindings
  (Ctrl+N/O/Shift+O/S/Shift+S/W/,) replacing the native menu accelerators
  (see `AppShell.customFileHeader.test.tsx`). Windows, whose window is
  undecorated (`set_decorations(false)`), additionally draws its own caption
  buttons and window-edge resize handles (`WindowControls.tsx`). Settings open
  from the expanded sidebar's bottom-right button; the macOS native menu and
  Ctrl/Cmd+, remain.
  `TabList.tsx` renders horizontal document tabs directly in the unified top
  bar (Left/Right, Home/End, single-row horizontal overflow), shown only when
  documents are open. Its leading column follows the activity rail/sidebar
  width, with an 86 px minimum safe inset on macOS; the top bar and left panels
  share `--surface-panel`. Each file tab fuses the
  title button and its close button; the selected tab uses the editor canvas
  color with top corners and inverse radial lower shoulders, without an accent
  underline or hover wash. Close buttons reveal on hover/focus; only the last
  tab has a spring-loaded create button emerging to its right. Blank top-bar
  regions invoke native window dragging without capturing tab controls.
  The dirty/conflict/missing dot remains.
  The unified top bar has no global workspace-search field. The explorer owns
  the file tree even in the empty state; it never contains
  the document tab list. The translate, view-mode, and presentation toggles
  live in the outline toolbar beside the icon-only 大纲 header button while the
  panel is open — hiding it never resets
  per-tab translation or view-mode state. When the outline is collapsed while
  a translation is on screen or the reading view is active, a compact state
  bar above the editor keeps that state visible with a
  返回编辑/显示原文/取消翻译 action and a chip that reopens the outline. A
  missing translation key surfaces as a notice (not a danger alert) with a
  direct 打开设置 action.
  Panel widths are display-clamped so the editor keeps its 320 px floor: a
  wide persisted width is shown narrower, never written back. A runtime
  `sidebarAutoHidden` flag hides the explorer without touching the persisted
  collapse preference, and the guard reclaims the outline first and then the
  explorer; a wide restart restores an auto-hidden explorer. The guard
  restores hidden panels only on the window-width path (initial settle and
  resizes), with a 32 px hysteresis; panel drags never do. Opening a panel by hand makes room
  by hiding the other when both preferred widths would break the floor.
  `ContextMenu.tsx`
  is the shared right-click menu (portal, keyboard navigation, edge flip)
  used by the editor area, the top tab list, the file tree, and the
  shell-level fallback menu; selecting an item closes the menu itself, so
  item handlers must not close it again. The editable document title above
  the editor toolbar aligns with the reading column's 2 px inline inset,
  folds away after the editor scrolls (72 px down, 16 px back), stays
  expanded while focus is inside it or the inline editor is open, and renames
  the underlying file through
  `controller.renameDocument` (backend `rename_document`, no workspace anchor
  required); for a new 未命名 document — which has no file yet — the title and
  the tab menu's rename entry route to Save As instead.
  `InlineNameInput.tsx` is the shared inline rename input also
  used by the file tree. `demoPort.ts` constructs the fixture-seeded
  `MemoryDocumentPort` for the dev demo and the production perf entry
  (`?fixture=<basename>` / `&workspace=1`); `App.tsx` only calls it in DEV.
  `nativeE2e.ts` is the scenario runner for the dedicated native test build:
  `AppShell.tsx` imports it dynamically only when
  `import.meta.env.MODE === "native-e2e"`, and it drives the real
  controller, CodeMirror view, and `TauriDocumentPort` through marker/report
  commands. Normal builds tree-shake it, and update checks stay disabled
  (`updates.ts` treats `MODE === "native-e2e"` like dev/E2E).
  `WorkspaceSearch.tsx` is the reusable, unit-tested saved-Markdown search
  component and `DocumentPort.searchWorkspace` keeps its backend contract; in
  dedicated mode it fills the left sidebar with a single pill-shaped search
  field. Results are grouped per file, each match row carries its line number
  and a full accessible label, the selected row uses a neutral elevated surface (`--surface-active`), and the
  hit is emphasized with weight/underline on that row (`searchViews.css`).
  `FileQuickSwitcher.tsx` uses a native `<dialog>` with combobox
  keyboard navigation, recursively collected Markdown paths, and Shift+Enter
  creation through `createMarkdownFile`. Options split the file name from its
  parent directory and highlight query tokens; creation rows carry a 创建
  badge. Option indices stay global across the six-item list and its
  更多… disclosure, so ids, `aria-selected`, and `aria-activedescendant`
  agree; the disclosure auto-opens for keyboard selection. The footer spells
  platform keycaps (↵/⇧↵/esc on macOS, Enter/Shift+Enter/Esc elsewhere). It
  has no close icon and closes on an outside pointer press or Escape.
- `src/perf/`: `main.tsx` is the production performance entry loaded by
  `perf.html`. It injects the shared demo port through
  `createApp(port, { browserShell: true })` under React's production runtime;
  it is built only by `vite.perf.config.ts` into `dist-perf/`, never by the
  normal `index.html`/`dist/` build.
- `src/present/`: presentation (演示模式) slide playback. The overlay at
  `PresentationOverlay.tsx` renders the active document's ORIGINAL text
  (never the translation) one slide at a time through the same reading-mode
  CodeMirror preview extensions as the editor, with images resolved via
  `tauriImagePreviewUrl`; the slide host shares the token-driven code,
  inline-code, and frontmatter skin from `livePreviewRefinements.css` without
  taking the editor's `.markdown-editor` layout class.
  `presentationPlan.ts` plans slides: explicit `---`
  separators win when present (`splitManualSlides`), otherwise natural blocks
  are greedily packed by measured rendered height (`splitNaturalBlocks` +
  `packBlocksByHeight`). Open state is per tab on the controller
  (`presentationTabs` Set with `presentationOpenOf`/`openPresentation`/
  `closePresentation`, mirroring viewModes and pruned on tab close); entry
  points are a header toggle button (next to the view-mode toggle) and the
  editor-area context menu. `AppShell.tsx` drives OS fullscreen while
  presenting (`core:window:allow-set-fullscreen` in Tauri builds, the
  Fullscreen API in browsers) and restores it on close or unmount.
- `src/document/`: the `DocumentPort` contract (`DocumentPort.ts`), pure
  document reducer (`documentReducer.ts`), shared types (`types.ts`), and two
  implementations:
  - `tauriDocumentPort.ts` — production backend via Tauri invoke/events; also
    owns session persistence (`session.json` via plugin-store) and window
    geometry restore. It owns the translation-key upgrade path too:
    `loadSession` hands every plaintext key of a pre-slot session to
    `store_translation_key` and only then persists the sanitized session; if
    any store call fails, the plaintext fields stay on disk *and* are
    re-attached to every later session write of that run, so no save and no
    relaunch can drop a key — the next launch retries the (idempotent)
    migration.
  - `memoryDocumentPort.ts` — in-memory port used by unit tests, the dev demo,
    the production perf entry, and Playwright E2E fixtures.

  `saveFlow.ts` owns per-tab save mutual exclusion (lock taken before the
  first await, released in `finally`), save/save-as/close target selection,
  passing the reducer's frozen `PendingWriteRequest` to `write` unchanged,
  lifecycle-currency checks, and outcome routing (`saved`, `cancelled`,
  `blocked` by a visible translation, `stale`, target/write conflict, or a
  `failed` retry payload). `externalChanges.ts` owns pure disk-event policy
  (`decideDiskEvent`: unknown path, pending save, self-save echo, non-clean,
  same path, missing, reload, moved) and the guarded read
  (`readCurrentDiskVersion`: normalized path plus expected version, watch vs
  explicit purpose, `unchanged`/`loaded`/`missing`/`stale`/`error`). Neither
  module imports React; `useAppController` remains the adapter that
  dispatches reducer actions and moves scopes/watches. `DocumentPort` also
  exposes `searchWorkspace(root, query)`: the Tauri port calls the bounded,
  anchored Rust scanner, while the memory port implements the same contract
  for tests/demo/E2E. Search returns saved line matches only; it does not
  index or write documents.
- `src/recovery/`: crash-recovery drafts and UI. `drafts.ts` derives draft
  IDs as `draft-<launch namespace>-<tab id>`: the namespace is one random
  UUID per application launch, so a fresh session's `document-1` can never
  overwrite another session's leftover draft. Legacy `draft-document-N` IDs
  stay listable/readable by the port; `restoreDraft.ts` migrates one by
  writing the owner copy under the current namespace before discarding the
  legacy ID. `draftScheduler.ts` owns the 2 s debounce / 5 s maximum-pending
  per-tab scheduling, reference-based `{status, text}` plus scalar metadata
  signatures (path, title, BOM, newline, version), flush, and
  persisted-draft bookkeeping; `restoreDraft.ts` owns the
  read → adopt → owner-ready → owner-write → discard-leftover transaction
  and never rejects. Both modules are React-free; the controller supplies
  the host callbacks and keeps lifecycle generations, close-dialog state,
  and user-visible state.
- `src/editor/`: `MarkdownEditor.tsx` plus CodeMirror extensions for live
  preview, Markdown tables (`markdownTable.ts`, `tableWidgets.ts`), math
  rendering. Overflowing rendered tables place an accessible range slider below
  the scroller; `tableHorizontalScroll.ts` owns overflow measurement, two-way
  scroll synchronization, and observer/listener cleanup, while the widget keeps
  slider keyboard/input events out of editor and cell handling. Math
  rendering (`mathExtension.ts`, `mathWidgets.ts`), image widgets, image
  paste/drop, outline publishing (`outline.ts`, `outlineExtension.ts`,
  `OutlinePanel.tsx` — its `activeId` marks the heading under the viewport
  with `aria-current="location"`; a hidden heading is represented by its
  nearest visible collapsed ancestor, whose accessible name appends 包含当前标题,
  instead of auto-expanding, and only the active row or marked ancestor is
  scrolled into view when that state changes),
  search (wired in `editorExtensions.ts` via
  `@codemirror/search`; `searchPanelTheme.ts` localizes the find/replace
  panel through `EditorState.phrases` and skins it with design tokens, shared
  by the document editor and presentation previews), frontmatter, highlight
  markers, performance (light)
  mode (`performanceMode.ts`), and fenced-code-block typing assists
  (`codeBlockAutoClose.ts` — auto-closing fences plus bracket/quote pairing,
  stepping over, wrapping, and pair deletion, strictly gated on the syntax
  tree so prose and inline code are untouched). Light mode applies at
  2 MiB UTF-8 / 50,000 lines. Inside light mode, `markdownSyntaxFor` switches
  to the **core** grammar only when the original text reaches 8 MiB of
  UTF-16 code units, and leaves it only at 7.5 MiB or below (hysteresis).
  Normal documents, 2 MiB/50,000-line light documents, and force-full
  (`继续完整渲染`) keep the full grammar. Core retains frontmatter plus the
  base Markdown grammar used by the outline (headings, lists, quotes, code,
  emphasis, links) and removes the GFM/highlight/math extensions and nested
  `codeLanguages` highlighting; a fenced block still parses as code without
  language-specific highlighting. The grammar lives in a Compartment:
  `reconfigure` never rebuilds the `EditorView`, so selection and undo
  history survive. A reconfigure requested during IME composition is frozen
  until `compositionend` (with a polling fallback), and the outline publisher
  re-extracts headings on `transaction.reconfigured`. Table widgets depend on
  GFM's `Table` node: their independent 1,000-cell light-mode rule
  (`LIGHT_MODE_TABLE_CELL_LIMIT`) applies only with the full grammar, and
  core produces no table widgets at all. `viewMode.ts` defines the
  per-tab modes: `editing` (live preview, selection reveals source) and
  `reading` (read-only, fully rendered). `livePreviewRefinements.css` owns the
  rendered typography: fenced blocks and inline code sit on `--surface-code`
  (one quiet step above the canvas, never a card), the language label sits at the
  block's top-left, fixed 8/16 px fenced-block insets and 8/4 px radii are
  shared by the editor and presentation slide host, and a heading's `#` run
  hangs in the left margin (tucked above the heading below 960 px) so
  revealing it never shifts the text; quote and code line decorations merge
  when blocks nest.
  On Linux (WebKitGTK), IME
  compositions are protected by a patch-package patch
  (`patches/@codemirror+view+*.patch`,
  applied via the `postinstall` script) that stops CodeMirror from rewriting
  the DOM selection mid-composition — without it, fcitx5's preedit caret gets
  pinned after the first letter. The platform also never renders a caret
  inside the marked text and reports a bogus selection offset during
  composition, so `imeCaret.ts` hides the drawn caret layer while composing
  and positions its own caret at the end of the preedit text node. Editor
  extensions must never dispatch transactions synchronously during
  composition (live preview/math decorations freeze instead and recompute at
  `compositionend`).
- `src/motion/`: GSAP-based animation. `motionConfig.ts` holds the shared
  timing/easing tokens; `motionRuntime.ts` provides panel/dialog/list intro
  helpers that honor `prefers-reduced-motion`; sidebar/outline expansion
  deliberately uses only the shared CSS width/opacity transition (including
  the header grid track), never per-panel or per-row intro timelines;
  `editorMotion.ts` animates editor content on view-mode switches and is
  disabled in light performance mode. Target counts are clamped (`MAX_EDITOR_MOTION_TARGETS`,
  `MAX_LIST_MOTION_TARGETS`) to bound animation cost.
- `src/workspace/`: persistent explorer tree state (`treeReducer.ts`) and UI
  (`FileSidebar.tsx`). Only directories and `.md`/`.markdown` files appear;
  other formats stay hidden. The header shows only the workspace title; its
  actions (new file / close folder) live in the title's right-click menu. The
  activity rail's 搜索 button replaces this panel with dedicated full-text
  search and toggles back to the tree. Activity/sidebar/editor boundaries use
  surface contrast, a faint edge glow, and 32 px outward radial top corners on
  both sidebars without extra divider lines or bottom connectors. Tree rows use
  24 px indentation per depth level, a rotating disclosure chevron for folders,
  and no file icon;
  an invisible spacer keeps file and folder labels aligned at
  `--font-ui-size-large`. The shell passes the open document's `activePath`;
  only a visible file row matching it is selected (a neutral `--surface-active`
  pill without an accent border/wash), while a separate `focusedPath` owns the roving tab stop, so
  keyboard focus never implies selection and an unmatched or directory path
  never falls back to the first row for selection; folder rows carry no
  `aria-selected`. Rows have no inline action buttons; the right-click
  context menu (rename / move to trash; folders additionally offer creating a
  file inside) is built on `src/app/ContextMenu.tsx` and owns those editing
  operations. The Rust
  `workspace::search_markdown` scanner bounds results at 200, skips hidden and
  escaping entries, avoids symlink loops, and runs through the anchored
  `search_workspace` command on the blocking-worker runtime.
- `src/translate/`: document translation pipeline. `types.ts` holds
  `TranslationSettings` (endpoint, model, target language, concurrency — the
  number of batch requests translated concurrently, configurable in settings
  within 1-32, default 10) and the per-tab `TranslationViewState`.
  Translation settings carry no API key: a key is addressed by *slot*
  (`translationKeySlot` = `matchPreset(endpoint, model)?.id` or `"custom"`,
  computed from the settings so it can never go stale) and the backend keeps
  the secret in the OS credential store. `normalizeTranslationSettings`
  therefore returns `{ settings, pendingKeys }`, where `pendingKeys` reports
  the plaintext keys of a session written before slot addressing — the port
  migrates them into the credential store (see `src/document/`) instead of
  the upgrade silently dropping them;
  `presets.ts` defines the provider presets for the settings dialog
  (智谱 GLM-4.7-Flash free tier, 腾讯混元 Hy-MT2-Lite, DeepSeek V4 Flash, each
  with a verified endpoint/model/concurrency) plus `matchPreset`;
  `segments.ts` splits Markdown into
  translatable paragraph blocks and protected blocks (frontmatter, fenced
  code, display math, HTML comments) and subdivides over-long translatable
  segments into chunks under `MAX_TRANSLATABLE_CHUNK_LENGTH` (600 characters;
  line boundaries first, then sentence punctuation, then hard cuts that never
  split a placeholder token); `placeholders.ts` swaps inline code/math spans
  (`` `code` ``, `$math$`) for ⟪n⟫ tokens before subdivision so they survive
  translation verbatim and are validated and restored from each reply;
  `languageGuess.ts` conservatively detects chunks already written in the
  target language (script-ratio heuristic per language family) so they are
  never sent to the provider; `translate.ts` packs pending chunks into
  contiguous batches (`TRANSLATION_BATCH_MAX_UNITS` = 8 /
  `TRANSLATION_BATCH_MAX_CHARS` = 4000), sends one
  `DocumentPort.translateSegments` call per batch through a bounded
  concurrency pool, retries transiently failed batch requests with a short
  backoff (never on abort), and surfaces each finished chunk via `onPartial`
  with the unfinished chunks still showing the original text. Scheduling is
  viewport-first: `TranslateDocumentOptions.priority` (`visibleRange()`)
  reports the visible CHARACTER range of the currently displayed text, and
  every pick maps it to units through their offsets in the latest assembled
  partial (never pixel fractions — protected blocks like code fences would
  skew that mapping), so the visible screen translates first, nearby content
  prefetches, and the rest drains in the background, re-prioritizing live on
  scroll. `useAppController.startTranslation` passes a `priority` reading a
  provider registered via `setTranslationViewportProvider`; `AppShell`
  registers a getter that computes the range on demand from the active
  editor's CodeMirror view (`MarkdownEditor`'s optional `onEditorView` prop,
  `view.posAtCoords` against the scroller rect, null-safe for jsdom). The
  backend `src-tauri/src/translate.rs` translates through an
  OpenAI-compatible chat completions endpoint via reqwest (rustls): the
  uncached segments of one call are joined into a single chat request behind
  ⟪n⟫ delimiter lines, the reply is split and strictly validated (any
  mismatch falls back to one request per segment), results are cached per
  segment on disk, requests pin `temperature: 0`, a 429 with a small
  integer `Retry-After` is retried once asynchronously, and providers whose
  models reason by default get a `reasoning_override`: 智谱 (bigmodel.cn /
  z.ai) and DeepSeek requests carry `"thinking": {"type": "disabled"}`,
  OpenAI reasoning models (gpt-5 family, o-series) get
  `"reasoning_effort": "low"` — reasoning tokens are billed as output and
  glm-4.7-flash can even return empty content when reasoning exhausts the
  completion budget.
- `src/theme/`: CSS tokens, app styles, theme hook, and editor/theme
  preferences. By default the reading column scales proportionally with the window
  (`min(clamp(--editor-content-width, 68%, 1.6x it), 100% - 48px)` on
  `.cm-content`); dragging the hover-revealed short vertical handles flanking
  the reading column (or editing 内容宽度 in Settings) pins `contentWidthPinned`
  (`data-editor-width-mode="fixed"`, `min(--editor-content-width, 100% - 48px)`,
  double-click to reset to auto-scaling), and the scroller runs edge to edge so
  the scrollbar rides the window edge. Syntax
  highlight colors are `--syntax-*` tokens mapped in
  `editor/editorExtensions.ts`. The canvas uses a recessed dark background
  (`--canvas` `#141518`, kept as a plain hex because `window_background.rs`
  parses it as a solid color) with no glow or texture overlays; side panels
  and the header use the flat lighter charcoal `--surface-panel` (`#222328`)
  for clear separation, while dialogs and popovers step above both on
  `--surface`. Primary actions use `.button-primary` (filled `--accent-strong`
  with white text); destructive actions use `.button-danger` (outline
  `--danger-strong` on `--danger-soft`). `--text-muted` stays at or above
  4.5:1 on canvas/panel/surface/hover, `--focus-ring` is a solid neutral slate
  hex, and the UI font starts at `system-ui` (no bundled Inter). Component
  sheets refine their own surfaces — `searchViews.css`,
  `settingsRefinements.css`, `shellRefinements.css`, `fileSidebar.css`,
  `outlinePanel.css`, and `livePreviewRefinements.css` — while app.css keeps
  the shared primitives.
- `src/conflict/`: the external-change conflict dialog and its choices
  (load disk version / keep current / save as).
- `src-tauri/src/native_e2e.rs`: compiled only with the `native-e2e` Cargo
  feature and registered in `lib.rs` under the same gate. Reads
  `OPUS_NATIVE_E2E_SCENARIO`, `OPUS_NATIVE_E2E_MARKER`, and
  `OPUS_NATIVE_E2E_REPORT` from the process environment (the webview cannot
  supply paths), rejects the production identifier and any identifier without
  the `.native-e2e` suffix, stamps reports with the server-owned scenario and
  identifier, and writes markers/reports via sibling temp file + `fsync` +
  rename. `validate_startup` refuses to open the test window when a
  feature-enabled binary was built without the dedicated config.
- `src-tauri/src/document_io.rs`: reads files while preserving UTF-8 BOM and
  newline style; writes atomically via sibling temp file + `fsync` + rename.
- `src-tauri/src/document_commands.rs`: Tauri command handlers for open, save,
  clipboard images, asset scopes, workspace operations, watches, and recovery.
  `rename_document` renames a Markdown file in place from a new base name
  (extension preserved) without requiring a workspace anchor, so the editable
  document title works for individually opened files too. `search_workspace`
  validates the same anchor and returns bounded saved-content matches with
  1-based line and Unicode-character column offsets.
- `src-tauri/src/fonts.rs`: `list_installed_fonts` command backed by Core
  Text on macOS and by the `CurrentVersion\Fonts` registry keys on Windows;
  neither WKWebView nor WebView2 has `queryLocalFonts`, so the settings
  dialog's font picker gets family names from the native side.
- `src-tauri/src/window_background.rs`: paints the window background with the
  resolved `--canvas` color so live resizes never flash white — on macOS
  additionally the NSWindow background and the WKWebView under-page
  background; on Windows only the cross-platform window background (WebView2
  has no under-page layer). Seeded dark at startup, synced from `useTheme` on
  every theme change. Linux has no native chrome to theme: the window runs
  without decorations and no GTK menu bar is installed (both removed because
  the extra titlebar/menu layers were redundant under tiling compositors), so
  the module compiles away there.
- `src-tauri/src/linux_env.rs`: Linux-only, runs before any GTK/WebKit init in
  `run()`. The Tauri-generated AppImage launcher force-exports
  `GDK_BACKEND=x11` (linuxdeploy GTK hook), which strands the app on XWayland
  where pointer grabs mid-drag break and freeze the UI (observed under niri);
  it therefore resets `GDK_BACKEND` to `wayland,x11` on Wayland sessions
  (`OPUS_FORCE_X11` opts out) and defaults `WEBKIT_DISABLE_DMABUF_RENDERER=1`
  because the NVIDIA/GBM DMA-BUF path renders blank webviews there. On Linux,
  `src/main.tsx` also suppresses in-webview HTML5 `dragstart` entirely — every
  in-page native drag takes a WebKitGTK seat grab that can wedge the app;
  external file drops are unaffected. Panel drag-resize never uses
  `setPointerCapture` for the same reason (see `AppShell.tsx`).

## Port selection and runtime modes

All filesystem access goes through `DocumentPort`. The production app always
uses `TauriDocumentPort`. Three non-production modes exist for development and
testing:

- **Dev demo**: `?demo=1` (optionally `&fixture=<basename>` / `&workspace=1` /
  `&theme=light|dark|system`) uses a `MemoryDocumentPort` built by
  `src/app/demoPort.ts` so the UI can run in a plain browser.
- **E2E**: `VITE_E2E=1` plus a `window.__E2E_FIXTURE__` JSON fixture installs a
  `MemoryDocumentPort`; tests can drive it via `window.__E2E_PORT__`.
- **Production perf**: `perf.html` loads `src/perf/main.tsx`, builds through
  `vite.perf.config.ts` into `dist-perf/`, and injects the same
  `demoPort.ts` through `createApp(..., { browserShell: true })`. The normal
  `index.html` entry, normal production build, and normal port selection are
  untouched; `npm run build` must never emit `dist/perf.html`.

`src/app/App.tsx` is the only place that decides which port to create in the
product shell. Production builds never define `VITE_E2E` and
`import.meta.env.DEV` is false, so they always use the Tauri port. The update
check in `src/app/updates.ts` likewise short-circuits to `unsupported` in dev,
E2E, plain browsers, and the dedicated native-test build
(`MODE === "native-e2e"`).

## Build, development, and test commands

Install dependencies:

```sh
npm ci
```

Development:

```sh
npm run dev              # Vite dev server on http://localhost:1420
npm run tauri dev        # Build and launch the native macOS app
```

Frontend build:

```sh
npm run build            # tsc -b && vite build -> dist/
```

Native app build:

```sh
npm run tauri build -- --bundles app         # macOS -> src-tauri/target/release/bundle/macos/Opus.app
npm run tauri build -- --bundles app,dmg     # also produce a DMG
NO_STRIP=1 npm run tauri build -- --bundles appimage    # Linux -> src-tauri/target/release/bundle/appimage/
# (NO_STRIP=1: linuxdeploy's bundled strip predates RELR and fails on
#  bleeding-edge distro libraries, e.g. CachyOS/.relr.dyn sections)
npm run tauri build -- --bundles nsis        # Windows -> src-tauri/target/release/bundle/nsis/
```

Automated testing:

```sh
npm test                 # Vitest unit/component tests (jsdom)
npm run test:node        # node --test for scripts/*.node-test.mjs
npm run test:e2e         # Playwright browser-shell tests on port 1421
npm run test:native -- --build           # build + default smoke scenario
npm run test:native -- --build --scenario all   # build + all four scenarios
npm run check            # test + test:node + build + cargo test (default and
                         # native-e2e unit tests)
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --features native-e2e --lib native_e2e
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --features native-e2e -- -D warnings
```

`npm run test:native` builds with
`tauri build --no-bundle --features native-e2e --config
src-tauri/tauri.native-e2e.conf.json` (product `Opus Native E2E`, identifier
`com.xiongweini.markdown-edit.native-e2e`) and needs an interactive display
session; `--scenario` accepts `smoke|edit-save|external-change|recovery|all`
and defaults to `smoke` (`all` must be passed explicitly),
`--release` builds optimized, `--app <path>` reuses a binary, and
`--keep-data` preserves isolated data for debugging. Diagnostics land in
`test-results/native-e2e/`. Windows native runs are not verified.

Performance:

```sh
npm run perf:fixtures    # atomically regenerate tests/perf/generated/*.md (gitignored)
npm run perf:build       # production perf entry -> dist-perf/ (build-rot gate)
npm run perf:serve       # serve dist-perf/ on 127.0.0.1:1422 (strict port)
npm run perf             # build + strict preview + budgets -> tests/perf/report.json
npm run perf:startup     # packaged-app hot-start cycles -> tests/perf/startup-samples.json
node scripts/measure-editor.mjs --browser dev   # diagnostic -> report.dev.json (gitignored)
```

## Code style guidelines

- Use **two-space indentation** for TypeScript, TSX, CSS, JSON, and Markdown.
- Keep TypeScript strict; prefer small, typed modules.
- React components: `PascalCase`. Hooks: `useCamelCase`. Other symbols:
  `camelCase`.
- Rust: follow `rustfmt`; modules/functions `snake_case`, types `PascalCase`.
- Keep filesystem access behind `DocumentPort`.
- Preserve UTF-8 BOMs, newline style (`lf`/`cr_lf`), conflict tokens, atomic
  saves, and recovery guarantees.
- Animations must respect `prefers-reduced-motion` and stay within the clamped
  target counts in `src/motion/motionConfig.ts`.
- Use focused [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `test:`, `docs:`, `perf:`, `ci:`, `release:`.

## Testing strategy

Automated gates:

- Frontend unit/component tests live beside implementations as
  `*.test.ts` / `*.test.tsx` and run in jsdom via Vitest. The Vitest config
  (in `vite.config.ts`) excludes `tests/e2e/**`, `.worktrees/**`, and `.tower/**`.
  The extracted state modules (`saveFlow`, `externalChanges`,
  `draftScheduler`, `restoreDraft`) are tested standalone against the real
  reducer and deferred port promises; controller/AppShell suites remain
  compatibility gates. Editor tests cover the 8 MiB/7.5 MiB core hysteresis,
  core-vs-full syntax tree, one-view/selection/undo preservation, the
  composition freeze, outline re-extraction on reconfigure, and the 2 MiB
  document staying full.
- Node script tests live beside the scripts as `*.node-test.mjs` and run via
  `npm run test:node` (`node --test`): perf harness helpers (atomic report/
  fixture writes, provenance, sample validation, cleanup/signal helpers) and
  native orchestrator helpers (Windows path folding, external atomic rewrite,
  marker timing, draft-file resolution, test-data directory validation).
- Rust integration tests live in `src-tauri/tests/` and cover document I/O,
  commands, workspace operations, asset scopes, recovery, open events,
  clipboard images, document renaming, and the translation pipeline (cache
  and OpenAI-compatible client). The `native-e2e` feature adds unit tests for
  its environment-only config, identifier validation, and atomic
  marker/report writes.
- E2E tests in `tests/e2e/` (`notepad`, `editorWidth`, `translation`, `tableClipboard`, and `workspaceSearch` specs)
  run against a real Vite dev server on port 1421
  with `VITE_E2E=1` (`reuseExistingServer` is off so the environment is
  guaranteed); they exercise the UI through DOM/CodeMirror interactions using
  the in-memory port (see `src/app/e2e.ts` and `playwright.config.ts`). The
  `workspaceSearch` spec also covers the single-column welcome page at startup
  and after closing `欢迎.md`, the five-item recent limit and 更多… disclosure,
  recent-file activation, the 36 px activity rail while the explorer is
  collapsed, and the 1280/1080/680 px layouts without horizontal overflow.
  This suite does
  not exercise the native seam.
- Native E2E (`scripts/native-e2e.mjs` + `src/app/nativeE2e.ts` +
  `src-tauri/src/native_e2e.rs`) drives the real Tauri process and backend for
  `smoke`, `edit-save`, `external-change`, and `recovery`; it verifies on-disk
  BOM/CRLF/bytes and survives a SIGKILL for draft recovery. Marker files
  synchronize phases (no fixed sleeps); diagnostics go to
  `test-results/native-e2e/`. macOS native execution is local only (no CI
  job) and must be recorded per gate run; the latest recorded all-scenario run
  is `run-2026-11-20T22-38-07-511Z` (all four passed). Linux CI is configured
  to run the suite under Xvfb (pending a recorded CI result); Windows has not
  executed it (unverified).
- `npm run perf` builds the production perf entry (`vite.perf.config.ts` →
  `dist-perf/`), serves it on strict port 1422, and enforces performance
  budgets (see `docs/performance.md`) writing `tests/perf/report.json`; the
  report and `tests/perf/startup-samples.json` are committed baselines,
  refreshed only from a complete successful run. The pressure fixture runs
  under the light-mode core grammar. `--browser dev` writes the gitignored `tests/perf/report.dev.json` and never
  touches startup samples. Ignored perf artifacts: `tests/perf/generated/`,
  `tests/perf/report.dev.json`, `tests/perf/*.tmp`, and `dist-perf/`.

Manual macOS acceptance checklist:

- Native behavior (Finder open/drag, file/folder dialogs, Chinese IME,
  CRLF/BOM preservation, close protection, image paste/drop, external changes,
  crash recovery, session restore, appearance, reduced motion, and large-file
  performance) is verified manually per `docs/testing.md`.

CI:

- `.github/workflows/ci.yml` runs on `macos-latest` with two jobs: `check`
  (`npm ci`, `npm test`, `npm run test:node`, `npm run build`,
  `npm run perf:build`, Rust fmt/clippy/tests with and without the
  `native-e2e` feature) and `e2e` (`npm run test:e2e` on Chromium, uploading
  `test-results/` traces on failure), plus `check-linux` on `ubuntu-latest`
  (frontend build and Rust fmt/clippy/tests against the Linux toolchain with
  the WebKitGTK dev packages installed — needed because the macOS job never
  compiles the `cfg(target_os = "linux")` branches), `check-windows` on
  `windows-latest` (frontend tests/node tests/build and Rust fmt/clippy/tests
  against the Windows toolchain), and a `native-e2e` job on `ubuntu-latest`
  configured to run `xvfb-run --auto-servernum npm run test:native -- --build
  --scenario all`, uploading `test-results/native-e2e/` on failure; no Linux
  pass is claimed until CI records one. macOS native execution is local and
  Windows native execution is not established.

## Security considerations

- **No App Sandbox in v1**: `src-tauri/entitlements.plist` is deliberately
  empty and must not contain `com.apple.security.app-sandbox`. The release
  verification script (`scripts/verify-macos-bundle.sh`) rejects the build if
  it is present.
- **Webview CSP**: `tauri.conf.json` pins a strict CSP
  (`default-src 'self'`; images additionally allow `asset: http: https:
  data:`; styles allow `'unsafe-inline'`; fonts allow `data:`); the asset
  protocol is enabled with an empty static scope—scopes are granted only at
  runtime.
- **Release signing**: macOS releases ship unsigned (ad-hoc) by default —
  the project does not carry a paid Apple Developer Program membership, so
  the release notes carry a first-launch Gatekeeper-bypass install note.
  If Developer ID credentials are ever configured (`APPLE_*` secrets), the
  same pipeline signs with the Hardened Runtime, notarizes, and staples.
  Releases never enable the App Sandbox. See `docs/releasing.md`.
- **Update key**: the updater signing key (`~/.tauri/opus-updater.key`, a
  password-less minisign key) must never be committed; losing it permanently
  breaks the automatic update channel because clients verify every
  `latest.json` against the public key pinned in `tauri.conf.json`. See
  `docs/releasing.md`.
- **Never commit**: credentials, `.env` files, signing certificates, build
  outputs, or personal documents.
- **Atomic saves**: document writes use a sibling temporary file, `fsync`, and
  an atomic rename to avoid data loss.
- **Translation cache and API keys**: translated segments are cached under the
  app data directory (`translation-cache/`, one sha256-named JSON file per
  segment, written with the same atomic discipline as recovery drafts).
  Provider API keys are held by the OS credential store (Keychain / Windows
  Credential Manager / Secret Service), one entry per provider slot; the
  frontend never reads a key back — it can only write one
  (`storeTranslationKey`), delete one (`deleteTranslationKey`) and ask whether
  one exists (`hasTranslationKey`), and requests name the slot instead of
  carrying the secret. `translation_key_protection` reports "system" or, when
  no credential store is available, "file" for the weakly-protected local
  fallback, which the settings dialog surfaces to the user. A session written
  by an older version still holds plaintext keys; the port migrates them into
  the credential store on load and keeps the plaintext copy until every key is
  stored, so an upgrade can never lose a key (see `src/document/`).
- **Asset scopes**: runtime Tauri scopes are additive-only; the Rust
  `AssetScopeRegistry` is the authoritative record of which consumer holds
  which directory. Workspace mutations enforce root-boundary checks against
  canonical paths.
- **Path validation**: backend commands require absolute paths and Markdown
  extensions; symlinked paths are canonicalized.
- **Recovery drafts**: dirty snapshots are stored as JSON in the app data
  directory using the same atomic-write discipline; draft IDs carry a
  per-launch namespace so a fresh session cannot overwrite a previous
  session's leftover, and legacy IDs are migrated before discard. Drafts are
  discarded once the document is safely saved or closed.
- **Native E2E isolation**: the test commands exist only under the
  `native-e2e` Cargo feature, take their scenario/output paths from the
  process environment (never from the webview), reject the production
  identifier, and stamp reports server-side. The dedicated
  `.native-e2e` identifier keeps session/recovery data out of a user
  installation on macOS/Linux (isolated `HOME`/XDG) and on Windows (the
  identifier is the boundary; Rust ignores `APPDATA` overrides). Cleanup
  removes test data only after validating the directory name, and Windows
  native runs must not run concurrently.
- **Close handling**: the window close event is held until recovery drafts are
  flushed; closing proceeds even if flush fails so the user is never trapped.

## Release and deployment

Release procedures are documented in `docs/releasing.md`. High-level steps:

1. From a clean checkout on the release machine, run the release candidate
   gate:

   ```sh
   npm ci
   npm run check
   cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
   cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
   cargo clippy --manifest-path src-tauri/Cargo.toml --features native-e2e -- -D warnings
   npm run perf:build
   npm run test:e2e
   npm run test:native -- --build --scenario smoke
   npm run tauri build -- --bundles app,dmg
   ./scripts/verify-macos-bundle.sh "src-tauri/target/release/bundle/macos/Opus.app"
   npm run perf
   ```

   The app and DMG are built and verified before `npm run perf` so the
   packaged-app report and bundle provenance refer to the release artifact.
   `npm run check` includes the script (`node --test`) and `native-e2e`
   Rust unit gates; the gate adds fmt and both clippy feature sets.
   `npm run perf` refreshes `tests/perf/report.json` only from a complete
   successful production-bundle run. Do not hand-edit the report or its
   baseline numbers. The committed browser numbers are Chromium
   production-frontend results, not WKWebView or the M1 signed baseline; the
   current hot-start reason is `not_instrumented` and its cause is unconfirmed.
   Platform-specific checks that cannot run (native scenarios on Windows,
   packaged-app metrics without a bundle) are reported as unverified, never as
   passing.

2. Signed releases only: sign, notarize, staple, and verify the `.app` and
   `.dmg`. The default unsigned release skips this step.
3. Publish the DMG to GitHub Releases.

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which runs five
jobs. `prepare-release` creates the tag's release once, as a draft, and
generates its release notes. The three platform jobs `need` it and build into
that draft in parallel: macOS runs `npm run check` and builds the `app,dmg`
bundles, Linux builds the `appimage` bundle with `NO_STRIP=1`, and Windows
builds the `nsis` installer — each uploading via `tauri-action` with
`releaseDraft: true`, so the action reuses the existing draft instead of
racing to create the release. `publish-release` runs only after all three
succeeded and publishes it (`gh release edit --draft=false`), so the updater
never sees a half-uploaded release. Because `createUpdaterArtifacts` is
enabled, the release also carries the updater artifacts (`latest.json`,
`Opus_aarch64.app.tar.gz`, `.sig`); the app checks
`https://github.com/XwX5050/Opus/releases/latest/download/latest.json`
silently on startup and from a manual check in the settings dialog
(`src/app/updates.ts`). The workflow requires only the minisign private key
from the `TAURI_SIGNING_PRIVATE_KEY` secret. The `APPLE_*` secrets
(Developer ID `.p12` certificate plus notarization credentials) are
optional: with all five configured the macOS job signs and notarizes
(Tauri infers the signing identity from the certificate); with none it
publishes an unsigned build and appends the unsigned-build install note to
the release notes; a partially configured set fails the job before it
builds.

## Useful references

- `README.md` — quick start and project status.
- `docs/testing.md` — full automated and manual testing instructions.
- `docs/releasing.md` — signing, notarization, updater channel, release gate.
- `docs/performance.md` — performance budgets and measurement protocol.
- `docs/superpowers/` — design specs and implementation plans.
- `vite.config.ts` — Vite and Vitest configuration.
- `vite.perf.config.ts` — production perf build/preview (mode `perf`, port 1422).
- `playwright.config.ts` — E2E server and test settings.
- `scripts/native-e2e.mjs` — native scenario orchestrator.
- `src-tauri/tauri.conf.json` — Tauri window, security, updater, and bundle
  config.
- `src-tauri/tauri.native-e2e.conf.json` — isolated native-test build.
